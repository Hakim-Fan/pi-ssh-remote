/**
 * Pi SSH Remote extension.
 *
 * Provides persistent, stateless SSH workspaces for Pi by routing shell and file
 * tools over a multiplexed, PTY-enabled SSH connection.
 *
 * Adheres strictly to KISS:
 * 1. PTY-backed exec channel ensures child processes terminate automatically on abort/disconnect (SIGHUP).
 * 2. Pure SFTP operations eliminate fragile GNU toolchain dependencies (sed/timeout/file).
 * 3. Stateless execution per-command prevents CWD race conditions across concurrent tool calls and sub-agents.
 */

import type { Client as SshClient, ClientChannel, SFTPWrapper } from "ssh2";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { createServer, type Server } from "node:net";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  truncateTail,
} from "@earendil-works/pi-coding-agent";

import { quote, shellWords } from "./src/shell.ts";
import { cacheId, parseSshCommand, type ParsedSsh } from "./src/ssh/config.ts";
import { createSshAuthenticator, type SshCredentialCache } from "./src/ssh/auth.ts";
import { jumpSocket, probeFingerprint } from "./src/ssh/connection.ts";

interface RemoteState extends ParsedSsh {
  client: SshClient;
  cwd: string;
  /** 懒初始化的 SFTP 会话，连接存活期间复用 */
  sftpSession: SFTPWrapper | null;
  sftpPending: Promise<SFTPWrapper> | null;
}

