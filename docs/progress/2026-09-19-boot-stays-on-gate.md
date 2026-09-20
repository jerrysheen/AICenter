# 2026-09-19 启动停在连接门闩

## 目标

未配对或校验失败时，不要先闪进 sources / 业务页再退回登录。

## 决定

- HTML 首屏就是连接门闩：`body.is-unpaired`，业务壳在 `is-ready` 之前不显示。
- `initialize` 先配对 URL / 读 session，成功后才 `paintAuthorizedChrome` 和 `setView`。
- 失败只更新同一扇门闩（登录表单或扫码说明），不渲染总览，也不把 `bootstrapped` 打开。

## 改动

- `apps/web/public/index.html` / `styles.css` / `app.js`
- `docs/connection-and-pairing.md`
- `test/static-files.test.js` 断言首屏门闩

## 验证

`npm test -- test/static-files.test.js`

## 遗留

本机 `127.0.0.1` 仍会自动通过桌面会话，门闩只短暂出现。手机或公网未授权时会留在该页。
