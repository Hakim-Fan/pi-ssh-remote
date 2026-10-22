# pi-ssh-remote v0.2.0 Code Review

## 一、LIMITATIONS_AND_RISKS.md 文档评审

### 问题覆盖度判定

文档识别了 **3 大核心问题**，均为真实高危隐患，判断准确：

| #   | 问题                                              | 严重度  | 判定                          |
| --- | ------------------------------------------------- | ------- | ----------------------------- |
| 1   | 无 PTY → 孤儿进程泄漏 + 交互死锁                  | 🔴 高危 | ✅ 准确，内核机制分析到位     |
| 2   | 过度工程化（sed/file/timeout/mapPath/备忘录后门） | 🟡 中高 | ✅ 准确，三个子表现归纳清晰   |
| 3   | 全局变量 CWD 竞态                                 | 🔴 高危 | ✅ 准确，灾难场景推演有说服力 |

### 文档本身的改进建议

> [!TIP]
> 文档整体质量很高，以下是锦上添花的改进点：

1. **行号引用已过时** — 文档引用的是原版 0.1.15 的行号（如 `index.ts:718`、`index.ts:1349`），但当前 index.ts 已经是重构后的 611 行版本，如果将来读者对照代码会困惑。建议在文档顶部明确标注 "**以下行号引用均基于原版 0.1.15 源码**"。

2. **问题 3 的灾难场景推演（误删代码目录）过于极端** — `rm -rf *` 场景虽然逻辑成立，但正常 Agent 系统应有安全沙箱或破坏性命令拦截。可以补充一个更常见但同样危险的场景，如"并发写文件写到错误目录导致数据污染"。

3. **缺少一个值得补充的问题** — 详见下文第二节"遗漏问题"。

---

## 二、文档可能遗漏的问题

经全量代码审查，文档已涵盖了最核心的架构问题。但还有 **2 个中等级别的问题** 值得补充：

### 遗漏 A：SFTP 连接未复用，每次文件操作重新握手

