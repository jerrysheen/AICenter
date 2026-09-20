# 2026-09-19 登录回到 Cookie

## 目标

Cloudflare 已打开 Always Use HTTPS。不再用页面保存 token / Bearer 作为第二条登录路。

## 决定

- 登录和配对只发 HttpOnly Cookie，响应不再带 `token`。
- 实时连接回到 `EventSource`。
- 公网 HTTP 升 HTTPS、双 Cookie、登录后不整页刷新保留。

## 验证

`npm test -- test/device-auth.test.js test/identity-login.test.js test/public-gateway.test.js test/server.test.js`
