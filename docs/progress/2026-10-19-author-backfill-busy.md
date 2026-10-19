# 作者回填避开 SQLITE_BUSY

线上跑 `scripts/backfill-source-authors.mjs` 时出现两次 `SQLITE_BUSY`。回填把一批 capture 放进延迟事务，事务里先读再写作者。Worker 同时提交时，SQLite 拒绝把共享锁升级成保留锁，并且不调用 `busy_timeout`。

`backfillSourceAuthorBatch` 和 `repairAuthorPublishBatch` 改为 `apply.immediate()`，一进事务就拿保留锁。等待仍由连接上的 `busy_timeout`（5 秒）处理。索引和官方看板会调用的 `saveCapture`，以及 `noteCaptureAuthor`，也是先读后写，同样改为 `immediate()`。`markAuthorReadBatch` 和 `saveContentItem` 的事务第一条就是写，保持原样。

脚本可以重复跑，也可以从中断处继续。每批提交成功后，把 `phase`、游标和累计计数写到数据库文件旁边的 `source-author-backfill.json`。阶段是 `captures`、`index`、`official`、`publish`。事务失败时进度停在上一批。下次执行从这批之后继续。文件不存在、`phase` 为 `done`，或还是以前只在结束时写下的旧格式，就从头再走一遍。已挂上的作者不会多出一条。`--dry-run` 不读、不写进度。删掉该文件也会从头再跑。

不新增 migration。不要重建数据库。回填脚本用新代码再执行一次即可。正在运行的 Worker 要重启后，采集写入才会在事务开头拿保留锁。
