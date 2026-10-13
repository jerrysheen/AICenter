# 2026-10-13 Web 主线程不再计算看板和持仓行情

## 原因

访问日志里，`/api/v1/ui/revision` 平时大约 6 毫秒，p95 却到 9.1 秒；很小的静态 JS 也会到 0.4–3.7 秒。隧道本身只增加 0.2–0.5 秒。这些变慢和最慢的 `GET /api/v1/static-signals/board`（p50 4.6 秒，p95 9.5 秒）、`GET /api/v1/holdings`（p95 9.2 秒）落在同一段时间。

官方看板在 Web 请求里并发读取全部日历和政策源。每个源要抓页面并在主线程里解析。持仓每次请求都等 `market.quotes` 和 `market.history`。`refresh=1` 会跳过几秒到二十秒的缓存，于是雪球取令牌、Yahoo / Tushare 拉三个月 K 线，再在主线程里 `JSON.parse`。这段时间事件循环转不动，旁边的修订号和静态文件也要等。

## 决定

- Worker 每分钟执行 `source.static-signal-board.snapshot`。它仍用 `readStaticSignalBoard` 做原来的合并、去重和关注过滤，窗口是当前时刻前 2 天到后 400 天，含未定日期，条数用上限。结果写入 `runtime_snapshots`，键是 `static-signal-board`，并带上事件来源，供之后按 focus 投影。国新办这类始终关注的来源靠这个来源编号保留。
- `GET /api/v1/static-signals/board` 只读最新快照。内存缓存 45 秒；过期先返回上一份，再在后台重读数据库。还没有快照时，空结果只缓存 5 秒。`refresh=1` 只跳过内存缓存，不读官方源。查询参数仍用来裁时间窗、focus 和条数。有快照时响应仍是 `{ ok, board, localizations }`，`board` 字段不变。没有快照时 `board` 为空，并多一个 `pending: true`。
- Worker 每分钟执行 `market.holdings.snapshot`。报价每次刷新；三个月日线大约 15 分钟刷新一次，标的变了会立刻补。新报价缺某一笔时，留下上一笔有效价。`GET /api/v1/holdings` 用快照和当前批次账本组看板，响应形状不变。没有快照时说明写「行情快照尚未就绪」，不访问行情源。K 线页面仍用原来的 `market_history_cache`。
- Web 用 `perf_hooks.monitorEventLoopDelay`，每 60 秒打一行 `[web] event-loop p50=… p99=… max=…`。同一行写入访问日志，`kind` 为 `event-loop`。汇总脚本和 `GET /api/v1/runtime/access-summary` 增加 `eventLoop`，不计入路径的 p50/p95。慢请求日志里的 `loop_p99` 仍在。

## 改动

- migration 58：只新增 `runtime_snapshots`。
- `packages/source/src/static/board.js`、`board-read.js`
- `packages/runtime/src/web-snapshot-jobs.js`、`snapshot-cache.js`
- `packages/domain/src/trading-service.js`
- `apps/web/src/server.js`、`routes/source-routes.js`、`http/access-log.js`、`http/event-loop-monitor.js`
- `apps/worker/src/worker.js`
- `test/web-main-thread.test.js`

## 验证

- `node --test test/web-main-thread.test.js test/static-signal-board.test.js test/holdings.test.js test/access-log.test.js test/source.test.js test/api-tokens.test.js`

## 重启

需要同时重启 Web 和 Worker。先启动的进程会执行 migration 58，只建表，不改已有数据，不要重建数据库。只重载静态文件不够：看板和持仓的读路径在 Web 进程里，快照任务在 Worker 里。Worker 起来后大约一分钟内写入第一份快照；在那之前看板是空的并标 `pending`，持仓按账本显示、行情标未就绪。
