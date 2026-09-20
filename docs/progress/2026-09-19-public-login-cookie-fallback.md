# 2026-09-19 公网登录 Cookie 回退

## 目标

账号密码已经通过，下一屏却显示「此设备尚未配对」。

## 决定

- 公网只种 `__Host-` Cookie 时，部分手机浏览器 / ArkWeb 会丢掉，随后 `/api/v1/session` 当成未配对。
- 公网同时下发一份同值的 `ai_center_device`（`Secure` + `SameSite=Lax`）。服务端本来就会读两种名字。
- 登录后若仍读不到会话，文案改成「授权还没写进浏览器」，不再复用配对失败那句。

## 改动

- `apps/web/src/server.js` Cookie adapter
- `apps/web/src/http/response.js` 允许多条 `Set-Cookie`
- 登录页重试文案
- `test/public-gateway.test.js`、`test/identity-login.test.js`

## 验证

`npm test -- test/public-gateway.test.js test/identity-login.test.js test/server.test.js`

## 遗留

Web 进程要重启后才种双 Cookie。
