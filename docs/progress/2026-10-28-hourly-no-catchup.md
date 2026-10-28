# 小时失败补跑默认关闭

## 目标

额度消耗来自失败小时的补跑和重试，不是整点那一次 `report.hourly.default`。代码侧停掉失败补跑再次打模型。整点小时报、分类小时报、阅读分类和文章整理保持原样。

## 决定

- `ensureHourlyFailureCatchupSchedule` 在 `AI_CENTER_HOURLY_NO_CATCHUP` 未设置，或值不是 `0` 时，把 `report.hourly.failure-catchup` 写成 `enabled=0`。已经启用的同一条记录，Worker 启动时也会改成关闭。
- 同一条件下，调度器不把这条任务入队；处理函数返回 `no-catchup`；`enqueueDueFailedHourRefreshes` 直接返回空，不再创建 `report.hourly.extract`。
- 阅读分类 follow-up 先核对过。未失败小时的一次 `classification-deferred` / `edition-pending`，以及定时任务里的 `edition-pending-sweep`，仍是整点路径上的单次补齐，不连环，这次不切。已经失败且 `groupFailures` 仍可重试的那一小时，follow-up 会再入队一张小时任务并再打模型，这是重试放大器，默认不再入队。这一小时里的阅读分类第一次调用，以及未就绪来源的准备任务，仍然执行。
- `report.hourly.default` 仍是 `enabled=true`。`AI_CENTER_HOURLY_CATEGORY` 的分桶、Flash 和未标注路径不改。
- 回退：`AI_CENTER_HOURLY_NO_CATCHUP=0`，然后重启 Worker。补跑调度会重新写成启用，失败小时可以再次入队。

不新增 migration。当前 schema 仍是 97。下一号是 98。空号仍是 63、79、80、82。不要重建数据库。

只需要重启 Worker。页面没有改，Web 不用为这项重启。

## 验证

`node --test test/hourly-failure-catchup.test.js test/reading-hour.test.js test/hourly-disabled.test.js test/hourly-category.test.js`
