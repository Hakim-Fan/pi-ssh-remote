<!--
pi-ssh-remote 中文说明文档，介绍它面向 Pi Agent 的设计、主要能力、使用场景、命令和安全机制。
-->

# pi-ssh-remote

**让 Pi 像操作本地项目一样操作远程服务器。**

[English Docs](README.md) · [GitHub 仓库](https://github.com/haki/pi-ssh-remote)

`pi-ssh-remote` 是一个专门面向 Pi Agent 的 SSH 远程开发插件。

它不只是帮你打开一个远程终端。连接服务器后，Pi 原有的 `read`、`write`、`edit`、`bash` 等工具会自动切换到远端。Agent 不需要反复拼接 SSH 命令，也不需要先把代码下载到本地再修改，可以直接在服务器上查看文件、分析日志、修改代码和运行任务。

例如，你可以直接对 Pi 说：

```text
连接 ssh root@gpu-box -p 2202，进入 /srv/training。
检查最近一次训练为什么失败，修复问题后在后台重新启动，
最后把 PID 和日志路径发给我。
```

Pi 会依次完成连接服务器、切换目录、读取日志、修改文件和启动任务。整个过程中，它使用的仍然是熟悉的 Pi 工具，只是执行位置变成了远程服务器。

---

## 致谢与重构说明

本项目基于原作者 **Yutong Bian** 开拓性的开源项目 [petrichor20211/pi-ssh-remote](https://github.com/petrichor20211/pi-ssh-remote) 深度重构演进而来。

原项目奠定了 Pi 远程工具动态透明代理的优秀设计范式。在此基础上，本项目对底层执行管道与并发隔离模型进行了进一步优化与增强：

1. **引入 PTY（伪终端）会话生命周期绑定**：
   - 将命令通道升级为具备 PTY 的会话通道。当用户在交互中主动取消任务、遇到执行超时或本地网络异常断开时，远端操作系统内核会自动广播 `SIGHUP` 挂断信号，连根清理所有衍生子进程，彻底杜绝孤儿进程占用服务器 CPU/GPU 资源。
2. **纯原生 SFTP 传输与跨系统自适应**：
   - 文件读写全面回归原生 SFTP 协议实现，不再硬编码依赖目标系统的外部命令（如特定的 `sed` 语法或 `file` 命令）。即使连接到 macOS、Alpine Linux、精简版 Docker 容器或嵌入式设备，也能开箱即用。
3. **无状态化（Stateless）并发执行隔离**：
   - 消除全局工作目录的竞态影响。每次工具调用均作为独立的远端子进程运行，在复用单条 SSH TCP 长连接的同时，保障单轮多 Tool 并发调用与多 Sub Agent 场景下的目录与状态完全隔离。
4. **架构极简减负**：
   - 剥离冗余的中间包装，聚焦于稳定的网络长连接、安全的终端管道与纯粹的文件传输，使整体代码更紧凑、更易维护与二次开发。

再次向原作者致以诚挚的感谢与敬意！

---

## 为什么它更适合 Agent

### 不需要给每一步都套一层 SSH

普通做法通常是让 Agent 不断执行：

```bash
ssh user@host "cd /path && ..."
```

命令一多，目录、引号、环境变量和连接状态都很容易出错。使用本插件后，只需要连接一次，后续文件读写和 Shell 操作都会自动在远端执行。

### Agent 知道自己正在操作哪台服务器

插件会把当前远程目录和服务器信息写入 Pi 的系统上下文，并显示在底部状态栏：

```text
H100 训练机 (root@gpu-box.example.com:2202):/srv/project
```

这样无论是用户还是 Agent，都能随时确认当前操作发生在本地还是远端，减少误操作。

### 断线后自动恢复

当前会话中如果 SSH 连接意外断开，插件会尝试自动重连，不需要 Agent 从头建立工作环境。SSH 工作区状态也会跟随 Pi session：`/new` 继承当前工作区，`/fork` 和 `/clone` 保留来源工作区，`/resume` 恢复历史 session 记录的服务器和远程目录。

### 对 Agent 上下文更友好

远程命令内置超时保护，避免某个前台任务长期挂起 Agent；命令输出通过有界缓冲处理；同一轮远端工具共享输出预算，避免并行调用迅速占满上下文。

### 可以远端跑服务、本地改代码

端口转发模式下，可以把远端服务映射到 `localhost`，同时让 Pi 的文件和 Shell 工具继续操作本地项目。

这很适合下面这类场景：

- GPU 服务器运行模型，本地开发 Web UI；
- 远端启动 API，本地调试客户端；
- 远端运行训练监控，本地查看页面；
- 内网服务通过 SSH 隧道提供给本地工具使用。

---

## 和直接使用 SSH 有什么区别

| 直接执行 SSH                         | 使用 `pi-ssh-remote`                       |
| ------------------------------------ | ------------------------------------------ |
| 每条命令都要重新拼接 SSH             | 连接一次后，Pi 工具自动在远端执行          |
| 多次调用之间容易丢失目录             | 自动记住远程工作目录，并支持无状态安全并发 |
| Agent 需要自己判断当前在哪台机器     | 系统上下文和底部状态栏会清晰显示当前服务器 |
| 连接中断后需要手动恢复               | 当前会话内自动无感重连                     |
| 取消命令后远端进程可能变成孤儿遗留   | 内置 PTY 生命周期绑定，中断自动清理子进程  |
| 文件修改、命令执行和端口转发各自处理 | 统一通过 `/remote` 和 Agent 工具管理       |
| 大量输出可能直接占满模型上下文       | 内置超时、尾部预览与输出上限保护           |

---

## 安装

```bash
pi install npm:@haki/pi-ssh-remote
```

- **本地要求**：Node.js 20+。
- **远程服务器要求**：开启标准 SSH 服务并支持 SFTP。

---

## 快速开始

### 1. 连接服务器

在终端或对话框中直接使用 `/remote` 命令连接：

```text
/remote ssh root@gpu-box.example.com -p 2202
```

连接成功后，Pi 的文件和 Shell 工具都会默认操作远程服务器。

### 2. 设置远程工作目录

```text
/remote chdir /srv/project
```

### 3. 查看当前状态

```text
/remote status
```

### 4. 返回本地环境

需要断开远程连接、回到本地开发时执行：

```text
/remote disconnect
```

---

## 认证与连接方式

### 密码与密钥自动发现

插件连接时会自动尝试当前系统环境下的有效凭证：

1. 本地正在运行的 SSH Agent；
2. 本地默认的私钥文件（`~/.ssh/id_ed25519`、`~/.ssh/id_ecdsa`、`~/.ssh/id_rsa`）；
3. 若均不可用，将安全弹窗提示输入密码或密钥 Passphrase，凭证仅保留在内存中，绝不落盘。

### 指定私钥文件登录

通过 `-i` 参数明确指定特定私钥文件：

```text
/remote ssh -i ~/.ssh/custom_key root@gpu-box.example.com
```

如果私钥设置了密码短语（Passphrase），插件会在首次使用时提示输入，并临时缓存于内存中供本次会话重连复用。

### 跳板机（ProxyJump）连接

针对处于内网隔离区的目标主机，支持通过 `-J` 参数指定跳板机直接穿越：

```text
/remote ssh -J jumpuser@gateway.example.com:22 targetuser@internal.example.com
```

同时也支持标准 OpenSSH 的写法：

```text
/remote ssh -o ProxyJump=jumpuser@gateway.example.com targetuser@internal.example.com
```

---

## 端口转发

### 将远端服务映射到本地

如果你在远端运行了 Web 页面或 API 服务（例如远端 `8080` 端口），可以通过端口转发直接映射到本地 `localhost`：

```text
/remote forward 8080:127.0.0.1:8080
```

转发成功后，在本地浏览器直接访问 `http://localhost:8080` 即可查看远端页面。

### 取消端口转发

```text
/remote unforward 8080
```

---

## `/remote` 命令速查表

| 命令                                              | 描述                                     |
| ------------------------------------------------- | ---------------------------------------- |
| `/remote ssh <user@host> [-p port]`               | 连接到目标 SSH 服务器并切换为远程工作区  |
| `/remote ssh -i <key> <user@host>`                | 使用指定私钥文件连接目标服务器           |
| `/remote ssh -J <jump> <user@host>`               | 通过跳板机连接内网目标服务器             |
| `/remote chdir <path>`                            | 修改并同步当前远程默认工作目录           |
| `/remote status`                                  | 查看当前连接状态、主机地址与远程工作目录 |
| `/remote forward <local:remote_host:remote_port>` | 建立本地端口到远端端口的 TCP 隧道转发    |
| `/remote unforward <local_port>`                  | 关闭指定的本地端口转发                   |
| `/remote disconnect`                              | 断开远程 SSH 连接，将工具切换回本地环境  |

---

## 许可证

本项目遵循 [MIT License](LICENSE)。
