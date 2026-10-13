# 2026-10-13 信息流查询、TrendForce 列表与客户端计时

## 目标

生产访问日志里，`GET /api/v1/feed/x` 稳定约 2.6 秒、`GET /api/v1/feed/xueqiu` 约 1.9 秒，响应只有 1–15KB。`GET /api/v1/feed/trendforce` 每次未压缩约 670KB。`client-timing.js` 返回 200，但 `data/logs/client-timing.*.log` 一直是空的。同一时段行为事件只在整页刷新时出现，且 `feed.loaded` 的 `count` 为 0。

## 决定

- migration 59 只新增索引：`captures` 的工作区、来源、账号与 `captured_at`，过滤用的 `filterMode` / `filterDecision` / `filterApplied`，以及 `content_items(capture_id, workspace_id, id)` 和 `user_item_states` 的隐藏、已读、收藏。不改已有 migration，不重建数据库。
- X / 雪球列表先按未读、已读各走一遍索引取本页 id，再只读这一页的正文。排序、总数、未读在前和 `fields=list` 的字段与原来一致。已读游标只取已读分区，刷新后已读仍能接在未读页后面。没有过滤字段的行仍算可见；`json_extract` 缺字段不再把整页滤掉。关联查询仍是按页批量，不按行再查。
- `GET /api/v1/feed/trendforce` 固定 `fields=list`：摘要字段，不含正文和段落。全文仍走 `GET /api/v1/feed/media/article`。响应带弱 ETag，忽略 `fetchedAt`；`If-None-Match` 命中且没有正在排队的抓取时返回 304。前端保存 ETag，304 不再解析正文，也不再额外拉媒体列表。
- 客户端计时在 `load` 已结束时立即排一次，从往返缓存恢复时再报一次。`sendBeacon` 和回退 `fetch` 都用 `text/plain;charset=UTF-8`，避免 JSON 媒体类型被浏览器收下后丢掉。超长时先丢掉最慢资源之外的条目，而不是整包放弃。`Sec-Fetch-Site: same-origin` 或 `X-Forwarded-Host` 与来源主机一致时仍写入；跨站和 `same-site` 继续丢弃。
- 行为事件合并后约 0.8 秒用 `sendBeacon` 发出，不挡住界面。`feed.loaded` 的 `count` 改为当前可见信息条数。另记页签切换、打开文章、分享、切换小时、展开、点击「原文」、提问，以及路由到渲染超过约 1 秒的 `view.slow`。
- 页面不包含 Cloudflare Web Analytics。静态 HTML 若带有 `cloudflareinsights` 或 `data-cf-beacon` 脚本，发出前会删掉。`script-src 'self'` 本来也会挡住它。

## 改动

- `packages/database/src/migrations.js`、`packages/database/src/repositories/feed-repository.js`
- `packages/domain/src/feed-service.js`、`packages/contracts/src/index.js`
- `apps/web/src/routes/feed-routes.js`、`apps/web/src/routes/identity-routes.js`
- `apps/web/src/http/access-log.js`、`apps/web/src/http/static-files.js`
- `apps/web/public/app.js`、`client-timing.js`、`information-tree.js`、`brief-page.js`
- `test/feed-query-perf.test.js`、`test/behavior-events.test.js`、`test/access-log.test.js`、`test/static-files.test.js`、`test/contracts.test.js`

## 验证

- `node --test test/feed-query-perf.test.js test/feed-qa-fixes.test.js test/feed-list-pagination.test.js test/feed-all-progressive.test.js test/behavior-events.test.js test/access-log.test.js test/static-files.test.js test/contracts.test.js test/feed-value.test.js test/api-tokens.test.js test/hardware-prices.test.js`
- 停在 schema 57 的库会先补 migration 58 `runtime_snapshots`，再补 59 的五个索引，`user_version` 与 `schemaVersion` 都是 59。

## 遗留

需要重启 Web。migration 58 是 `runtime_snapshots`，本项索引是 migration 59。59 在 Web 启动时建索引，建索引期间 SQLite 会短时间锁写。Worker 不提供这些 GET，不必为这项单独重启；自动部署若发现 `apps/web/src` 有变化，仍会按原规则同时重启 Web 和 Worker。只替换 public 文件不会换上新的查询和 304。若边缘节点仍注入 Cloudflare Web Analytics，需要在 Cloudflare 控制台关掉自动安装。
