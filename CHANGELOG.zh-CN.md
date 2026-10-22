# 更新日志 (Changelog)

本项目所有重要的面向用户的变更均记录在此文件中。

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，并严格遵循 [语义化版本 (Semantic Versioning)](https://semver.org/lang/zh-CN/) 规范。

[English Changelog](CHANGELOG.md)

---

## [0.2.0] - 2026-10-22

### 新增 (Added)

- **PTY 伪终端会话生命周期绑定**：将远程命令执行通道升级为带 PTY 伪终端的会话模式。所有远程子进程均归属控制终端进程组管理；当任务被用户取消、执行超时或连接意外断开时，远端操作系统内核自动广播 `SIGHUP` 信号，连根收割所有子孙进程，杜绝孤儿进程占用服务器 CPU/GPU。
- **默认注入非交互环境**：在远程 Shell 执行前自动注入 `DEBIAN_FRONTEND=noninteractive` 与 `CI=true`，防止交互式命令行提示（如 `[y/N]` 确认、密码输入提示）导致 Agent 永久挂起死锁。
- **显式 CWD 参数支持**：`bash` 及文件工具入参支持显式传入可选的 `cwd` 参数，调用方可在指定工作目录下执行操作，彻底脱离对全局可变状态的依赖。

### 变更 (Changed)

- **纯原生 SFTP 传输**：将 `read`、`write` 和 `edit` 工具全面重构为纯原生 SFTP 字节流读写，彻底摆脱对远程主机特定命令（如 GNU `timeout`、`file` 或特定 `sed` 语法）的硬编码依赖，全面兼容 Linux、macOS、Alpine Linux、精简版 Docker 容器与 BSD 环境。
- **无状态化（Stateless）并发执行**：每次命令调用均作为独立运行的临时子进程执行，底层通过单一 SSH TCP 长连接进行多路复用（Multiplexing）。彻底消除了单轮多 Tool 并发调用与多 Sub Agent 场景下的目录时序踩踏问题。
- **轻量化架构重构**：精简重写核心代码，体积缩减 75% 以上，聚焦于高可用的长连接多路复用与纯粹的文件、Shell 传输。

### 移除 (Removed)

- 移除远程 `file --mime-type` 探测命令（该命令在缺少 `file` 工具的轻量镜像中会引发崩溃）。
- 移除基于远程 `sed` 和 `head -c` 的伪行号切片逻辑（大日志查阅完全交由 Agent 通过 `bash` 配合 `tail/grep` 自主处理）。
- 移除在远程命令前硬塞 GNU `timeout` 的篡改逻辑，超时改由本地定时器（Timer）安全关闭通道。
- 移除 `mapPath` 路径前缀偷换逻辑及本地备忘录路径劫持后门（`targetsLocalServerMemory`）。

### 修复 (Fixed)

- 修复任务取消或网络中断后，远端孤儿子进程持续失控运行、耗尽服务器资源的严重缺陷。
- 修复在 macOS 及精简版 Linux 作为远端机时，因缺少 GNU `timeout` 或 `head -c` 语法不兼容引发的执行崩溃。
- 修复并发调用 `chdir` 与文件工具时工作目录互相覆盖的竞态冲突。

---

## 致谢说明

版本 0.2.0 是基于原作者 **Yutong Bian** 开拓性的开源项目 [petrichor20211/pi-ssh-remote](https://github.com/petrichor20211/pi-ssh-remote)（原版本 0.1.15）进行的深度演进与重构。在此向原作者优秀的架构范式致以诚挚敬意。
