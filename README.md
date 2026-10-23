<!--
pi-ssh-remote English documentation covering design for Pi Agent, core capabilities, usage scenarios, commands, and security mechanisms.
-->

# pi-ssh-remote

**Operate remote SSH servers with Pi as easily as local projects.**

[中文文档](README.zh-CN.md) · [GitHub Repository](https://github.com/Hakim-Fan/pi-ssh-remote)

`pi-ssh-remote` is a dedicated SSH remote development extension for the Pi Coding Agent.

It doesn't just open a remote terminal. Once connected, Pi's native tools (`read`, `write`, `edit`, `bash`) automatically route to the remote server. Your Agent can view files, analyze logs, modify code, and run tasks directly on the server without having to repeatedly prefix commands with SSH or pull code down locally.

For instance, you can simply say to Pi:

```text
Connect to ssh root@gpu-box -p 2202 and enter /srv/training.
Check why the last training run failed, fix the problem, restart it in the background,
and send me the PID and log path.
```

Pi will connect to the server, switch directories, inspect logs, edit files, and launch tasks using familiar tools, all executed directly on the remote server.

---

## Acknowledgements & Refactoring Notes

This project is a deep refactoring and evolution based on the pioneering work of **Yutong Bian**'s [petrichor20211/pi-ssh-remote](https://github.com/petrichor20211/pi-ssh-remote).

The original project established the excellent transparent remote tool routing paradigm for Pi. Building upon that foundation, this fork enhance the underlying execution pipeline and concurrency model:

1. **PTY Session Lifecycle Binding**:
   - Upgraded command channels to PTY-backed sessions. When a user cancels a command, when execution times out, or if the connection drops unexpectedly, the remote operating system kernel automatically broadcasts `SIGHUP` to clean up all spawned child processes, preventing orphaned tasks from draining server resources.
2. **Pure Native SFTP & Cross-Platform Compatibility**:
   - File operations rely entirely on the native SFTP protocol without hardcoded dependencies on specific remote system binaries (such as GNU `timeout`, `file`, or specific `sed` syntax). Works out-of-the-box on Linux, macOS, Alpine Linux, lightweight Docker containers, and embedded environments.
3. **Stateless Execution & Concurrency Safety**:
   - Eliminated mutable global working directory state. Each tool call runs as an independent, isolated subshell over a multiplexed SSH connection, guaranteeing directory and state isolation across parallel tool calls and sub-agent workflows.
4. **Lean & Decoupled Architecture**:
   - Removed extraneous abstraction layers to focus on rock-solid connection multiplexing, secure terminal execution, and pure file transfer, keeping the codebase concise, resilient, and easy to maintain.

Special thanks and tribute to the original author for inspiring this work!

---

## Why It's Built for Agents

### No Need to Wrap Every Step in SSH

Typical approaches force the Agent to continuously run:

```bash
ssh user@host "cd /path && ..."
```

As commands multiply, directories, quoting, environment variables, and connection states frequently break. With this extension, connect once, and subsequent file and shell operations execute remotely automatically.

### The Agent Knows Which Server It's Operating On

The active remote directory and server details are injected into Pi's system context and displayed in the footer status bar:

```text
H100 Training Box (root@gpu-box.example.com:2202):/srv/project
```

Both you and the Agent can confirm at a glance whether operations are targeting local or remote workspaces, preventing accidental mistakes.

### Automatic Reconnection

If an SSH connection drops during a session, the extension automatically attempts reconnection. Workspace state tracks Pi sessions across `/new`, `/fork`, `/clone`, and `/resume`.

### Safer Context Usage

Remote commands feature local timeout guards to prevent runaway processes from hanging the Agent. Command output is bounded with tail previews to protect the LLM context window.

### Run Remotely, Develop Locally

Port forwarding maps remote services to `localhost`, allowing local development tools and web browsers to seamlessly interact with remote backend services.

---

## Comparison: Direct SSH vs. pi-ssh-remote

| Direct SSH Execution                               | With `pi-ssh-remote`                                      |
| -------------------------------------------------- | --------------------------------------------------------- |
| Must prefix every command with SSH                 | Connect once; tools route remotely automatically          |
| Working directory lost between calls               | Remembers remote CWD with stateless concurrency safety    |
| Agent must infer which machine it is on            | Server and CWD explicitly displayed in context and status |
| Broken connections require manual recovery         | Automatic seamless reconnection within session            |
| Aborted commands leave orphan processes behind     | PTY lifecycle ensures automatic process cleanup on cancel |
| File editing and shell commands handled separately | Unified management via `/remote` and standard Agent tools |
| Excessive output easily floods context window      | Built-in timeout, tail truncation, and budget limits      |

---

## Installation

```bash
pi install npm:@hakifan/pi-ssh-remote
```

- **Local Requirements**: Node.js 20+
- **Remote Requirements**: Standard SSH server with SFTP enabled

---

## Quick Start

### 1. Connect to Server

```text
/remote ssh root@gpu-box.example.com -p 2202
```

### 2. Set Remote Directory

```text
/remote chdir /srv/project
```

### 3. Check Status

```text
/remote status
```

### 4. Disconnect

```text
/remote disconnect
```

---

## Authentication Methods

### Automatic Key & Agent Discovery

When connecting, the extension automatically tries credentials in this order:

1. Running local SSH Agent;
2. Default local private keys (`~/.ssh/id_ed25519`, `~/.ssh/id_ecdsa`, `~/.ssh/id_rsa`);
3. If none are available, prompts securely in-memory for a password or key passphrase (never saved to disk).

### Specifying Private Keys

Specify an identity key using `-i`:

```text
/remote ssh -i ~/.ssh/custom_key root@gpu-box.example.com
```

### ProxyJump (Jump Hosts)

Jump across intermediate bastion hosts directly with `-J`:

```text
/remote ssh -J jumpuser@gateway.example.com:22 targetuser@internal.example.com
```

Or standard OpenSSH syntax:

```text
/remote ssh -o ProxyJump=jumpuser@gateway.example.com targetuser@internal.example.com
```

---

## Port Forwarding

### Map Remote Services to Localhost

If a service or web app is running remotely (e.g. port `8080`), forward it locally:

```text
/remote forward 8080:127.0.0.1:8080
```

Access `http://localhost:8080` directly in your local browser.

### Stop Forwarding

```text
/remote unforward 8080
```

---

## Command Reference

| Command                                           | Description                                               |
| ------------------------------------------------- | --------------------------------------------------------- |
| `/remote ssh <user@host> [-p port]`               | Connect to remote SSH host and activate remote workspace  |
| `/remote ssh -i <key> <user@host>`                | Connect using a specified private key file                |
| `/remote ssh -J <jump> <user@host>`               | Connect through a bastion jump host                       |
| `/remote chdir <path>`                            | Update and synchronize default remote working directory   |
| `/remote status`                                  | View current connection state, host, and remote directory |
| `/remote forward <local:remote_host:remote_port>` | Forward a remote port to a local TCP port                 |
| `/remote unforward <local_port>`                  | Close an active local port forwarding rule                |
| `/remote disconnect`                              | Disconnect from SSH and return tools to local environment |

---

## License

This project is licensed under the [MIT License](LICENSE).
