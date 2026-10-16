# 信息流按作者

2026-10-16。信息流增加「作者」页，只做捕获原生 id 和作者列表，不含标的。

雪球保留 `user.id`。没有 uid 的旧数据先记成临时作者 `xueqiu:@名字`，以后出现 uid 再合并。X 保留 `rest_id` 和头像；没有 `rest_id` 时用 `x:@handle`，旧 handle 记在 `aliases_json`。转发和引用算在转发人身上。B 站空间动态连同 `mid` 写入数据库，外部 id 是 `dyn:` 加动态 id。系统账号（雪球 7x24）`kind=system`，不出现在列表里。

migration 77 建 `authors`，并给 `captures` 加可空的 `author_native_id`。migration 78 建 `item_authors` 和 `author_stats`。两张表都是 `IF NOT EXISTS`，列用原来的 `addColumn`。76 仍是 `twse_monthly_revenue`。不要重建数据库。

未关注作者要近 30 天至少 2 条才出现。已关注的始终出现，并排在列表前面。关注存在服务端。`全部已读` 只标记这次请求开始时该作者最新一条及更早的内容，每 500 条提交一次。

`AUTHOR_VIEW` 默认开启。设为 `0` 会隐藏作者页和 `/api/v1/authors`。表留着。抓取仍会登记作者。

Web 和 Worker 都要重启。历史回填不要放进 Web 或 Worker。Worker 会在每天凌晨 00:10（Asia/Shanghai，可用 `AI_CENTER_AUTHOR_STATS_AT` 调整）按作者重算近 30 天计数，每 500 个一批，批与批之间让出事件循环，并记下进度。部署后在实例目录按这个顺序执行：

```text
node scripts/backfill-authors.mjs --dry-run
node scripts/backfill-authors.mjs
node scripts/import-bilibili-dynamics.mjs --file <dynamics.jsonl>
node scripts/recompute-author-stats.mjs
```

没有现成的 B 站 jsonl 就跳过 import。`--dry-run` 只统计会写入的行数，然后回滚。正式 backfill 按 `captures.rowid` 每 500 行一批，进度写在数据库旁边的 `author-backfill.json`。`recompute-author-stats.mjs` 是上线后的一次校正；之后由 Worker 每天凌晨重算。

B 站空间采集默认走信息流过滤，不再固定写成 `ready` 进入主信息流。工作区来自 `--workspace`、`AI_CENTER_WORKSPACE_ID` 或实例，不在脚本里写死。这次没有加直通开关；要不要让空间动态不经筛选进入主信息流，留给之后决定。
