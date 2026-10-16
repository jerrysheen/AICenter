# 信息流按作者

2026-10-16。信息流增加「作者」页，只做捕获原生 id 和作者列表，不含标的。

雪球保留 `user.id`。没有 uid 的旧数据先记成临时作者 `xueqiu:@名字`，以后出现 uid 再合并。X 保留 `rest_id` 和头像；没有 `rest_id` 时用 `x:@handle`，旧 handle 记在 `aliases_json`。转发和引用算在转发人身上。B 站空间动态连同 `mid` 写入数据库，外部 id 是 `dyn:` 加动态 id。系统账号（雪球 7x24）`kind=system`，不出现在列表里。

migration 77 建 `authors`，并给 `captures` 加可空的 `author_native_id`。migration 78 建 `item_authors` 和 `author_stats`。两张表都是 `IF NOT EXISTS`，列用原来的 `addColumn`。76 仍是 `twse_monthly_revenue`。不要重建数据库。

未关注作者要近 30 天至少 2 条才出现。已关注的始终出现，并排在列表前面。关注存在服务端。`全部已读` 只标记这次请求开始时该作者最新一条及更早的内容，每 500 条提交一次。

`AUTHOR_VIEW` 默认开启。设为 `0` 会隐藏作者页和 `/api/v1/authors`。表留着。抓取仍会登记作者。

Web 和 Worker 都要重启。回填不要放进 Web 或 Worker，部署后在实例目录执行：

```text
node scripts/backfill-authors.mjs
node scripts/recompute-author-stats.mjs
node scripts/import-bilibili-dynamics.mjs --file <dynamics.jsonl>
```

`backfill-authors.mjs` 按 `captures.rowid` 每 500 行一批，批与批之间休眠，进度写在数据库旁边的 `author-backfill.json`，可以中断后继续。`recompute-author-stats.mjs` 给离线校正近 30 天计数，适合每晚跑一次。
