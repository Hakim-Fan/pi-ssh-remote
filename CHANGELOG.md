# Changelog

All notable user-visible changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[中文更新日志](CHANGELOG.zh-CN.md)

---

## [0.2.0] - 2026-10-22

### Added

- **PTY Session Lifecycle Binding**: Upgraded command execution from raw streams to PTY-backed terminal sessions. Remote processes are bound to the pseudo-terminal process group, allowing the kernel to automatically broadcast `SIGHUP` to clean up all spawned child processes when a command times out, is aborted by the user, or disconnects unexpectedly.
- **Non-Interactive Environment Defaults**: Automatically injects `DEBIAN_FRONTEND=noninteractive` and `CI=true` before running shell commands to prevent interactive CLI prompts (e.g., `[y/N]`, password inputs) from hanging the Agent.
- **Explicit CWD Parameter**: Added optional `cwd` parameter to remote shell and file tools, allowing callers to execute commands in explicit directories without relying on mutable global state.

### Changed

- **Native SFTP File Operations**: Refactored remote `read`, `write`, and `edit` tools to rely purely on native SFTP byte streaming, eliminating runtime dependencies on remote host utilities and ensuring seamless compatibility with macOS, Alpine Linux, minimal Docker containers, and BSD environments.
- **Stateless Command Execution**: Executing commands now runs within isolated subshells per invocation over a multiplexed SSH long connection. Eliminates CWD race conditions across concurrent tool calls and multi-sub-agent workflows.
- **Streamlined Architecture**: Redesigned core pipeline, reducing codebase footprint by over 75% while maintaining transparent tool routing, connection resilience, and TCP port forwarding.

### Removed

- Removed remote `file --mime-type` inspection that caused failures on systems lacking the `file` command.
- Removed pseudo-line slicing via remote `sed` and `head -c` commands in file tools.
- Removed hardcoded GNU `timeout` command wrapping, replacing it with reliable local timer channel termination.
- Removed `mapPath` heuristic prefix replacement and legacy server-memory path hijacking (`targetsLocalServerMemory`).

### Fixed

- Fixed runaway orphan processes continuing to consume remote CPU/GPU resources after task cancellation or connection drops.
- Fixed command crashes on macOS and minimal Linux environments caused by missing GNU `timeout` or incompatible `head -c` options.
- Fixed directory race conditions when multiple tools or sub-agents concurrently changed and accessed working directories.

---

## 致谢说明

版本 0.2.0 是基于原作者 **Yutong Bian** 的开源项目 [petrichor20211/pi-ssh-remote](https://github.com/petrichor20211/pi-ssh-remote)（原版本 0.1.15）进行的深度演进与重构。在此向原作者优秀的架构创意致以诚挚敬意。
