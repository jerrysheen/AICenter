# 2026-10-13 事件循环归因与行情快照

## 原因

官方看板和持仓改读快照之后，这两条的服务端 p95 降到 25 毫秒以内。事件循环直方图的 max 仍有 2–5 秒，p99 仍有 260–541 毫秒。分钟采样能看见延迟，但看不出是哪条请求占住了主线程。

`GET /api/v1/markets` 仍要 1.3–5.7 秒，方差很大。`GET /api/v1/market-native/board` 约 3.9 秒。两条都在 Web 请求里打上游，响应到达后还在主线程里解析。静态文件缓存未命中时，`app.js`（约 592KB）和 `klinecharts.js`（约 234KB）用 `gzipSync` 压缩，信息树 JSON 同样用同步 gzip。这些会把旁边的请求一起拖住。

## 决定

- 访问日志每个请求增加 `loopMs`。它是这段请求开始和结束时 `monitorEventLoopDelay` 直方图 max 的差，单位毫秒。窗口在请求中途被重置时，用重置后的 max。汇总按路径给出 `loopMs` 的 p50/p95/max。单次达到 200 毫秒时，另打一行 `[web] event-loop METHOD PATH loopMs=…`。每分钟的 `kind=event-loop` 采样保留。
- 静态文件改为 `zlib.gzip` 异步压缩。非 HTML 不再为了 CSP 把整份脚本转成字符串。信息树 JSON 的 gzip 也改到 zlib 线程池，路由会等压缩完成再结束响应。
- Worker 每分钟执行 `market.boards.snapshot`。它读取美股、亚洲、A 股和全球四份看板，再按捕获时刻的北京时间焦点拼总览，与原来的总览规则相同（总览不另读亚洲）。五份分别写入 `runtime_snapshots`，键是 `market-board-overview`、`market-board-us`、`market-board-asia`、`market-board-cn`、`market-board-global`。
- `GET /api/v1/markets` 只读所请求的那一份。内存缓存 45 秒，过期先返回旧值。`refresh=1` 只重读数据库，不打上游。没有快照时返回同形状的空看板，说明写「行情快照尚未就绪」，并带 `pending: true`；空结果只缓存 5 秒。有快照时响应仍是 `{ ok, market }`。
- 美股、亚洲、A 股查询里的用户自选不在目录快照中。Web 只为这些代码补报价，单独缓存 45 秒，不重算整板。总览和全球资产不走这条补价。
- Worker 每分钟执行 `market.native-board.snapshot`，按预测上限 50 写入键 `market-native-board`。`GET /api/v1/market-native/board` 只读这份快照，再按请求的 `predictionLimit` 截断，然后仍用已有的 24 小时概率表追加 `midPrice24hAgo`。没有快照时 `board` 为空并带 `pending: true`。按小时的 `market.event-quote.snapshot` 仍直接读来源，用来写概率表。
- 不新增表，也不改 migration 58。`GET /api/v1/sources/market.*`、K 线、搜索、feed/x、feed/xueqiu、trendforce 不在这次改动里。

## 改动

- `apps/web/src/http/access-log.js`、`static-files.js`、`response.js`
- `apps/web/src/routes/trading-routes.js`、`source-routes.js`、`report-routes.js`
- `apps/web/src/server.js`、`apps/worker/src/worker.js`
- `packages/runtime/src/web-snapshot-jobs.js`
- `packages/source/src/market/board-read.js`、`packages/source/src/static/market-native-read.js`
- `packages/domain/src/trading-service.js`
- `test/event-loop-markets.test.js`

## 验证

- `node --test test/event-loop-markets.test.js test/markets-api.test.js test/source.test.js test/json-compression.test.js test/static-files.test.js test/access-log.test.js test/market-native-sources.test.js test/event-quote-snapshots.test.js test/web-main-thread.test.js`

## 重启

需要同时重启 Web 和 Worker。没有新的 migration，不要重建数据库。只重载静态文件不够：gzip 和读路径在 Web 进程里，两份快照任务在 Worker 里。Worker 起来后大约一分钟内写入第一份行情快照；在那之前 `GET /api/v1/markets` 和 `GET /api/v1/market-native/board` 返回空看板并标 `pending`，不访问上游。
