# MandoAI — Issue-driven coding agent orchestration

**Your self-hosted control plane for Claude Code and Codex. Turn issues into queued, observable,
approval-aware coding workflows—from any browser.**

[English](README.md) · [简体中文](README.zh-CN.md)

[Quick Start](#quick-start) · [Highlights](#highlights) · [Architecture](#architecture) ·
[Deployment](#deployment) · [Security](#security)

MandoAI connects your issue queue, coding-agent CLIs, tmux sessions, and a browser workspace. It
coordinates clarification, execution, approvals, progress, notifications, and recovery while the
actual code changes remain in the hands of Claude Code or Codex on machines you control.

MandoAI is not an AI model. It is the orchestration and observability layer between your team and
the coding agents you already use.

![MandoAI workspace overview](docs/images/mando-workspace-overview.png)

> The workspace, users, issues, branches, and project names shown above are sanitized demo data.

## Quick Start

### Requirements

- macOS or Linux
- [Bun](https://bun.sh/)
- Git and tmux
- Claude Code or Codex CLI, installed and authenticated on the executor machine

### Install and run

```bash
git clone https://github.com/uniquechao/MandoAI.git
cd MandoAI
bun install --frozen-lockfile
bun run check-i18n
bun run build-ui
bun run start
```

Open `http://127.0.0.1:8802`.

On first start, MandoAI creates the administrator account. Its one-time token is printed once and
written to `~/.mando/admin-token` with `0600` permissions. Keep it private.

For reverse proxies, environment variables, SSH executors, and production service setup, see the
[deployment guide](DEPLOY.md).

## Highlights

- **Issue-to-execution workflow** — Queue work, clarify missing requirements, plan, execute, verify,
  record the outcome, and hand useful context to the next issue.
- **Claude Code and Codex** — Select an agent per project, module, or issue while reusing persistent
  logical sessions instead of restarting context for every task.
- **Browser-native workspace** — Follow conversations, live terminals, files, images, Git history,
  working-tree changes, and execution progress in one place.
- **Human-in-the-loop approvals** — Choose cautious, balanced, or automatic approval levels.
  Destructive and security-sensitive operations still require explicit confirmation.
- **Local and SSH executors** — Run coding agents on the control-plane host or registered remote
  machines through a shared executor boundary.
- **Team-ready projects** — Organize work by project and module, add members, maintain summaries,
  subscribe to notifications, and run independent projects in parallel.
- **Global localization** — Use English by default or switch among ten UI languages. Browser locale
  and IANA timezone are detected initially, while account preferences remain user-controlled.
- **Localized AI and notifications** — Clarifications, summaries, approvals, notifications, and
  cards follow each recipient's language without altering issues, code, terminal output, Git data,
  or existing chat history.

## How it works

```text
User / Browser / Notifications
              │
              ▼
     MandoAI control plane
              │
              ├── Issues, queue, and clarification
              ├── Approvals, progress, and recovery
              └── Sessions, files, terminal, and Git
              │
              ▼
       Local or SSH executor
              │
              ▼
      tmux → Claude Code / Codex
```

Each issue is a traceable unit of work. MandoAI keeps the queue and state machine moving, pauses
when a decision is needed, and exposes the agent's real session instead of hiding it behind a chat
transcript. Projects can run independently; work sharing one repository is serialized to reduce
conflicting edits.

![MandoAI issue workflow](docs/images/mando-issue-workflow.png)

> Issue state, progress, agent, target branch, approvals, and execution summary stay together.

## Architecture

The backend keeps its dependency direction explicit:

```text
core ← executor ← issues ← agents
  ↑
web / notify
```

| Directory | Responsibility |
|---|---|
| `src/core/` | SQLite, migrations, users, conversations, files, skills, and project data |
| `src/executor/` | Local and SSH executor abstraction |
| `src/issues/` | Issue state machine, queue, modules, clarification, and execution engine |
| `src/agents/` | LLM client, PM decisions, progress, and approval policies |
| `src/notify/` | Subscriptions, aggregation, and notification channels |
| `src/web/` | HTTP API, WebSocket, terminal bridge, and service composition |
| `ui/` | Preact and Vite browser interface |
| `shared/i18n/` | Typed catalogs, ICU formatting, locale matching, and timezone formatting |

The main stack is Bun, TypeScript, SQLite, Preact, Vite, tmux, xterm.js, and ssh2. Read the
[execution model](docs/execution-model.md) for the runtime architecture and module boundaries.

## Deployment

MandoAI binds to `127.0.0.1:8802` by default. Keep that loopback default for local use. For remote
access, place it behind a trusted reverse proxy that provides TLS and authentication.

Configuration uses `MANDO_*` environment variables. The complete reference, systemd example,
reverse-proxy configuration, and SSH executor setup are in [DEPLOY.md](DEPLOY.md).

## Security

MandoAI can expose terminals, files, Git operations, and coding-agent sessions. Treat access to the
web interface as access to a remote shell.

- Do not expose the service directly to the public internet.
- Require TLS and authentication at a trusted reverse proxy for remote access.
- Never commit `.env` files, databases, administrator tokens, credentials, SSH private keys, or
  agent session data.
- Use dedicated executor accounts and least privilege.
- Review approval policies before enabling higher automation levels.
- Back up runtime data and verify file permissions before production use.

## Development

```bash
bun run check-i18n
bun run typecheck
bun test
bun run build-ui
```

Read [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md) before contributing. Keep changes focused,
preserve the documented dependency boundaries, and include validation appropriate to the change.

## License

MandoAI is licensed under the [Apache License 2.0](LICENSE).
