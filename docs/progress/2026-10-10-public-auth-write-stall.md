# 2026-10-10 公网鉴权不再同步写最后在线

## 目标

公网请求的 TTFB 会被 Worker 的 SQLite 写锁拖住。edition 本身只有大约 1ms，慢在排队。

## 决定

`authorizeToken` 只读校验令牌。`devices.last_seen_at` 按设备 60 秒节流，放到请求之后异步写；写锁冲突就放弃这一轮，下一轮再写。`revoked_at IS NULL` 仍在每次鉴权的只读查询里，撤销立即生效。

`/api/` 响应加 `Server-Timing`（`auth`、`handler`、`total`）。事件循环用 `perf_hooks.monitorEventLoopDelay` 看最近窗口的 p99；单请求超过 500ms，或 p99 超过 200ms，记一条日志。Worker 进程里持锁超过 200ms 的 `database.transaction` 记一条日志。

刊期 id 是内容哈希。`GET /api/v1/reports/tree/edition` 的 200 响应使用 `Cache-Control: private, max-age=86400, immutable`。404 和其他接口仍是 `no-store`。

## 改动

`packages/database/src/index.js`、`apps/web/src/server.js`，以及锁等待测试。没有新依赖，没有改新闻筛选、JEV、翻译或小时报/日报逻辑。

## 验证

写锁持有时，`authorizeToken` 不再等待 `last_seen_at` 写入；锁放开后的下一轮会写上，60 秒内不重复写；撤销后下一次鉴权立即失败。

## 遗留

Worker 里具体是哪几类写事务持锁超过 200ms，要等服务器日志。公网 HAR 里 edition 的 `Server-Timing` `total` 应落到 10ms 以内，这需要部署后才看得到。
