# pi-ssh-remote 设计不足、隐患剖析与改进建议

本文档基于 `pi-ssh-remote`（版本 `0.1.15`）的源码实现，深度剖析其在远程开发 Agent 场景下的 **3 大核心设计问题与架构隐患**，并基于 KISS（Keep It Simple, Stupid）原则提供移植重构方案。

---

## 1. 底层能力缺失：未分配 PTY（伪终端）导致孤儿子进程泄漏与交互挂死（高危隐患）

### 源码现状
在 `index.ts:718` 与 `index.ts:773-805`：
```typescript
// 静态管道执行，未分配 PTY 终端
client.exec(withRemoteTimeout(command, resolvedTimeout), (error, stream) => { ... });

// 源码注释中作者指出了该缺陷：
// Remote processes without a pty are not signalled by closing the channel;
// they stop at their own remote timeout.
function runExecChannel(...) {
  ...
  const abort = () => {
    try { stream.close(); } catch { /* channel may already be gone */ }
    settle(() => reject(abortedError()));
  };
}
```

### 深度剖析（同一根因的双重表现）
插件所有命令均通过无终端的 Raw Stream（原始管道）执行，未向 SSH 请求分配 PTY（伪终端）。这直接导致两个严重缺陷：

1. **孤儿子进程持续泄漏（无生命周期兜底）**：
   * **机制失效**：在非 PTY 模式下，本地调用 `stream.close()`（或本地 CLI 被直接 `kill -9`、断网、关闭终端）时，远程 `sshd` 仅关闭了数据管道。**Linux 内核不会向无终端绑定的非交互子进程发送 `SIGHUP`（挂断）信号**。
   * **严重后果**：子进程脱离控制被 `PID 1`（systemd/init）收养，死循环脚本、高负载训练任务或临时服务**仍在服务器后台狂跑**，造成资源持续泄漏。
2. **无 TTY 交互回路导致进程死锁挂起**：
   * 一旦 Agent 输出了需要交互输入的命令（如 `sudo` 输密码、`git clone` 验证凭据、脚本出现 `[y/N]` 提示），由于缺乏交互终端，远端会无限期阻塞等待 stdin，直至触发 30 秒超时抛错。

### 改造建议（引入 PTY 终端会话）
将底层升级为带 PTY 的执行管道（`client.exec(command, { pty: true })`），全面对齐人类在终端 SSH 远程操作的心智模型：
* **前台命令（临时调试/测试）**：子进程统一捆绑在虚拟终端（如 `/dev/pts/X`）的前台进程组中。一旦用户取消、执行超时或本地 CLI 进程暴毙，远端终端关闭，**Linux 内核自动无差别广播 `SIGHUP` 信号，瞬间连根收割所有子孙进程**。
* **常驻服务（正式发布上线）**：如果 Agent 执行的是发布任务，要求其使用标准的守护进程语法（如 `nohup ... &`、`systemctl`、`pm2` 或 `docker run -d`）。这些工具在内核层面会自动调用 `setsid()` 脱离当前终端控制并屏蔽 `SIGHUP`，在连接断开后依然永久稳定存活。
* **默认注入非交互声明**：
  ```bash
  export DEBIAN_FRONTEND=noninteractive
  export CI=true
  ```

---

## 2. 上层架构过度工程化：越俎代庖的过度包装导致多平台崩溃与严重高耦合

### 核心本质
本问题涵盖了原项目中最典型的过度包装设计（原文档问题 2、3、5）。**其核心败笔在于作者试图在底层替 Agent 拦截并预判一切，硬编码了特定系统的私货，既把代码膨胀到了 1900 多行，又彻底扼杀了 Agent 的自适应智能**。

### 源码现状与三大过度表现

#### 表现 A：底层强加特定 GNU Linux 命令（源码 `index.ts:718, 1349, 1385`）
* **`file --mime-type -b`**：读文件前自作聪明地发命令检查是不是二进制，导致轻量容器（Alpine / 精简 Docker）因缺少 `file` 命令直接报错崩溃，且每次读取都白白浪费一次网络 RTT。
* **`sed + head -c` 切片**：在底层文件工具里硬拼 Shell 命令做所谓的行号截取。在 macOS（BSD）或精简容器下因参数规则不一致直接瘫痪。
* **`timeout 30s` 强加**：篡改 Agent 原始命令硬塞 GNU `timeout`，导致 macOS（默认无此命令）等目标机所有命令执行全灭。

