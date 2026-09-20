# 2026-09-19 实例账号登录

## 目标

在不建设 User / Tenant 的前提下，给未配对页面增加账号密码入口，作为扫码配对的第二路径。

## 决定

- 需求合理：配对解决的是「这台手机连上这台电脑」；账号密码解决的是「我知道这个 Instance 的口令」。
- 不做多用户。`AI_CENTER_LOGIN_USERNAME` / `AI_CENTER_LOGIN_PASSWORD` 是 Instance 共享秘密，只放未提交的 `.env`。
- 登录成功后签发和配对相同的设备 token / HttpOnly Cookie。公网登录不能变成桌面管理员。
- 未配置时入口关闭；错误账号或密码返回同一句文案；与配对共用尝试限速。

## 改动

- Domain：`loginWithPassword` / `loginAvailable` / `resolveLoginCredential`
- Store：抽出 `issueDevice`，配对与登录共用
- HTTP：`POST /api/v1/session/login`；未配对 session 带 `loginAvailable`
- 未配对页面显示账号密码表单
- 文档与 `.env.example` 同步

## 验证

`npm test -- test/identity-login.test.js test/contracts.test.js test/public-gateway.test.js test/server.test.js`

## 遗留

本机桌面仍靠回环自动授权。改密码需要改 `.env` 并重启 Web。第二个真实用户出现前，不把这层扩成账户系统。
