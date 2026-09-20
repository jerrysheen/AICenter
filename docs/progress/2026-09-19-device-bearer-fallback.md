# 2026-09-19 登录不依赖 Cookie

## 目标

账号密码已经通过，下一屏仍显示尚未配对。真机地址栏是 `http://` 公网域名，`Secure` Cookie 写不进去。只靠 Cookie 在部分手机上不够用。

## 决定

- 登录 / 配对响应一次性返回设备 `token`。
- 页面保存在同源 localStorage，请求带 `Authorization: Bearer`。
- 服务端 Cookie 与 Bearer 都能授权；SSE 改为 fetch，不再只靠 EventSource Cookie。
- 公网 `http` 升到 `https`（页面 + 源站 308）。局域网 IP 不动。

## 验证

`npm test -- test/device-auth.test.js test/identity-login.test.js test/public-gateway.test.js test/server.test.js`
