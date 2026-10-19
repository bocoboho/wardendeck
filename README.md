<div align="center">

# <img src="docs/images/logo.svg" alt="" height="52" valign="middle" /> WardenDeck

### Your computer, one chat message away.

WardenDeck is a **self-hosted control plane** that connects Feishu/Lark to the coding agents running on your own machine. Send a message from your phone, watch the work happen live, approve risky tool calls, and keep a tamper-evident record of everything the agent did — without exposing your machine to the internet.

[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Status: prototype](https://img.shields.io/badge/status-prototype-orange.svg)](#current-limitations)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-black)](#requirements)

[Quick start](#quick-start) · [Design doc](DESIGN.md) · [Security](#security-model) · [Issues](https://github.com/bocoboho/wardendeck/issues)

</div>

<p align="center">
  <img src="docs/images/architecture.svg" alt="Feishu/Lark messages flow through WardenDeck to Claude Code on your machine, with approvals, audit and isolation" width="860" />
</p>

---

## Why WardenDeck?

WardenDeck lets you:

- **📱 Work from anywhere.** Your phone is the terminal. Send a task from Feishu, watch the live execution card, approve what matters, and read the result — all without remote desktop, SSH, or another app.

- **🛡️ Approve before it acts.** Every tool call can pause for your approval: allow once, allow for 30 minutes, or deny. Approvals are bound to the person who started the task, not just to whoever clicks first.

- **🧾 Prove what happened.** Inbound messages, approval requests and decisions, agent runs, outbound messages, and attachments all go into an append-only audit log protected by a SHA-256 hash chain. Tampering is detectable, not just discouraged.

- **🔒 Keep the agent in a box.** On macOS the Claude Code process and every tool it spawns run under `sandbox-exec`. They cannot read WardenDeck's credentials or execute other bridge tools — enforced by the kernel, not by a prompt.

- **🧠 Give every bot a memory.** Long-term memory is owned by the bot, not by an agent's home directory. Four scopes (assistant / project / chat / user) merge from broad to specific, with per-scope token budgets and relevance ranking.

- **🏠 Own the whole stack.** Data lives in a local SQLite file, credentials are encrypted with your installation's `master.key`, the server listens on `127.0.0.1` by default, and the web console can be turned off entirely.

---

## Quick start

### Requirements

- **Node.js >= 22.13** — uses the built-in `node:sqlite` and `fetch`
- **macOS or Linux** — kernel-level sandboxing is currently macOS-only
- **Claude Code installed and logged in** — `claude` must be on your `PATH`
- **A Feishu/Lark custom app** — created automatically by the QR flow, or bring your own

```bash
node -v          # must be v22.13 or newer
claude --version
```

### 1. Install

```bash
git clone https://github.com/bocoboho/wardendeck.git
cd wardendeck

npm install
npm run build
npm link
```

`npm link` puts `wardendeck` on your `PATH`. Verify the installation:

```bash
wardendeck version
wardendeck agents        # should list claudecode
```

<details>
<summary>Prefer not to install globally?</summary>

Every command works with the local binary:

```bash
node dist/cli.js <command> ...
```

</details>

### 2. Initialize and create a project

```bash
wardendeck init --admin-email you@example.com
```

This creates `~/.wardendeck` (`0700`), a `master.key`, the SQLite database (`0600`), the owner account, and a **one-time setup token** for the web console. Store the token; it is printed only once.

> [!IMPORTANT]
> Back up `~/.wardendeck/master.key` together with the database. It is the only key that can decrypt your saved platform credentials.

Create a project pointing at a real working directory:

```bash
mkdir -p ~/code/demo
wardendeck project create --name demo --workdir ~/code/demo
```

The local agent is detected automatically. To be explicit:

```bash
wardendeck project create --name demo --workdir ~/code/demo --agent claudecode
```

```bash
wardendeck status
```

### 3. Connect Feishu / Lark

Create the app with the QR flow:

```bash
wardendeck feishu setup --project demo
```

Open the printed link on your phone and approve. WardenDeck creates the app, stores `app_id`, `app_secret`, and `owner_open_id` (encrypted), and — if the project exists — **automatically binds your private chat** to it.

<details>
<summary>Use an existing Feishu app instead</summary>

1. Create a **custom app** in the [Feishu Open Platform](https://open.feishu.cn/app) (use `open.larksuite.com` for Lark).
2. Copy the App ID and App Secret from **Credentials & Basic Info**.
3. Enable the **Bot** capability and request `im:message`, `im:message:send_as_bot`, and `im:chat:readonly`.
4. Publish a version.
5. Save the credential:

```bash
wardendeck secret set feishu_demo --value "cli_xxx
app_secret_xxx"
```

The first line is the App ID, the second is the App Secret. Add a third line `lark` for the international version.

Verify it:

```bash
wardendeck platform test --platform feishu --credential feishu_demo
# OK: app=cli_xxx bot=your-bot domain=feishu
```

</details>

> [!NOTE]
> In the Feishu console, set **Event subscription** to **long connection** and subscribe to `im.message.receive_v1`. Add the `card.action.trigger` callback if you want approval buttons; without it, replying `1 / 2 / 3` still works.

### 4. Bind a chat

The QR flow already binds your private chat. For a group, add the bot to the group first, then ask WardenDeck for the chat ID:

```bash
wardendeck feishu chats --credential feishu_demo
# oc_xxx	group	My Group
```

Bind it:

```bash
wardendeck platform bind --project demo --platform feishu \
  --credential feishu_demo \
  --channel oc_xxx
```

`--allowed-users` defaults to the app owner's `open_id`. Pass an explicit list to allow teammates:

```bash
--allowed-users ou_aaa,ou_bbb
```

> [!TIP]
> Running `serve` picks up new bindings and rotated credentials within five seconds. No restart needed.

### 5. Send your first message

```bash
wardendeck serve
```

Open Feishu and message the bot:

> 你好，看一下这个目录里有什么

You should see an execution card under your message. It updates in place with tool progress (`🔧 Bash`, `📖 Read`), pauses for approval when needed, and turns green when the run finishes.

- Reply `1` to allow once, `2` to allow for 30 minutes, `3` to deny.
- Send `/stop` to cancel the current task.
- In a group, the bot only responds when **@-mentioned**.

> [!NOTE]
> A laptop that sleeps is offline. Keep the machine awake with `caffeinate -is wardendeck serve`, or run WardenDeck on an always-on host.

### 6. Open the web console (optional)

```bash
open http://127.0.0.1:8787
```

Sign in with the setup token printed by `init`. The console manages projects, bots, members, platform bindings, memory, and the audit log. It is only a client of the API: `wardendeck serve --no-web` disables the UI and leaves the API and CLI untouched.

---

## How it works

1. Feishu delivers `im.message.receive_v1` over a long connection.
2. WardenDeck matches the `chat_id` / `open_id` against a binding, checks `allowed_users` and the @-mention rule, and writes `message.inbound` to the audit log.
3. The message is queued per chat and written to a persistent Claude Code process running with `--output-format stream-json --input-format stream-json` in the project's `workdir`.
4. When Claude Code asks for a tool permission (`control_request`), WardenDeck sends an approval card and waits. The idle timer is paused while a human decides.
5. Progress events patch the same message card in place; the final answer completes it and writes `message.outbound` to the audit log.
6. The native session ID is saved per chat and reused with `--resume` on the next message.

---

## Security model

| Layer | What it does |
|---|---|
| **Allowlist** | Bindings require `allowed_users`. When omitted, only the app owner is allowed. Unknown chats get no response at all. |
| **Mentions** | Group chats respond only when this specific bot is @-mentioned. |
| **Approvals** | Tool calls follow the project's permission mode. Only the person who started the task can approve it. |
| **Sandbox** | macOS `sandbox-exec` denies reads and execution under the data directory and `WARDENDECK_DENY_PATHS`. |
| **Secrets** | Platform credentials are encrypted with AES-256-GCM using `master.key`. |
| **Audit** | Append-only events with a SHA-256 hash chain; `wardendeck audit verify` checks integrity. |
| **Network** | Listens on `127.0.0.1` by default. No inbound public port is required. |
| **Files** | Data directory `0700`; database and master key `0600`. |

WardenDeck is a prototype. The database itself is not encrypted; audit and session data rely on filesystem permissions. Do not expose port `8787` to the public internet.

---

## Chat commands

| Command | Effect |
|---|---|
| `1` / `允许` | Allow this tool call |
| `2` / `允许30分钟` | Allow tool calls for 30 minutes |
| `3` / `拒绝` | Deny this tool call |
| `/stop` | Stop the current task and cancel pending approvals |
| `/remember <text>` | Save a memory (private chat → user scope, group → chat scope) |
| `/memory` | List visible long-term memories |
| `/forget <id>` | Delete a memory in the current scope |
| `AW_ATTACH: /path/image.png` | In a final answer, send a local image through the bot |

Per-message limits: 10 minutes without output, 30 minutes wall clock, 100 tool calls.

---

## CLI reference

<details>
<summary>Show all commands</summary>

```bash
wardendeck init [--dir DIR] [--admin-email EMAIL] [--bind HOST:PORT] [--force]
wardendeck serve [--dir DIR] [--no-web]
wardendeck doctor
wardendeck status
wardendeck agents

wardendeck token reset [--set TOKEN]

wardendeck project create --name NAME --workdir PATH [--agent claudecode] [--permission-mode MODE]
wardendeck project list
wardendeck project permission --name NAME --mode MODE

wardendeck assistant add --name NAME [--agent claudecode]
wardendeck assistant list

wardendeck memory add --assistant NAME --scope assistant|project|chat|user \
  [--scope-id ID] [--text TEXT]
wardendeck memory list --assistant NAME
wardendeck memory forget --assistant NAME --id N

wardendeck secret set REF [--value VALUE]
wardendeck secret list

wardendeck platform test --platform feishu --credential REF [--send-to ID] [--text TEXT]
wardendeck platform bind --project NAME --platform feishu \
  --credential REF --channel ID [--allowed-users ID[,ID]]
wardendeck platform list
wardendeck platform unbind --id BINDING_ID

wardendeck feishu setup [--project NAME] [--credential REF]
wardendeck feishu chats [--credential REF]

wardendeck user add --email EMAIL [--role owner|admin|operator|viewer]
wardendeck user map --platform feishu --external-id OPEN_ID --email EMAIL
wardendeck user grant --project NAME --email EMAIL [--role operator]

wardendeck model add --id ID [--display-name NAME] [--provider PROVIDER]
wardendeck model set --project NAME --default ID
wardendeck model list

wardendeck audit list [--limit N]
wardendeck audit verify
```

All commands accept `--dir`, defaulting to `~/.wardendeck` or `$WARDENDECK_DIR`.

</details>

---

## Configuration

| Variable | Purpose |
|---|---|
| `WARDENDECK_DIR` | Data directory (default `~/.wardendeck`) |
| `WARDENDECK_DENY_PATHS` | Extra paths the agent may not read or execute, separated by the OS path delimiter |
| `WARDENDECK_SANDBOX=0` | Disable the macOS sandbox (not recommended) |
| `WARDENDECK_CLAUDE_AUTO_MEMORY=1` | Re-enable Claude Code's built-in auto memory (off by default to avoid leaking facts across bots) |

Permission modes: `default` (ask for every tool), `acceptEdits`, `plan`, `dontAsk`, `auto`, `bypassPermissions` (dangerous).

---

## Troubleshooting

<details>
<summary>The bot does not reply</summary>

1. `wardendeck status` — is the binding there?
2. Is `wardendeck serve` running?
3. In the Feishu console: long connection enabled, `im.message.receive_v1` subscribed, app published.
4. `wardendeck audit list` — look for `message.inbound`:
   - absent → the event never reached WardenDeck; check the event subscription;
   - present → check `allowed_users` against the sender's `open_id`.

</details>

<details>
<summary>It replies in private chat but not in a group</summary>

- The bot only answers when **this bot** is @-mentioned, not when another bot is mentioned.
- Verify the group `chat_id` with `wardendeck feishu chats`.
- Make sure the binding uses the `oc_...` group ID, not your personal `ou_...` ID.

</details>

<details>
<summary>No approval card appears</summary>

Add the `card.action.trigger` callback in the Feishu console. Until then, reply `1 / 2 / 3` to the approval prompt.

</details>

<details>
<summary>Doctor or secrets fail</summary>

```bash
wardendeck doctor
wardendeck audit verify
```

A `secrets` failure usually means the database and `master.key` do not belong together. Restore the matching key, or re-enter the credentials with `wardendeck secret set`.

</details>

---

## Current limitations

- **Claude Code is the only execution adapter.** Codex is detected but not wired up.
- **Slack and Telegram** support credential tests and bindings, but not message ingestion yet.
- **macOS-only kernel sandbox.** On Linux, run the service under a dedicated user or container.
- **Native sessions are not shared across agents**; only semantic memory is.
- **Models are optional configuration.** Claude Code uses its own configured model by default.
- **Sleep means offline.** Use `caffeinate`, an always-on host, or a server.

---

## Development

```bash
npm run build     # TypeScript -> dist/
npm test          # build + node:test
npm run dev       # build and start the CLI
```

| Path | Contents |
|---|---|
| `src/cli.ts` | Command dispatch and onboarding |
| `src/feishu.ts` | Long connection, routing, cards, approvals |
| `src/claude.ts` | stream-json session, permissions, process limits |
| `src/store.ts` | SQLite schema, memory, audit chain, secret encryption |
| `src/server.ts` | HTTP API and web console |
| `web/index.html` | Single-file console |

---

## Contributing

Issues and pull requests are welcome. For larger changes, open an issue first so the design can be discussed. Please keep the prototype honest: if a capability is partial, document it as partial.

---

## License

[MIT](LICENSE)
