# Deployment and Operations

[简体中文](DEPLOY.zh-CN.md)

This guide covers the current PandaDOS V2 system. Run all project commands from the repository root.

## Requirements

The control plane needs Bun, Git, tmux, a writable `~/.panda/`, and optionally an OpenAI-compatible driver model and Feishu credentials. Each executor needs tmux, Git, and an authenticated Claude Code or Codex installation. Executors may be local or reached over SSH.

## Install and start

```bash
bun install --frozen-lockfile
bun run check-i18n
bun run typecheck
bun test
bun run build-ui
bun run start
```

The default endpoint is `127.0.0.1:8802`; health checks use:

```bash
curl --fail http://127.0.0.1:8802/healthz
```

The first start creates the admin user and writes its one-time token to `~/.panda/admin-token` with mode `0600`. Keep the service bound to loopback and expose it through nginx or Caddy with TLS, authentication, and WebSocket forwarding.

## systemd example

```ini
[Unit]
Description=PandaDOS control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/srv/panda
EnvironmentFile=-/root/.panda/env
ExecStart=/root/.bun/bin/bun run start
Restart=always
RestartSec=3
KillMode=process
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`KillMode=process` avoids killing agent processes running inside tmux when the control plane restarts. Apply changes with `systemctl daemon-reload`; backend changes require `systemctl restart panda`, while UI-only changes need only `bun run build-ui`.

## Executors

A host of `127.0.0.1` or `localhost` with no `keyRef` uses `LocalDriver`. SSH private keys belong in `~/.panda/keys/<keyRef>` with mode `0600`; verify SSH host keys and agent login state manually before registration. The current scheduler selects the executor with the smallest id as the primary executor.

Example registration body for `POST /api/admin/executors`:

```json
{
  "name": "local",
  "host": "127.0.0.1",
  "port": 22,
  "sshUser": "root",
  "keyRef": null,
  "workspaceRoot": "/root/workspace",
  "claudeDir": "/root/.claude/projects"
}
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PANDA_BIND` | `127.0.0.1` | HTTP bind address |
| `PANDA_PORT` | `8802` | HTTP port |
| `PANDA_DB` | `~/.panda/panda.db` | SQLite database |
| `PANDA_ADMIN_TOKEN_FILE` | `~/.panda/admin-token` | Admin token file |
| `PANDA_LLM_BASE_URL` | unset | Driver-model fallback endpoint |
| `PANDA_LLM_MODEL` | unset | Driver-model fallback name |
| `PANDA_LLM_API_KEY` | unset | Driver-model credential |
| `PANDA_FEISHU_APP_ID` | unset | Feishu application id |
| `PANDA_FEISHU_APP_SECRET` | unset | Feishu application secret |
| `PANDA_FEISHU_CHANNEL` | `on` | Set `off` to disable the event connection |
| `PANDA_PUBLIC_URL` | inferred | Public OAuth base URL |

## Operations

Use `journalctl -u panda -f`, `systemctl status panda`, and the health endpoint for routine checks. Avoid restarting while an issue is running. Diagnose production databases read-only; use SQLite online backup or another WAL-aware method for consistent backups.