#### 表现 B：自作聪明的 `mapPath` 路径偷换（源码 `index.ts:945-951`）
```typescript
const mapPath = (path: string): string => {
  if (!remote) return path;
  if (path === localCwd) return remote.cwd;
  const prefix = localCwd.endsWith(sep) ? localCwd : localCwd + sep;
  if (path.startsWith(prefix)) return remote.cwd.replace(/\/$/, "") + "/" + relative(localCwd, path).split(sep).join("/");
  return path;
};
```
* **隐患**：试图在底层强行把本地前缀替换成远端路径。由于软链接（Symlink）、大小写敏感差异，前缀匹配极易失效；而访问 `/tmp` 等远端系统目录时由于不带本地前缀被原样放行，造成路径规则不可预测的认知混乱。

#### 表现 C：本地备忘录路径后门劫持与 1900+ 行代码膨胀（源码 `index.ts:1424-1449`）
```typescript
const targetsLocalServerMemory = (path: unknown): boolean => {
  return resolve(path.replace(/^@/, "")) === serverMemoryFilePath(remote);
};

// 在全局文件工具底层开后门：
execute: (params) => {
  if (isRemote && !targetsLocalServerMemory(params.path)) {
    return executeRemoteRead(params.path); // 走远程
  }
  return localRead.execute(params.path);   // 掉头走本地！
}
```
* **隐患**：为了实现一个简单的“服务器备忘录”，在全局文件读写通道里开后门（特定路径掉头改本地）。这种反模式加上终端光标计算、复杂的流累加器，直接将代码推到了 1919 行，全搅在一个大闭包中，完全无法单测和跨平台复用。

### 改造建议（贯彻 KISS 原则，全面减负）
1. **纯净透传，职责归位**：
   * 移除 `sed` 切片与 `file` 命令：`read` 工具回归纯净的 SFTP 读写；大文件/大日志通过 Prompt 引导 Agent 自己用已有的 `bash` 配合 `tail -n 100` / `grep` 查阅，Agent 完全有能力处理。
   * 移除 `timeout` 命令拼接：超时由本地 Node.js `setTimeout` 关闭通道，绝不篡改用户的命令字符串。
   * 移除 `mapPath` 路径偷换：明确告知 `cwd`，Agent 自然输出正确的相对/绝对路径，底层原样透传。
2. **记忆机制独立**：服务器配置直接作为纯文本随 System Prompt 注入，绝不去污染底层文件通道。
3. **架构解耦**：拆除所有黑魔法后，核心代码缩减 80% 以上（从 1900 行降至 200~300 行），形成独立的四层轻量架构（Transport、VFS、Guardrail、Agent Adapter）。

---

## 3. 单全局变量导致多并发 Tool / Sub Agent 调用竞态冲突

### 源码现状
在 `index.ts:52-56` 与 `index.ts:900`：
```typescript
// 模块级全局唯一的单例状态
let remote: RemoteState | null = null;
let routeRemoteTools = false;
```
工作区目录状态直接挂在全局共享实例上：
```typescript
const changeRemoteCwd = async (requested: string, ctx: any): Promise<string> => {
  ...
  remote.cwd = resolved; // 任何地方执行 cd，直接覆写全局变量
  ...
};

const remotePath = (relativePath: string): string => {
  // 所有读写文件的工具，全盲目读取被全局篡改的 remote.cwd
  return posix.join(remote.cwd, relativePath);
};
```

### 深度剖析与灾难场景推演

#### 1. 现代模型多 Tool 并发调用踩踏
现代 LLM（如 Claude 3.5 Sonnet、GPT-4o）普遍支持单轮并发调用多个工具。若模型在同一瞬间发射了两个请求：
* **Tool A**：调用 `remote.chdir("/var/log")`；
* **Tool B**：调用 `read("config.json")`（意在读取原工作区 `/app/config.json`）。

