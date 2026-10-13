# 2026-10-13 请求访问日志

## 目标

tradingplus.cn 经 Cloudflare Tunnel 变慢时，要能把时间拆开：Node 在发出首字节之前花了多久，首字节之后传到结束花了多久，以及浏览器侧的 DNS、连接、TLS、TTFB 和下载。

## 决定

- 每个 HTTP 请求在结束时追加一行 JSON 到 Instance `data/logs/access.yyyy-MM-dd.log`。日期按 Asia/Shanghai。字段包括 `receivedAt`、`firstByteAt`、`finishedAt`、`aborted`、`bytesSent`、`status`、`method`、`path`、`cache`、`cfRay`、`client`、`ua`、`serverMs`、`transferMs`、`totalMs`。
- `path` 只留路径；查询值去掉，只保留合法的 `v`。`ua` 只记 mobile / desktop / bot / other。`cf-connecting-ip` 用进程内随机盐做 sha256，取前 16 位；没有这个头就不记。不记原始 IP、Cookie 和 User-Agent 原文。
- `serverMs` 是首字节减收到，`transferMs` 是结束减首字节。首字节取 `writeHead` 或第一次 `write` / `end`。连接在首字节前断开时 `aborted` 为 true，这两项为空，`totalMs` 仍是收到至关闭。
- `cache.control` 是本进程写出的 Cache-Control。`cache.notModified` 表示 304。静态文件进程内缓存命中时写 `cache.hit`。
- 写入用按日轮转的追加流，先入内存队列再异步刷出。队列过长丢掉最旧的一行。失败只丢掉日志，不抛进请求。`AI_CENTER_ACCESS_LOG=0` 关闭。`AI_CENTER_ACCESS_LOG_RETENTION_DAYS` 默认 14，更早的 `access.*.log` 和 `client-timing.*.log` 在轮转时删除。
- `scripts/access-log-summary.mjs --date --since --top` 只读打印每个路径的 serverMs / transferMs / total 的 p50、p95、max，以及 count 和 bytes。`GET /api/v1/runtime/access-summary` 返回同一结构，鉴权与 `deploy-status` 相同：必须有设备登录，回环和转发头都不能代替。Bearer 不在白名单。
- 页面在 `load` 之后由 `/client-timing.js?v=dev` 以 20% 抽样，用 `sendBeacon` 把 Navigation Timing（dns、connect、tls、ttfb、download、domContentLoaded、load）和最慢的约 20 条同源资源 POST 到 `/api/v1/runtime/client-timing`。服务端再按 `AI_CENTER_CLIENT_TIMING_SAMPLE` 抽样，默认收下浏览器已经抽样的请求。正文上限 4KB。同一进程每分钟最多收下 300 条。`Origin` 与 Host 不一致，或 `Sec-Fetch-Site` 为 cross-site / same-site 时直接 204，不记正文。记到 `data/logs/client-timing.yyyy-MM-dd.log`。不接第三方。

## 改动

- `apps/web/src/http/access-log.js`、`apps/web/src/server.js`、`apps/web/src/http/static-files.js`、`apps/web/src/routes/runtime-routes.js`
- `apps/web/public/client-timing.js`、`index.html`、`etf-whale.html`
- `scripts/access-log-summary.mjs`
- `test/access-log.test.js`、`test/api-tokens.test.js`
- `docs/api.md`、`docs/ai-development-guide.md`、`docs/release-readiness.md`

## 验证

- `node --test test/access-log.test.js test/static-files.test.js test/static-module-whitelist.test.js test/api-tokens.test.js`

## 遗留

需要重启 Web，访问日志和两个接口才在运行中的进程里生效。只替换 public 文件不会挂上记录器。Worker 不用为这项重启。自动部署若发现 `apps/web/src` 有变化，仍会按原规则同时重启 Web 和 Worker。
