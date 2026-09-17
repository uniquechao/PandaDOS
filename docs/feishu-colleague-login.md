# 同企业飞书成员直接登录

管理员和同事的完整操作步骤见[飞书使用指南](feishu.md)。本文说明同企业登录的身份边界、配置方式与验证方法。

需求：同一个飞书企业里的同事能直接登录并操作各自的项目。

## 设计与实施

- 延用现有扫码入口和一次性 OAuth state。已有绑定账号保持身份和权限。
- 首次登录用服务端自建应用凭据获取企业身份，与 user_info 返回的 tenant_key 比较。身份缺失、企业不匹配或接口失败时不建号、不签发会话。
- 同企业用户自动创建普通账号并绑定 open_id；事务内再次查重，避免并发回调重复建号。随机用户名可由管理员修改，不按飞书姓名合并账号。
- 复用项目属主/成员权限与按用户 ID 分配的工作区。同企业身份不会自动授予其他人的项目权限。

## 应用配置

优先在管理 → 飞书保存企业自建应用凭据；尚未保存时使用 PANDA_FEISHU_APP_ID / PANDA_FEISHU_APP_SECRET 部署兜底。应用需开放给同事使用，授权回调地址仍是 /api/feishu/oauth/callback。首次建号需要应用能调用获取企业信息接口（`tenant:tenant:readonly`）；权限不足会显示重试/联系管理员提示。

官方接口：[获取企业信息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/tenant-v2/tenant/query)、[自建应用企业凭据](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)、[用户信息](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get)。

## 管理配置与验证

- 管理 → 飞书登录（`#/admin/feishu`）：登录开关、同企业自动建号开关、App ID、App Secret、公开站点地址及完整回调地址。
- GET/PUT `/api/admin/feishu-login-config` 只允许管理员；数据库配置整行覆盖部署兜底，密码输入留空保留同应用旧密钥，清除/关闭不回退到环境变量，切换 App ID 必须重新提供密钥。密钥只写，不经查询或验证响应回显。
- POST `/api/admin/feishu-login-config/verify` 验证当前表单而不保存。实际调用企业凭据与企业信息接口，分开报告凭据/网络失败和企业权限/查询失败，成功返回企业名称与 tenant_key。不会发送通知。
- 保存立即影响后续扫码；一次性 state 记录配置版本，在途授权遇到配置改变会要求重扫，包括企业核验等待期间的配置变更。
- 消息长连接复用这里保存的应用凭据，通过独立的消息开关控制；设置步骤见[飞书消息沟通](feishu-messaging.md)。服务器验证无法证明应用已发布、用户属于可用范围或回调已加入飞书白名单，管理页明确列出需在飞书后台完成的步骤。

保存后请分别验证管理员本人和一名普通同事的扫码登录。确认普通同事只能访问本人拥有或已加入的项目，并在修改应用可用范围、回调白名单或企业权限后重新扫码验证。