interface ForwardSpec {
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

interface RemoteEndpointConfig {
  sshCommand?: string;
  remoteCwd?: string;
  forwards?: string[];
  note?: string;
}

interface RemoteConfig {
  activeEndpoint?: string;
  endpoints?: Record<string, RemoteEndpointConfig>;
  execMaxLines?: number;
  execMaxBytes?: number;
  turnMaxBytes?: number;
}

const AGENT_DIR = getAgentDir();
const KNOWN_HOSTS_FILE = join(AGENT_DIR, "ssh-remote-known-hosts.json");
const REMOTE_CONFIG_FILE = join(AGENT_DIR, "ssh-remote-config.json");
const FALLBACK_REMOTE_CWD = "~";
const DEFAULT_EXEC_MAX_LINES = 200;
const DEFAULT_EXEC_MAX_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const CACHE_KEY = "__piHpcCredentialCacheV1";

const cacheHost = globalThis as typeof globalThis & { [CACHE_KEY]?: SshCredentialCache };
const credentialCache = (cacheHost[CACHE_KEY] ??= {
  passwords: new Map<string, string>(),
  keyPassphrases: new Map<string, string>(),
});

function loadRemoteConfig(): RemoteConfig {
  try {
    if (!existsSync(REMOTE_CONFIG_FILE)) return {};
    return JSON.parse(readFileSync(REMOTE_CONFIG_FILE, "utf8")) as RemoteConfig;
  } catch {
    return {};
  }
}

function saveRemoteConfig(config: RemoteConfig): void {
  try {
    mkdirSync(dirname(REMOTE_CONFIG_FILE), { recursive: true });
    writeFileSync(REMOTE_CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  } catch {}
}

function loadKnownHosts(): Record<string, string> {
  try {
    if (!existsSync(KNOWN_HOSTS_FILE)) return {};
    return JSON.parse(readFileSync(KNOWN_HOSTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveKnownHosts(hosts: Record<string, string>): void {
  try {
    mkdirSync(dirname(KNOWN_HOSTS_FILE), { recursive: true });
    writeFileSync(KNOWN_HOSTS_FILE, JSON.stringify(hosts, null, 2), "utf8");
  } catch {}
}

function parseForwardSpec(value: string): ForwardSpec {
  const match = value.match(/^(\d+):([^:]+):(\d+)$/);
  if (!match) throw new Error(`Invalid port-forward: ${value}; expected LOCAL_PORT:REMOTE_HOST:REMOTE_PORT`);
  return { localPort: Number(match[1]), remoteHost: match[2]!, remotePort: Number(match[3]) };
}

export default function sshRemoteExtension(pi: ExtensionAPI) {
  const auth = createSshAuthenticator(credentialCache);
  const localCwd = process.cwd();

  let remote: RemoteState | null = null;
  let defaultRemoteCwd = FALLBACK_REMOTE_CWD;
  let routeRemoteTools = false;
  let currentCtx: any = null;
  let reconnecting: Promise<void> | null = null;
  let cachedRemoteEditTool: ReturnType<typeof createEditTool> | null = null;
  const forwardServers = new Map<number, Server>();
  const forwardSpecs = new Map<number, ForwardSpec>();

  // --- 基础连接与重连 ---
  const isReconnectable = (error: unknown): boolean => {
    const msg = String((error as Error)?.message ?? error);
    return /closed|not open|timeout|reset|broken pipe|no response/i.test(msg);
  };

  const connectHop = async (
    target: ParsedSsh,
    socket: () => Promise<ClientChannel | undefined>,
    ctx: any,
  ): Promise<SshClient> => {
    const hosts = loadKnownHosts();
    let fingerprint = hosts[target.label];
    if (!fingerprint) {
      fingerprint = await probeFingerprint(target, await socket());
      hosts[target.label] = fingerprint;
      saveKnownHosts(hosts);
    }
    return auth.authenticateHop(
      target,
      fingerprint,
      socket,
      ctx ? (label, placeholder) => ctx.ui.promptSecret(label, placeholder) : undefined,
    );
  };

  const establish = async (config: ParsedSsh, targetCwd: string, ctx: any): Promise<RemoteState> => {
    let client: SshClient;
    if (config.jumps && config.jumps.length > 0) {
      const hops = [...config.jumps, config];
      let currentHopClient: SshClient | null = null;
      for (let i = 0; i < hops.length; i++) {
        const hop = hops[i]!;
        const prevClient = currentHopClient;
        const sockProvider = prevClient ? () => jumpSocket(prevClient, hop) : async () => undefined;
        const nextClient = await connectHop(hop, sockProvider, ctx);
        if (i < hops.length - 1) {
          currentHopClient = nextClient;
        } else {
          client = nextClient;
        }
      }
    } else {
      client = await connectHop(config, async () => undefined, ctx);
    }

    // 获取真实的远程 CWD 绝对路径 (无状态探测)
    let resolvedCwd = "/";
    try {
      const probeCmd = (!targetCwd || targetCwd === "~")
        ? `cd && pwd -P`
        : `cd -- ${quote(targetCwd)} && pwd -P`;
      const res = await execRemoteDirect(client!, probeCmd, 5);
      resolvedCwd = res.trim() || "/";
    } catch {
      resolvedCwd = "/";
    }

    return { ...config, client: client!, cwd: resolvedCwd, sftpSession: null, sftpPending: null };
  };

  const withReconnect = async <T>(operation: (client: SshClient) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!remote) throw new Error("SSH remote is not connected");
    if (signal?.aborted) throw new Error("aborted");
    try {
      return await operation(remote.client);
    } catch (error) {
      if (signal?.aborted || !isReconnectable(error)) throw error;
      // 去重：并发断线只触发一次重连，后续调用等待同一个 Promise
      if (!reconnecting) {
        const staleRemote = remote;
        reconnecting = establish(staleRemote, staleRemote.cwd, currentCtx)
          .then((freshState) => {
            if (staleRemote.sftpSession) {
              try { staleRemote.sftpSession.end(); } catch {}
            }
            staleRemote.client.destroy();
            remote = freshState;
          })
          .finally(() => { reconnecting = null; });
      }
      await reconnecting;
      return await operation(remote.client);
    }
  };

  // --- PTY 执行通道与自毁保证 (彻底根治问题 1 与问题 3) ---
  const execRemoteInPty = (
    client: SshClient,
    command: string,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    signal?: AbortSignal,
  ): Promise<string> => {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));

      // 用 exec 包裹确保无 shell prompt 残留；env 在命令前注入
      const preppedCommand = `export DEBIAN_FRONTEND=noninteractive CI=true TERM=dumb; exec /bin/sh -c ${quote(command)}`;

      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      // 开启 PTY 终端会话！echo: false 抑制终端回显，rows/cols 设置合理尺寸避免自动换行
      client.exec(preppedCommand, { pty: { echo: false, rows: 200, cols: 512, term: "dumb" } }, (err, stream) => {
        if (err) return reject(err);

        const chunks: Buffer[] = [];
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };

        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          try { stream.close(); } catch {}
          reject(new Error("Remote command aborted by user"));
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          try { stream.close(); } catch {} // 关掉 PTY 终端，远端触发 SIGHUP 杀掉子进程
          reject(new Error(`Remote command timed out after ${timeoutSeconds}s`));
        }, timeoutSeconds * 1000);

        stream.on("data", (chunk: Buffer) => chunks.push(chunk));

        stream.on("close", () => {
          if (settled) return;
          settled = true;
          cleanup();
          // 清洗 PTY 控制字符：\r\n → \n、孤立 \r → \n、剥离 ANSI 转义序列与 OSC 序列
          const raw = Buffer.concat(chunks)
            .toString("utf8")
            .replace(/\r\n?/g, "\n")
            .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
            .replace(/\x1b\][^\x07]*\x07/g, "");
          resolve(raw);
        });

        stream.on("error", (streamErr: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(streamErr);
        });
      });
    });
  };

  const execRemoteDirect = (client: SshClient, command: string, timeoutSec = 10): Promise<string> => {
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);
        const out: Buffer[] = [];
        const timer = setTimeout(() => {
          stream.close();
          reject(new Error("timeout"));
        }, timeoutSec * 1000);
        stream.on("data", (d) => out.push(d));
        stream.on("close", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(out).toString("utf8"));
        });
      });
    });
  };

  // --- 原生 SFTP 访问 (彻底剥离 sed/file/head 依赖) ---
  const withSftp = async <T>(client: SshClient, operation: (sftp: SFTPWrapper) => Promise<T>): Promise<T> => {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, wrapper) => (err ? reject(err) : resolve(wrapper)));
    });
    try {
      return await operation(sftp);
    } finally {
      sftp.end();
    }
  };

  /** 获取可复用的 SFTP 会话（懒初始化，断线后自动失效触发重连） */
  const getSftp = (state: RemoteState): Promise<SFTPWrapper> => {
    if (state.sftpSession) return Promise.resolve(state.sftpSession);
    if (state.sftpPending) return state.sftpPending;
    state.sftpPending = new Promise<SFTPWrapper>((resolve, reject) => {
      state.client.sftp((err, sftp) => {
        state.sftpPending = null;
        if (err) return reject(err);
        sftp.on("close", () => { state.sftpSession = null; });
        state.sftpSession = sftp;
        resolve(sftp);
      });
    });
    return state.sftpPending;
  };

  const resolvePath = (baseCwd: string, p: string): string => {
    if (!p || p === "." || p.trim() === "") return baseCwd;
    if (p.startsWith("/")) return posix.normalize(p);
    if (p === "~" || p.startsWith("~/")) {
      const home = defaultRemoteCwd.startsWith("/") ? defaultRemoteCwd : "/";
      return posix.normalize(p === "~" ? home : posix.join(home, p.slice(2)));
    }
    const base = baseCwd.startsWith("/") ? baseCwd : "/";
    return posix.normalize(posix.join(base, p));
  };

  // --- 端口转发管理 ---
  const startForward = (spec: ForwardSpec): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!remote) return reject(new Error("SSH remote is not connected"));
      const server = createServer((sock) => {
        remote!.client.forwardOut("127.0.0.1", sock.remotePort ?? 0, spec.remoteHost, spec.remotePort, (err, stream) => {
          if (err) return sock.destroy();
          sock.pipe(stream).pipe(sock);
        });
      });
      server.listen(spec.localPort, "127.0.0.1", () => {
        forwardServers.set(spec.localPort, server);
        forwardSpecs.set(spec.localPort, spec);
        resolve();
      });
      server.on("error", (err) => reject(err));
    });
  };

  const stopForwards = async () => {
    for (const server of forwardServers.values()) server.close();
    forwardServers.clear();
    forwardSpecs.clear();
  };

  // --- 状态栏更新 ---
  const updateStatus = (ctx: any) => {
    if (!ctx?.ui) return;
    if (remote && routeRemoteTools) {
      ctx.ui.setStatus("ssh-remote", ctx.ui.theme.fg("success", `SSH: ${remote.label}:${defaultRemoteCwd}`));
    } else {
      ctx.ui.setStatus("ssh-remote", ctx.ui.theme.fg("muted", "SSH: local"));
    }
  };

  // --- 工具注册 (纯函数无状态化代理) ---
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  let localBash = createBashTool(localCwd);

  // 1. 读文件 (纯 SFTP 字节读取，支持无状态 targetCwd 解析)
  pi.registerTool({
    ...localRead,
    description: `Read file contents. With SSH remote active, operates directly on remote workspace via native SFTP.`,
    execute: async (id, params, signal, update) => {
      if (!remote || !routeRemoteTools) return localRead.execute(id, params, signal, update);

      // 快照当前 CWD，防止并发 chdir 在 await 期间改变 defaultRemoteCwd
      const snapshotCwd = defaultRemoteCwd;
      const targetPath = resolvePath(snapshotCwd, String(params.path || ""));
      const content = await withReconnect(async () => {
        const sftp = await getSftp(remote!);
        return new Promise<Buffer>((resolve, reject) => {
          sftp.readFile(targetPath, (err, data) => (err ? reject(err) : resolve(data)));
        });
      }, signal);

      return {
        content: [{ type: "text", text: content.toString("utf8") }],
        details: { path: targetPath, remote: true },
      };
    },
  });

  // 2. 写文件 (纯 SFTP 写入)
  pi.registerTool({
    ...localWrite,
    description: `Write file contents. With SSH remote active, operates directly on remote workspace via native SFTP.`,
    execute: async (id, params, signal, update) => {
      if (!remote || !routeRemoteTools) return localWrite.execute(id, params, signal, update);

      // 快照当前 CWD，防止并发 chdir 在 await 期间改变 defaultRemoteCwd
      const snapshotCwd = defaultRemoteCwd;
      const targetPath = resolvePath(snapshotCwd, String(params.path || ""));
      const fileData = Buffer.from(String(params.content || ""), "utf8");

      await withReconnect(async (client) => {
        // 先确保远端目录存在
        await execRemoteDirect(client, `mkdir -p -- ${quote(posix.dirname(targetPath))}`);
        const sftp = await getSftp(remote!);
        await new Promise<void>((resolve, reject) => {
          sftp.writeFile(targetPath, fileData, (err) => (err ? reject(err) : resolve()));
        });
      }, signal);

      return {
        content: [{ type: "text", text: `Wrote ${fileData.length} bytes to ${targetPath}` }],
        details: { path: targetPath, remote: true },
      };
    },
  });

  // 3. 编辑文件 (基于纯 SFTP 的原生 editOps)
  pi.registerTool({
    ...localEdit,
    description: `${localEdit.description} With SSH remote active, operates directly on remote workspace.`,
    execute: async (id, params, signal, update) => {
      if (!remote || !routeRemoteTools) return localEdit.execute(id, params, signal, update);

      if (!cachedRemoteEditTool) {
        const remoteEditOps = {
          readFile: (p: string) =>
            withReconnect(async () => {
              const sftp = await getSftp(remote!);
              return new Promise<Buffer>((resolve, reject) => {
                sftp.readFile(resolvePath(defaultRemoteCwd, p), (err, data) => (err ? reject(err) : resolve(data)));
              });
            }, signal),
          access: (p: string) =>
            withReconnect(async () => {
              const sftp = await getSftp(remote!);
              return new Promise<void>((resolve, reject) => {
                sftp.stat(resolvePath(defaultRemoteCwd, p), (err) => (err ? reject(err) : resolve()));
              });
            }, signal),
          writeFile: (p: string, content: string) =>
            withReconnect(async () => {
              const sftp = await getSftp(remote!);
              return new Promise<void>((resolve, reject) => {
                sftp.writeFile(resolvePath(defaultRemoteCwd, p), content, (err) => (err ? reject(err) : resolve()));
              });
            }, signal),
        };

        cachedRemoteEditTool = createEditTool(localCwd, { operations: remoteEditOps as any });
      }

      return cachedRemoteEditTool.execute(id, params, signal, update);
    },
  });

  // 4. Shell 执行 (启用 PTY 终端保护、无状态 CWD、本地超时熔断、防爆截断)
  pi.registerTool({
    ...localBash,
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute." }),
      cwd: Type.Optional(Type.String({ description: "Optional directory to run in (prevents race conditions)." })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds." })),
    }),
    description: `Execute a shell command. With SSH remote active, runs in a PTY session directly on the remote host.`,
    execute: async (id, params, signal, update) => {
      if (!remote || !routeRemoteTools) return localBash.execute(id, params, signal, update);

      const targetCwd = resolvePath(defaultRemoteCwd, params.cwd || defaultRemoteCwd);
      const timeoutSec = params.timeout ?? DEFAULT_TIMEOUT_SECONDS;
      // 纯函数化：每次命令独立包裹 cd，绝不修改任何外部全局变量
      const isolatedCmd = `cd -- ${quote(targetCwd)} && ${params.command}`;

      let output = await withReconnect((client) => execRemoteInPty(client, isolatedCmd, timeoutSec, signal), signal);

      // 上下文防爆截断 (保留尾部关键日志)
      const config = loadRemoteConfig();
      const limits = {
        maxLines: config.execMaxLines ?? DEFAULT_EXEC_MAX_LINES,
        maxBytes: config.execMaxBytes ?? DEFAULT_EXEC_MAX_BYTES,
      };
      const truncated = truncateTail(output, limits);

      return {
        content: [{ type: "text", text: truncated.content || "Command completed with no output." }],
        details: { remote: true, cwd: targetCwd, truncated: truncated.truncated },
      };
    },
  });

  // 5. 交互管理工具: remote
  pi.registerTool({
    name: "remote",
    label: "Remote",
    description: "Manage persistent SSH remote workspace, port forwarding, and connection status.",
    parameters: Type.Object({
      action: StringEnum(["connect", "disconnect", "status", "chdir", "forward", "unforward"] as const),
      command: Type.Optional(Type.String({ description: "SSH command, e.g. ssh root@myhost -p 22" })),
      cwd: Type.Optional(Type.String({ description: "Target remote working directory" })),
      forwards: Type.Optional(Type.String({ description: "Port forwarding LOCAL:REMOTE_HOST:REMOTE_PORT" })),
    }),
    execute: async (id, params, signal, update) => {
      const { action } = params;

      if (action === "connect") {
        if (!params.command) throw new Error("SSH command is required for connect, e.g. ssh user@host");
        const parsed = parseSshCommand(params.command);
        const targetCwd = params.cwd || FALLBACK_REMOTE_CWD;
        const state = await establish(parsed, targetCwd, currentCtx);
        if (remote) {
          if (remote.sftpSession) { try { remote.sftpSession.end(); } catch {} }
          remote.client.destroy();
        }
        remote = state;
        cachedRemoteEditTool = null;
        defaultRemoteCwd = state.cwd;
        routeRemoteTools = true;
        updateStatus(currentCtx);
        return {
          content: [{ type: "text", text: `Connected to ${remote.label} in ${defaultRemoteCwd}` }],
          details: { host: remote.label, cwd: defaultRemoteCwd },
        };
      }

      if (action === "disconnect") {
        if (remote) {
          if (remote.sftpSession) { try { remote.sftpSession.end(); } catch {} }
          remote.client.destroy();
        }
        remote = null;
        routeRemoteTools = false;
        cachedRemoteEditTool = null;
        await stopForwards();
        updateStatus(currentCtx);
        return {
          content: [{ type: "text", text: "SSH remote disconnected. Tools reverted to local." }],
          details: {},
        };
      }

      if (action === "chdir") {
        if (!remote) throw new Error("Not connected to SSH remote");
        if (!params.cwd) throw new Error("cwd is required for chdir");
        const resolved = await withReconnect((client) =>
          execRemoteDirect(client, `cd -- ${quote(params.cwd!)} && pwd -P`),
        );
        defaultRemoteCwd = resolved.trim();
        remote.cwd = defaultRemoteCwd;
        updateStatus(currentCtx);
        return {
          content: [{ type: "text", text: `Remote working directory updated to ${defaultRemoteCwd}` }],
          details: { cwd: defaultRemoteCwd },
        };
      }

      if (action === "forward") {
        if (!params.forwards) throw new Error("forwards spec required, e.g. 8080:127.0.0.1:8080");
        const spec = parseForwardSpec(params.forwards);
        await startForward(spec);
        return {
          content: [{ type: "text", text: `Forwarding local port ${spec.localPort} -> ${spec.remoteHost}:${spec.remotePort}` }],
          details: { forward: spec },
        };
      }

      if (action === "unforward") {
        const port = Number(params.forwards);
        const server = forwardServers.get(port);
        if (server) {
          server.close();
          forwardServers.delete(port);
          forwardSpecs.delete(port);
        }
        return {
          content: [{ type: "text", text: `Stopped forwarding port ${port}` }],
          details: { port },
        };
      }

      // action === "status"
      return {
        content: [
          {
            type: "text",
            text: `SSH Remote: ${remote ? "Connected" : "Disconnected"}\nHost: ${remote?.label ?? "none"}\nCWD: ${defaultRemoteCwd}\nRouting: ${routeRemoteTools ? "Remote" : "Local"}`,
          },
        ],
        details: {
          connected: !!remote,
          host: remote?.label ?? null,
          cwd: defaultRemoteCwd,
          routing: routeRemoteTools,
        },
      };
    },
  });

  // --- Pi 生命周期事件与上下文注入 ---
  pi.on("session_start", async (event, ctx) => {
    currentCtx = ctx;
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (remote) {
      if (remote.sftpSession) { try { remote.sftpSession.end(); } catch {} }
      remote.client.destroy();
    }
    remote = null;
    routeRemoteTools = false;
    cachedRemoteEditTool = null;
    await stopForwards();
  });

  // 将真实环境无缝注入给 Agent，让大模型自适应操作系统与命令
  pi.on("before_agent_start", (event) => {
    if (remote && routeRemoteTools) {
      event.systemPromptOptions.cwd = defaultRemoteCwd;
      event.systemPromptOptions.sections.ssh_remote = [
        `[Active Remote SSH Workspace]`,
        `- Host: ${remote.label}`,
        `- Remote CWD: ${defaultRemoteCwd}`,
        `- Instructions: All bash and file tools operate directly on the remote host. For inspecting large log files, prefer 'tail -n' or 'grep' via bash over wholesale reads.`,
      ].join("\n");
    }
  });

  // 注册 /remote 顶层命令
  pi.registerCommand("remote", {
    description: "Manage remote SSH workspace",
    handler: async (args: string, ctx: any) => {
      const parts = shellWords(args || "");
      if (parts[0] === "disconnect") {
        if (remote) {
          if (remote.sftpSession) { try { remote.sftpSession.end(); } catch {} }
          remote.client.destroy();
        }
        remote = null;
        routeRemoteTools = false;
        cachedRemoteEditTool = null;
        await stopForwards();
        updateStatus(ctx);
        ctx.ui.notify("SSH remote disconnected", "info");
        return;
      }
      if (parts[0] === "ssh" || parts[0]?.startsWith("ssh ")) {
        const cmd = parts.join(" ");
        const parsed = parseSshCommand(cmd);
        const state = await establish(parsed, FALLBACK_REMOTE_CWD, ctx);
        if (remote) {
          if (remote.sftpSession) { try { remote.sftpSession.end(); } catch {} }
          remote.client.destroy();
        }
        remote = state;
        cachedRemoteEditTool = null;
        defaultRemoteCwd = state.cwd;
        routeRemoteTools = true;
        updateStatus(ctx);
        ctx.ui.notify(`SSH remote connected: ${remote.label}`, "info");
        return;
      }
      ctx.ui.notify(`Usage: /remote ssh user@host or /remote disconnect`, "warning");
    },
  });
}
