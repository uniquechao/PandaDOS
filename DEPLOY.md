# MandoAI 部署指南

本文说明当前版本的安装、配置和安全部署方式。示例使用专用系统账号 `mando`、
安装目录 `/srv/mando` 和公开示例域名 `mando.example.com`。

## 运行条件

控制面需要：

- Bun、Git、tmux；
- 可写的运行目录 `~/.mando/`；
- OpenAI-compatible API（可选，用于 PM 判断、总结和问答）；
- 飞书应用凭据（可选，用于登录与通知）。

执行机需要：

- Git 和 tmux；
- 已安装并登录 Claude Code 或 Codex；
- 本机访问，或从控制面可达的 SSH 服务。

## 安装

```bash
git clone https://example.com/your-org/mando.git /srv/mando
cd /srv/mando
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build-ui
```

启动服务：

```bash
bun run start
```

默认监听地址是 `127.0.0.1:8802`。首次启动会创建管理员账号，并把一次性明文
token 写入 `~/.mando/admin-token`，权限为 `0600`。

健康检查：

```bash
curl --fail http://127.0.0.1:8802/healthz
```

## 环境变量

建议把部署变量写入权限为 `0600`、且位于仓库外的环境文件：

```dotenv
MANDO_BIND=127.0.0.1
MANDO_PORT=8802
MANDO_DB=/var/lib/mando/mando.db
MANDO_ADMIN_TOKEN_FILE=/var/lib/mando/admin-token

MANDO_LLM_BASE_URL=
MANDO_LLM_MODEL=
MANDO_LLM_API_KEY=

MANDO_FEISHU_APP_ID=
MANDO_FEISHU_APP_SECRET=
MANDO_FEISHU_CHANNEL=off
MANDO_PUBLIC_URL=https://mando.example.com
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MANDO_BIND` | `127.0.0.1` | HTTP 绑定地址 |
| `MANDO_PORT` | `8802` | HTTP 端口 |
| `MANDO_DB` | `~/.mando/mando.db` | SQLite 数据库 |
| `MANDO_ADMIN_TOKEN_FILE` | `~/.mando/admin-token` | 管理员 token 文件 |
| `MANDO_LLM_BASE_URL` | 空 | OpenAI-compatible API 地址 |
| `MANDO_LLM_MODEL` | 空 | 驱动模型名称 |
| `MANDO_LLM_API_KEY` | 空 | 驱动模型密钥 |
| `MANDO_FEISHU_APP_ID` | 空 | 飞书应用 ID |
| `MANDO_FEISHU_APP_SECRET` | 空 | 飞书应用密钥 |
| `MANDO_FEISHU_CHANNEL` | `on` | 设为 `off` 可关闭飞书长连接 |
| `MANDO_PUBLIC_URL` | 按请求推导 | OAuth 对外基址 |

## systemd

创建 `/etc/systemd/system/mando.service`：

```ini
[Unit]
Description=MandoAI control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mando
WorkingDirectory=/srv/mando
EnvironmentFile=-/etc/mando/env
ExecStart=/home/mando/.bun/bin/bun run start
Restart=always
RestartSec=3
KillMode=process
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

启用服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mando
sudo systemctl status mando
```

后端代码更新后需要重启服务；只更新前端时重新运行 `bun run build-ui` 即可。

## 执行机

### 本机执行机

本机执行机使用 `LocalDriver`，无需 SSH 密钥。示例配置：

```json
{
  "name": "local",
  "host": "127.0.0.1",
  "port": 22,
  "sshUser": "mando",
  "keyRef": null,
  "workspaceRoot": "/srv/mando-workspaces",
  "claudeDir": "/home/mando/.claude/projects",
  "codexDir": "/home/mando/.codex/sessions"
}
```

### SSH 执行机

把私钥保存在控制面的 `~/.mando/keys/`，设置为 `0600`，不要写入数据库或仓库。
首次登记前先手动确认主机指纹和代理登录状态：

```bash
chmod 600 ~/.mando/keys/example_ed25519
ssh -i ~/.mando/keys/example_ed25519 developer@executor.example.com 'tmux -V'
```

登记时使用示例字段对应的真实部署值，并为执行机账号配置最小必要权限。

## 反向代理

服务应保持回环绑定，由 nginx、Caddy 或等效代理提供 TLS、强认证和 WebSocket 转发。
不要把 `8802` 端口直接暴露到公网。

反向代理至少需要：

- 转发普通 HTTP 请求；
- 支持 WebSocket upgrade；
- 保留 `Host` 和 `X-Forwarded-Proto`；
- 限制请求体大小和访问来源；
- 使用有效 TLS 证书。

## 运维与备份

部署前运行：

```bash
bun run typecheck
bun test
bun run build-ui
```

日常检查：

```bash
sudo systemctl status mando
sudo journalctl -u mando -f
curl --fail http://127.0.0.1:8802/healthz
```

SQLite 使用 WAL 模式。备份应采用 SQLite 在线备份能力或同时处理数据库与 WAL 文件，
并在隔离环境验证恢复流程。不要在 issue 正在执行时重启控制面。
