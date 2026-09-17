# 手机外网启动变慢：静态资源、鸿蒙重试与启动请求

## 目标

降低 Harmony / 手机经 Cloudflare Tunnel 打开 AI Center 的等待时间，不改变配对、公网隔离和页面 Contract。

## 决定

- HTML 仍 `no-store`；带版本号的 JS/CSS 使用长期 `immutable` 缓存，改文件时只 bump `index.html` 与模块 import 上的 `?v=`。
- Origin 对 `Accept-Encoding: gzip` 压缩静态资源，并设置 `Vary: Accept-Encoding`。
- 鸿蒙薄壳不再在 1.2s/2.8s 主动 `loadUrl` 打断首次加载。局域网超时 8 秒、HTTPS 公网 25 秒，失败后再重试，最多 3 次。
- 会话校验成功后立即 `bootstrapped`、连 SSE；`posts` / X 缓存 / notes / knowledge 并行，失败只 toast，不再把已配对设备打回未配对页。

## 改动

- `apps/web/src/http/static-files.js`、`apps/web/src/server.js`
- `apps/web/public/index.html`、`apps/web/public/app.js`
- `apps/harmony/entry/src/main/ets/pages/Index.ets`
- `scripts/validate-harmony-scaffold.js`
- `apps/harmony/README.md`、`docs/architecture.md`、`docs/connection-and-pairing.md`
- `test/static-files.test.js`

## 验证

- `npm run check`
- 真机外网冷启动、杀进程再开（应命中 JS/CSS 缓存）、隧道断开后局域网仍可用：由用户执行。