在 [index.ts L300-308](file:///Users/fanhuaze/Downloads/pi-ssh-remote-main/index.ts#L300-L308)：

```typescript
const withSftp = async <T>(
  client: SshClient,
  operation: (sftp: SFTPWrapper) => Promise<T>,
): Promise<T> => {
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((err, wrapper) => (err ? reject(err) : resolve(wrapper)));
  });
  try {
    return await operation(sftp);
  } finally {
    sftp.end(); // ← 每次操作结束都关闭 SFTP 子系统
  }
};
```

**问题**：每次 `read` / `write` / `edit` 操作都重新打开并关闭 SFTP 子系统。对于批量编辑场景（Agent 连续编辑 10+ 个文件），每次都有一次 SFTP subsystem 请求的开销。虽然不致命，但在高延迟链路（跨洋跳板机）下会显著拖慢操作。

**建议**：可以做一个懒初始化的 SFTP 单例，挂在 `RemoteState` 上，只在连接断开时销毁。

### 遗漏 B：`edit` 工具在远程模式下每次调用都 `createEditTool` 创建新实例

在 [index.ts L438](file:///Users/fanhuaze/Downloads/pi-ssh-remote-main/index.ts#L438)：

```typescript
return createEditTool(localCwd, { operations: remoteEditOps as any }).execute(
  id,
  params,
  signal,
  update,
);
```

每次 `edit` 调用都会 `createEditTool(...)` 创建一个新的工具实例再调用 `.execute()`。这意味着每次编辑都有一次工厂函数的完整初始化开销。虽然可能不大，但设计上不够优雅。

---

## 三、重构代码 Code Review

### 整体评价

> [!IMPORTANT]
> 重构质量**整体优秀**。从 1900+ 行压缩到 611 行，架构清晰度提升数个量级。核心 3 个问题的修复均到位且实现正确。

以下按严重度排序列出具体问题：

---

### 🔴 P0：PTY 回显污染输出——`execRemoteInPty` 返回的 output 包含命令本身

[index.ts L227](file:///Users/fanhuaze/Downloads/pi-ssh-remote-main/index.ts#L227)：

```typescript
const preppedCommand = `export DEBIAN_FRONTEND=noninteractive CI=true TERM=xterm-256color\n${command}\n`;
```

PTY 模式下终端会**回显 (echo) 输入的命令本身**。`preppedCommand` 包含 `export ...` 和用户命令，这些内容会出现在 `stream.on("data")` 的输出中。Agent 拿到的 output 会混入：

1. `export DEBIAN_FRONTEND=noninteractive ...` 这行回显
2. 用户命令本身的回显
3. Shell 的 prompt 字符串（如 `root@host:~#`）

**影响**：Agent 解析输出时可能被 prompt 和命令回显干扰，导致误判。

**建议修复**：

```typescript
// 方案 A：关闭 PTY 回显
client.exec(preppedCommand, { pty: { echo: false } }, ...);

// 方案 B：使用包裹脚本抑制回显
const wrappedCommand = `exec /bin/sh -c ${quote(`export DEBIAN_FRONTEND=noninteractive CI=true; ${command}`)}`;
client.exec(wrappedCommand, { pty: true }, ...);
```

---

### 🟡 P1：`chdir` action 仍然修改全局状态 `defaultRemoteCwd`

文档和 CHANGELOG 都声称已实现"无状态化"，但 [index.ts L509-518](file:///Users/fanhuaze/Downloads/pi-ssh-remote-main/index.ts#L509-L518)：

```typescript
if (action === "chdir") {
  ...
  defaultRemoteCwd = resolved.trim();  // ← 仍在修改模块级全局变量
  remote.cwd = defaultRemoteCwd;       // ← 同上
  ...
}
```

**问题**：虽然 `bash` 工具的 `cwd` 参数实现了单次调用的隔离，但 `chdir` 仍然会修改 `defaultRemoteCwd`——这个变量在**所有** `read`/`write`/`edit` 的 `resolvePath` 中作为 fallback 基准路径使用。如果两个 Sub Agent 并发执行 `chdir` + `read`，仍然存在竞态。

**性质判定**：文档描述的问题 3 **并未被完全根治**。`bash` 工具因为支持显式 `cwd` 入参所以可以绕过，但文件工具（read/write/edit）仍然隐式依赖 `defaultRemoteCwd` 全局变量。

**建议修复**：

```typescript
// read/write/edit 也应支持显式 cwd 参数
parameters: Type.Object({
  path: Type.String({ ... }),
  cwd: Type.Optional(Type.String({ description: "Base directory for relative paths" })),
}),
execute: async (id, params, signal, update) => {
  const baseCwd = params.cwd || defaultRemoteCwd;
  const targetPath = resolvePath(baseCwd, String(params.path || ""));
  ...
}
```

---

### 🟡 P2：`withReconnect` 重连后旧 `client` 引用泄漏

[index.ts L201-214](file:///Users/fanhuaze/Downloads/pi-ssh-remote-main/index.ts#L201-L214)：

```typescript
const withReconnect = async <T>(operation: (client: SshClient) => Promise<T>, signal?: AbortSignal): Promise<T> => {
  ...
  try {
    return await operation(remote.client);
  } catch (error) {
    ...
    const reconnected = await establish(remote, remote.cwd, currentCtx);
    remote.client.destroy();  // ← 销毁旧 client
    remote = reconnected;     // ← 替换全局 remote
    return await operation(remote.client);  // ← 用新 client 重试
  }
};
```

**问题**：

1. **并发重连风暴**：如果两个并发 Tool 同时触发断线，两者都会进入 `catch` 分支，各自尝试 `establish()`，导致两次重连。后一个的 `remote.client.destroy()` 会摧毁前一个刚建好的连接。
2. **`remote.client.destroy()` 之后 `remote = reconnected`**：在这两行之间如果有另一个并发操作正在使用 `remote.client`，会拿到已被 destroy 的对象。

**建议**：用一个 `reconnectPromise` 做去重（dedup），确保同一时刻只有一次重连：

```typescript
let reconnecting: Promise<void> | null = null;

const withReconnect = async <T>(
  op: (client: SshClient) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (!remote) throw new Error("SSH remote is not connected");
  try {
    return await op(remote.client);
  } catch (error) {
    if (signal?.aborted || !isReconnectable(error)) throw error;
    if (!reconnecting) {
      reconnecting = establish(remote, remote.cwd, currentCtx)
        .then((r) => {
          remote!.client.destroy();
          remote = r;
        })
        .finally(() => {
          reconnecting = null;
        });
    }
    await reconnecting;
    return await op(remote!.client);
  }
};
```

---

### 🟡 P3：`turnOutputBytes` 只累加不使用

[index.ts L139](file:///Users/fanhuaze/Downloads/pi-ssh-remote-main/index.ts#L139) 声明、[L464](file:///Users/fanhuaze/Downloads/pi-ssh-remote-main/index.ts#L464) 累加、[L553](file:///Users/fanhuaze/Downloads/pi-ssh-remote-main/index.ts#L553) 在 `turn_start` 重置：

```typescript
let turnOutputBytes = 0; // L139
turnOutputBytes += Buffer.byteLength(truncated.content, "utf8"); // L464
pi.on("turn_start", () => {
  turnOutputBytes = 0;
}); // L553
```

但 `turnOutputBytes` 在整个代码中**从未被读取做判断**。原版可能用于 turn 级别的总输出限流（`DEFAULT_TURN_MAX_BYTES = 64 * 1024` 定义了但从未使用），重构时保留了累加逻辑却丢失了限流逻辑。

**建议**：要么补上限流检查，要么直接删除这个死代码和 `DEFAULT_TURN_MAX_BYTES` 常量。

---

### 🟢 P4（小问题）：`execMaxLines` / `execMaxBytes` 配置读取了但未使用

[index.ts L58-59](file:///Users/fanhuaze/Downloads/pi-ssh-remote-main/index.ts#L58-L59) 定义了 `RemoteConfig` 中的 `execMaxLines` / `execMaxBytes` 字段，也定义了对应的 `DEFAULT_EXEC_MAX_LINES` / `DEFAULT_EXEC_MAX_BYTES` 常量，但 bash 工具中直接硬编码使用了默认常量，从未读取 `loadRemoteConfig()` 里用户可能配置的值。

---

### 🟢 P5（小问题）：`\r\n` → `\n` 清洗不充分

[index.ts L267](file:///Users/fanhuaze/Downloads/pi-ssh-remote-main/index.ts#L267)：

```typescript
const raw = Buffer.concat(chunks).toString("utf8").replace(/\r\n/g, "\n");
```

PTY 模式还可能产生单独的 `\r`（光标回到行首），以及 ANSI 转义序列（颜色码等）。只替换 `\r\n` 不够。

**建议**：

```typescript
const raw = Buffer.concat(chunks)
  .toString("utf8")
  .replace(/\r\n?/g, "\n") // \r\n 和单独的 \r 都清理
  .replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); // 去掉 ANSI 转义序列
```

---

### 🟢 P6（小问题）：`quote()` 函数对空字符串的处理

[shell.ts L19-21](file:///Users/fanhuaze/Downloads/pi-ssh-remote-main/src/shell.ts#L19-L21)：

```typescript
export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
```

对空字符串 `quote("")` 会返回 `''`，这在 Shell 中是合法的空字符串参数，功能正确。但 `cd -- ''` 在某些 Shell 下行为不一致（bash 下 `cd -- ''` 等同于 `cd ~`），可能不是预期行为。建议在 `resolvePath` 层面就拦截空路径。

---

## 四、总结评分

| 维度                 | 评分   | 说明                                                                                             |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| **问题识别完整度**   | 9/10   | 3 大核心问题全覆盖，遗漏了 SFTP 未复用和 edit 工厂实例化两个中等问题                             |
| **技术分析深度**     | 9.5/10 | 内核 SIGHUP 机制、SSH RFC 4254 Channel 复用等分析准确到位                                        |
| **改造方案合理性**   | 8.5/10 | PTY + SFTP + 无状态化方向完全正确，但无状态化**未彻底贯彻**（文件工具仍依赖 `defaultRemoteCwd`） |
| **代码实现质量**     | 8/10   | 架构清晰、代码精炼，但 PTY 回显污染、重连竞态、dead code 需要处理                                |
| **文档与代码一致性** | 8/10   | CHANGELOG 和文档声称"无状态化"，但 `chdir` + 文件工具的全局状态残留与此矛盾                      |

> [!IMPORTANT]
> **最高优先修复项**：
>
> 1. PTY 回显关闭（P0）— 直接影响 Agent 输出解析准确性
> 2. 文件工具支持显式 `cwd`（P1）— 不修复则"无状态化"承诺不成立
> 3. 重连去重（P2）— 高并发场景下连接风暴

以下是我的一次测试：

帮我看下这个服务器状态怎么样，cpu占用和存储空间都是否健康

The user wants to check the server status - CPU usage and storage space. I'll run some standard Linux commands to check system
health.

$ top -bn1 | head -20 (timeout 10s)

bash: line 1: cd: /Users/fanhuaze/Downloads/pi-ssh-remote-main/~/~: No such file or directory

Took 0.2s

The cwd seems to be messed up. Let me try with a simpler approach - just run the command without specifying cwd, or use the root
directory.

$ top -bn1 | head -20 (timeout 10s)

bash: line 1: cd: /Users/fanhuaze/Downloads/pi-ssh-remote-main/~/~: No such file or directory

Took 0.2s

There seems to be an issue with the working directory. Let me try to change directory first or use an absolute path.

remote action="status"
SSH Remote: Connected
Host: root@119.45.138.22:22
CWD: ~
Routing: Remote

The status shows connected and CWD is ~. Let me try running the command with explicit cwd set to /root or just try again.

$ top -bn1 | head -20 (timeout 10s)

... (15 earlier lines, ctrl+o to expand)
9 root 20 0 0 0 0 S 0.0 0.0 16:10.91 ksoftir+
10 root 20 0 0 0 0 I 0.0 0.0 533:46.59 rcu_sch+
11 root rt 0 0 0 0 S 0.0 0.0 5:01.73 migrati+
13 root 20 0 0 0 0 S 0.0 0.0 0:00.00 cpuhp/0
14 root 20 0 0 0 0 S 0.0 0.0 0:00.00 cpuhp/1

Took 0.3s

Now let me check disk space as well.

$ df -h (timeout 10s)

... (2 earlier lines, ctrl+o to expand)
tmpfs 3.8G 164K 3.8G 1% /dev/shm
tmpfs 3.8G 266M 3.5G 7% /run
tmpfs 3.8G 0 3.8G 0% /sys/fs/cgroup
/dev/vda1 50G 32G 16G 68% /
tmpfs 770M 0 770M 0% /run/user/0

Took 0.2s

Let me also check more memory details and maybe get a better view of CPU usage over time.

$ free -h (timeout 10s)

total used free shared buff/cache available
Mem: 7.5Gi 4.5Gi 157Mi 267Mi 2.9Gi 2.5Gi
Swap: 0B 0B 0B

Took 0.2s

Now I have enough info to provide a comprehensive status report. Let me summarize.

服务器状态汇总：

🖥️ CPU 状况 —— 健康

- 负载均值：0.08, 0.14, 0.12（1/5/15分钟）— 极低，远低于核心数
- CPU 使用率：4.8% user + 4.8% system = 9.6% 总占用，90.5% 空闲
- 核心进程：oneav（杀毒）和 barad_agent（监控/安全）各占 ~6% CPU，属于正常后台服务
- 运行时间：1062 天（近 3 年未重启），系统稳定

💾 内存状况 —— 可用充足但无 Swap 需关注

┌────────┬─────────┬──────────────────────────────────────┐
│ 项目 │ 数值 │ 评价 │
├────────┼─────────┼──────────────────────────────────────┤
│ 总内存 │ 7.5 GiB │ — │
├────────┼─────────┼──────────────────────────────────────┤
│ 已用 │ 4.5 GiB │ 含缓存 │
├────────┼─────────┼──────────────────────────────────────┤
│ 可用 │ 2.5 GiB │ ✅ 充足 │
├────────┼─────────┼──────────────────────────────────────┤
│ 空闲 │ 157 MiB │ 低，但大部分在 buff/cache 可随时回收 │
├────────┼─────────┼──────────────────────────────────────┤
│ Swap │ 0 B │ ⚠️ 未配置 │
└────────┴─────────┴──────────────────────────────────────┘

│ 建议：建议添加 2–4 GB Swap 文件，防止极端情况下 OOM Killer 误杀进程。

🗄️ 磁盘状况 —— 健康

- 根分区（/dev/vda1）：50 GB 总量，32 GB 已用 (68%)，16 GB 剩余
- 使用率 68% 属安全区间（< 80%），尚有充足空间
- inode 未单独查，但通常随空间足够

✅ 总体评分

┌──────┬─────────┬─────────────────────────┐
│ 维度 │ 评分 │ 备注 │
├──────┼─────────┼─────────────────────────┤
│ CPU │ 🟢 优秀 │ 闲置资源充足 │
├──────┼─────────┼─────────────────────────┤
│ 内存 │ 🟡 良好 │ 可用 2.5 GiB，但无 Swap │
├──────┼─────────┼─────────────────────────┤
│ 磁盘 │ 🟢 优秀 │ 16 GB 剩余，使用率 68% │
├──────┼─────────┼─────────────────────────┤
│ 综合 │ 🟢 健康 │ 生产可用，建议加 Swap │
└──────┴─────────┴─────────────────────────┘

需要我帮你创建 Swap 文件或进一步排查什么吗？
