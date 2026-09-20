# 2026-09-19 账号登录后不再整页刷新

## 目标

账号密码已经通过，但第一次仍提示设备未连接、要再点一次重新连接。

## 决定

- 登录成功后不再 `location.reload()`。整页刷新会让鸿蒙 ArkWeb 把主框架错误当成「公网连不上」，也会赶上 Cookie 还没带上的第一轮 session。
- 登录后短重试读取 `/api/v1/session`，确认设备 Cookie 后再走同一条授权进入路径。

## 改动

- `apps/web/public/app.js`：抽出 `completeAuthorizedStart`，登录与启动共用
- `apps/harmony/.../Index.ets`：主框架报错先探活；健康检查仍通则不切到「重新连接」

## 验证

`npm test -- test/static-files.test.js`

## 遗留

鸿蒙改动要用户在 DevEco 重新编译安装后才生效。网页登录不再整页刷新，当前 Web 刷新即可。
