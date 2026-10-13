# 2026-10-13 请求不再等事件循环里的报价、雪球和事件帧

## 之前

`e4571fd` 上线后，bootstrap p50/p95 4/18ms，`GET /api/v1/feed/x` 290/366，`/feed/xueqiu` 311/1046，`reports/tree` p95 144。接口自己的工作已经是毫秒，剩下的时间在等事件循环。每分钟 max 0.85–1.31 秒，p99 46–85ms。点名任务：hardware-prices 请求上的 `json.stringify` 最高 1278ms，`feed.xueqiu` 240–975ms，`events.flush` 53–321ms，`feed.x` 约 300ms，`ui/revision` 一次 981ms。

`feed.xueqiu` 这个名字包住的是缓存未命中时的实时列表。页已经 `LIMIT`。慢的是 enforce 规则下对每行 `metadata_json` 做 `json_extract`。雪球正文进了 metadata，解析这几行就能占住几百毫秒。Worker 快照用的是任务开始时间，四个页面跑完经常已经超过 90 秒，Web 把快照当成过期，请求又做一遍实时查询。精选和 7x24 根本没有快照。全表 `COUNT` 有 60 秒缓存，不在这几百毫秒的同步段里。

硬件列表每次命中仍把带 `rawCells` 的对象再 `JSON.stringify` 一次。`events.flush` 已经一次一条，但一条 outbox 的 `payload_json` 仍整段读出并写出。`/api/v1/ui/revision` 对每个静态文件串行 `stat`，静态文件缓存命中也要先走一遍。

## 决定

- 列表投影去掉 `rawCells`，原单元格留在系列明细。Worker 每分钟跑 `hardware.prices.snapshot`，把 `limit=500`、不带分类的列表写入 `runtime_snapshots`。5 分钟内 Web 直接写出这份 JSON。其他查询在 45 秒缓存里放已经序列化的缓冲区，到期前约 10 秒后台重算。
- 雪球快照改用每一页写入时的时间，保留 10 分钟。关注、精选、7x24 的 `limit=12` 首页都写；关注另写已读头。
- migration 64 `capture_feed_filter_columns` 给 `captures` 增加 `author_handle`、筛选列和 `feed_filter_ready`，并加一条只覆盖未回填行的索引。迁移不解析历史 JSON。新的 `saveCapture` 直接写列。Worker 在做列表快照前，为 X 和雪球各回填最近两批、每批 10 行。列已填的列表用这些列；未填的行仍走 `json_extract`。63 不使用。
- `events.flush` 先读事件头和 `length(payload_json)`。超过 8000 字时用 `substr` 分段读出、分段写给订阅者，段与段之间让出事件循环。
- `/api/v1/ui/revision` 并行读取静态文件的 mtime 和大小。进行中的同一次计算合并。文件改动后下一次调用就会变。

## 之后

本机空闲夹具，不能当成线上 1278ms 的复现。80 条硬件、每条 24 个单元格：原文 517728 字节、序列化 1.62ms；去掉单元格后 166448 字节、1.06ms。30 条雪球、每条 4 万字 metadata：未回填的列表 4.2ms，回填后 1.2ms。400 条、8KB metadata 的列表第一次 25.5ms，条数缓存后 0.8ms，快照 5919 字节。线上那次 1278ms 的 hardware-prices 序列化不再出现在命中的请求路径上。雪球首页在快照 10 分钟内不再解析 metadata。

## 重启

需要同时重启 Web 和 Worker。Worker 写出第一份硬件快照和雪球快照之前，这两个接口仍走收窄后的实时查询。浏览器再加载一次。migration 64 只加列和索引，不要重建数据库。