**时序错乱**：Tool A 异步响应更快，先将全局 `remote.cwd` 改为 `/var/log`；紧接着 Tool B 开始解析路径，误拼成了 `/var/log/config.json`，直接引发 `File Not Found` 误报。

#### 2. 多 Sub Agent（子代理）并发执行时的“误删代码灾难”
当主 Agent 派生了多个 Sub Agent 并行干活时：
* **Sub Agent 1**：切换到 `/var/log` 准备清理无用日志；
* **Sub Agent 2**：慢了 10 毫秒并发执行 `cd /app`，全局 `remote.cwd` 瞬间被覆盖为 `/app`；
* **严重后果**：Sub Agent 1 接着执行 `rm -rf *`，原本想清空日志，**这一刀直接斩断了 Sub Agent 2 所在的代码目录 `/app`，造成无法挽回的数据丢失！**

#### 3. 根因澄清：冲突源于本地代码，而非 Linux 或 SSH 协议
在远端 Linux 内核中，每次执行命令都在完全独立的进程内存空间中运行，进程间 `cwd` 互不干扰；SSH 协议规范（RFC 4254）也天然支持在单条 TCP 连接上通过 Channel 多路复用并发执行多个完全隔离的进程。**远端原本是绝对安全的，冲突纯粹是因为本地插件代码错误地使用了一个全局可变单例变量 `remote.cwd`！**

---

### 优化与重构方案：无状态化执行模型（Stateless Execution）

彻底解决该问题的工业级最佳实践是：**“底层复用高速长连接，上层命令完全无状态化”**。

```
                    ┌─────── 共享的底层 SSH TCP 长连接 ───────┐
                    │                                         │
Sub Agent 1 发起 ──►│ 开辟 Channel 0: [在 /var/log 执行 ls]    │ ──► 独立子进程 A，完全隔离
                    │                                         │
Sub Agent 2 发起 ──►│ 开辟 Channel 1: [在 /app 执行 status]   │ ──► 独立子进程 B，完全隔离
                    └─────────────────────────────────────────┘
```

#### 1. 坚决消灭全局变量，工具纯函数化
工具执行时不修改任何外部全局变量，将 `cwd` 作为显式入参（或由调用方 Context 私有持有），每次调用仅作为该次独立子进程的局部状态：

```typescript
interface RemoteExecParams {
  command: string;
  cwd?: string; // 显式参数，由当前 Agent 上下文私有传递
}

// 纯函数化终端工具：每次调用都是远端独立创建的临时进程，执行完立即销毁
async function remoteBash(client: SshClient, params: RemoteExecParams) {
  const targetDir = params.cwd || defaultProjectCwd;
  const fullCommand = `cd -- '${targetDir}' && ${params.command}`;

  // 在现有的 client 长连接上开辟一条独立轻量虚拟通道（Channel）
  return new Promise((resolve, reject) => {
    client.exec(fullCommand, { pty: true }, (err, stream) => {
      if (err) return reject(err);
      const output: Buffer[] = [];
      stream.on("data", (chunk) => output.push(chunk));
      stream.on("close", () => resolve(Buffer.concat(output).toString("utf8")));
    });
  });
}
```

#### 2. 长连接与通道的清晰分工
* **物理网络层（SshClient）**：全局维持 **1 条** TCP 长连接，只在首次进入会话时握手一次（省去后续反复握手的 1~2 秒开销）；
* **业务执行层（Channel / Subshell）**：每次命令调用，相当于通过这根网线在远端新开一个类似独立终端 Tab 的临时子进程。子进程拥有独立的 PID 与 CWD，执行完毕随 Channel 自动释放。

#### 3. 达成的效果
* **零并发踩踏**：千军万马的 Sub Agent 同时执行 `cd` 与读写操作，全部由各自独立的远程子进程隔离，彻底根绝竞态冲突；
* **极速响应**：免除重复连接开销，每次工具调用开销仅需 10~20ms 网络往返。
