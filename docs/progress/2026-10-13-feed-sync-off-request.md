# 2026-10-13 请求不再做信息流和目录的同步重活

## 之前

`#76`（`3d47d0c`）上线后，bootstrap 收到的正文约 15.2KB，p50/p95 356/442ms，`loopMs` 329/433。事件循环 max 约 880–1137ms。点名任务里最大的是 `feed.x` 790–1086ms，接着是 `json.stringify` 250–900ms、`feed.xueqiu` 300–460ms、`events.flush` 260–390ms，另有一次 `client-timing` POST 575ms。`GET /api/v1/feed/x` p50/p95 876/1095ms，`/feed/xueqiu` 354/449ms。`GET /api/v1/reports/tree` p95 947ms，`loopMs` 885。

`feed.x` 这个名字只包住缓存填入和过期重读。better-sqlite3 是同步的，填入本身还在 Web 主线程上。页已经用 migration 59 的 `idx_captures_feed_sort` 在 SQL 里 `LIMIT`，不是缺分页，也不是请求里再做一遍去重。剩下的同步工作是：每次页都 `COUNT` 整个来源，水合时取出并解析整段 `metadata_json`，列表把译文全文读进内存，列表还 `JSON.parse` 信息节点里最多约 4 万字的正文。`reports/tree` 的 `view=index` 仍对刊期全文做 `json_extract`，客户端窗口用 `Date.now()`，按完整查询串做缓存对不上。bootstrap 的 15 秒缓存一到期，组包和序列化仍落在打中的那一次请求上。`events.flush` 一次写 5 条原始 `payload_json`。`client-timing` 正文上限 4KB，575ms 更像请求标签吃进了旁边的阻塞，没有单独再改。

## 决定

- Worker 每分钟跑已注册的 `feed.lists.snapshot`，把 X / 雪球关注流 `fields=list`、`limit=12` 的首页和已读头写入 `runtime_snapshots`（键 `feed-list-x`、`feed-list-x-read`、`feed-list-xueqiu`、`feed-list-xueqiu-read`）。90 秒内 Web 直接写出库里的 JSON 文本，不再 `JSON.parse` 再 `JSON.stringify`。刷新、收藏、别的 `limit` 或别的游标仍走原来的查询。
- 列表查询不再选出 `metadata_json`，只抽出 `authorHandle`。列表译文用 `substr` 取前 240 字。列表形状不再加载规范化文章，摘要仍用条目自己的 `summary`。打开全文的形状不变，仍核对正文哈希。全表条数单独缓存 60 秒；超过 4 条时，计数前和本地化前各让出一次事件循环。
- 过期缓存的重读改到 `setImmediate`，响应可以先写出。缓存带提前量：年龄进入到期前的 lead 就在后台重算。bootstrap 的 lead 是 `min(5000, ttl/3)`。组包按目录、每个小时、简报分段，段与段之间让出事件循环。
- migration 60 `tree_index_columns` 给刊期补 `edition_status`、`generated_at`、`start_at`、`end_at`、`root_count`，给信息头补 `window_start`、`window_end`、`validator_version`，并按现有 JSON 回填一次。列已填时目录查询用这些列；测试里只插入 `value_json` 的行仍走 `json_extract`。已执行的 migration 不改。
- `GET /api/v1/reports/tree`、`/tree/edition`、`/reports/reading-hour`、`/reading-hour/index` 缓存 15 秒已经序列化并 gzip 的缓冲区。目录和小时索引按小时桶分键，lead 5 秒。未知刊期或小时不放进长缓存。响应仍是 `Cache-Control: no-store`，不把个人目录交给 CDN。
- `events.flush` 每次改为 1 条。SSE 回放仍最多取 1000 条原始 `payload_json`。

## 之后

本机空闲夹具，不能当成线上 800ms 的复现。400 条 X、每条 8KB metadata：第一次列表 15ms，条数缓存命中后第二次 0.7ms，Worker 快照正文 5919 字节，且以 `{"ok":true,"feed":` 开头。192 个信息节点的目录索引 10971 字节、1.2ms、2 次查询；同一夹具的 reading 视图 11.39ms。首屏夹具仍是 20607 字节、gzip 1153 字节，组包加序列化 6.53ms。线上那次 790–1086ms 的 `feed.x` 填入不再出现在首页请求路径上；首页改读快照，其余页不再解析 metadata、译文全文和信息节点。

## 重启

需要同时重启 Web 和 Worker。Worker 写出第一份 `feed.lists.snapshot` 之前，首页仍走收窄后的实时查询。浏览器再加载一次。migration 60 只加列并回填，不要重建数据库。
