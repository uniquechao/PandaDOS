# mando 部署与运维

[English](DEPLOY.md)

本文只描述当前 V2 系统。所有项目命令都从仓库根目录执行。

## 1. 运行条件

控制面需要：

- Bun、Git、tmux；
- 可写的 `~/.mando/`；
- 如需 PM 判断，在 Admin 中配置 OpenAI-compatible 驱动大模型；
- 如需飞书，配置飞书应用凭据。

执行机需要：

- tmux 和 Git；
- 已安装并登录 Claude Code 或 Codex；
- 控制面通过本机进程或 SSH 访问执行机。

## 2. 安装与启动

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build-ui
bun run start
```

服务默认监听 `127.0.0.1:8802`。首次启动会创建 admin 用户，明文 token
只输出一次，并以 `0600` 写入 `~/.mando/admin-token`。

健康检查：

```bash
curl --fail http://127.0.0.1:8802/healthz
```

生产环境必须保持回环绑定，并通过 nginx 或 Caddy 提供 TLS、认证和
WebSocket 转发。

## 3. systemd

下面是参考单元。按部署机器修改 `User`、`WorkingDirectory`、Bun 路径和
环境文件位置：

```ini
[Unit]
Description=mando control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/srv/mando
EnvironmentFile=-/root/.mando/env
ExecStart=/root/.bun/bin/bun run start
Restart=always
RestartSec=3

# 只终止控制面主进程，避免重启时连带杀掉 tmux 中正在运行的代理。
KillMode=process
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

安装或更新单元后：

```bash
systemctl daemon-reload
systemctl enable --now mando
systemctl status mando
```

后端改动需要重启服务：

```bash
systemctl restart mando
```

只修改前端时，执行 `bun run build-ui` 即可，不需要重启后端。

## 4. 执行机登记

### 本机执行机

当执行机 `host` 为 `127.0.0.1` 或 `localhost`，且 `keyRef` 为空时，
系统使用 `LocalDriver`。如果 `executors` 表为空，服务也会回退到本机执行机。

管理员通过 `POST /api/admin/executors` 登记：

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

### SSH 执行机

私钥放在控制面 `~/.mando/keys/<keyRef>`，权限设为 `0600`，不要写入
数据库或仓库。首次登记前先手动 SSH 连接，确认 host key、tmux 和代理登录状态。

```bash
chmod 600 ~/.mando/keys/<keyRef>
ssh -i ~/.mando/keys/<keyRef> <user>@<host> 'tmux -V'
```

随后通过同一个管理员 API 登记真实 `host`、`sshUser`、`keyRef`、
`workspaceRoot` 和 `claudeDir`。

当前采用单主执行机模型：控制面选择最小 executor id 作为主执行机。

## 5. 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MANDO_BIND` | `127.0.0.1` | HTTP 绑定地址 |
| `MANDO_PORT` | `8802` | HTTP 端口 |
| `MANDO_DB` | `~/.mando/mando.db` | SQLite 数据库 |
| `MANDO_ADMIN_TOKEN_FILE` | `~/.mando/admin-token` | admin token 文件 |
| `MANDO_LLM_BASE_URL` | 无 | Admin 尚未保存地址时的部署兜底 |
| `MANDO_LLM_MODEL` | 无 | Admin 尚未保存模型时的部署兜底 |
| `MANDO_LLM_API_KEY` | 无 | PM LLM 密钥 |
| `MANDO_FEISHU_APP_ID` | 无 | 飞书应用 ID |
| `MANDO_FEISHU_APP_SECRET` | 无 | 飞书应用密钥 |
| `MANDO_FEISHU_CHANNEL` | `on` | `off` 时关闭飞书事件长连接 |
| `MANDO_PUBLIC_URL` | 按请求推导 | OAuth 对外基址 |

## 6. 日常运维

```bash
journalctl -u mando -f
systemctl status mando
curl --fail http://127.0.0.1:8802/healthz
```

部署前至少运行：

```bash
bun run typecheck
bun test
bun run build-ui
```

数据库诊断应保持只读。备份 SQLite 时同时考虑 WAL 文件，或先用 SQLite
在线备份能力生成一致快照。不要在 issue 正在执行时重启服务。
