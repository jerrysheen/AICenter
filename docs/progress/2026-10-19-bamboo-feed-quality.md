# Bamboo 上线后的采集和小时报

2026-10-19。截断预览不再因为 `input-truncated` 直接待审。预览带着截断标记送给 Bamboo 打分。判 KEEP 时元数据写 `bodyCompletion: pending`（正文待补全），这条 external id 不进入下次采集的已知集合，全文到了可以再评。确认缺失的线程、长文或关键媒体仍不打分。

小时报命中线按 provider 分开。Bamboo 默认 0.35，JEV 默认 0.5。`AI_CENTER_READING_HIT_BAMBOO`、`AI_CENTER_READING_HIT_JEV` 优先，共用兜底是 `AI_CENTER_READING_HIT_SCORE`，只接受 0 到 1。公司事件和市场行情会同时问 `CO_EVENT` 和 `FIN_MARKET`。`FIN_MARKET` 包含给出具体金额或条件、并影响市场的公司融资、资本开支、算力需求、产能或订单。模型没回答的组记为未评估；已经打出低于门槛的分仍是未命中。模型调用失败时，已归类的材料才用归类结果保底，成功的低分不改写。问法版本 `2026-10-19.1`，路由版本 `reading-route-2026-10-19.1`。

官方来源新导入的正文少于 80 个字，且没有已经放行的 KEEP，状态改为 captured，过滤原因 `body-too-short`，作者页也不显示。已经混入的空正文先回到原链接补正文，见 `2026-10-19-official-body-backfill.md`，不要先跑 `scripts/hide-short-official-items.mjs`。正文后来达到 80 字会清掉这条门闩。非官方媒体不走这道门。

关注流截断帖最多展开 16 条，推荐流截断帖最多 8 条，都不再先看 `selectFocusExpansions` 有没有选中。排序先看关注分，再看更长的正文。打分截止时间提前 45 秒留给展开。订阅同步的 AbortSignal 会立刻结束正在跑的 bsk 子进程；展开循环和等待看到中止就停。`feedSyncSourceTimeoutMs` 因此能在来源时限内结束同步，不再把一次约 700 秒的浏览器命令跑完。

同一工作区里，另一个正在跑的 `report.hourly.extract` 如果小时未写明或小时相同，后一次直接跳过。抢到加工租约之前的冲突不再把对方的检查点写成失败。Worker 启动时清掉浓缩树租约，重启后的任务可以接着已有检查点。事件循环延迟只在 `loopMaxMs` 超过 200 毫秒时打一行，不带任务内容。

不新增 migration。91 是硬件报价快照索引。下一号仍是 92。空号仍是 63、79、80、82。不要重建数据库。需要同时重启 Web 和 Worker。
