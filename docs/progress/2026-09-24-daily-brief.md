# 2026-09-24 Daily Brief

确定性 DailyReport 之后增加封闭上下文的注意力筛选。DailyReport 仍是事实层；DailyBrief 只从候选池里选 0–8 条，并把 `candidateId` 回填成候选上的 `sourceRefs`。

- `agentRuntime.run({ closedContext: true })` 把 Domain 目录和 Gateway allowlist 置空，并用单独的 Cordis overlay 禁用 `tool-web`。空 `allowedToolIds` 的旧语义不变。
- 候选池是纯函数：策略变化、策略、行情、官方发布、日程优先，新闻按 `eventAt` 补满，上限 120 条 / 80KB。前一日没有快照，或前一日 regime 为 `UNKNOWN`，不生成 strategy-transition。
- `report.daily.generate` 成功后入队 `report.daily.brief.generate`。Brief 按 workspace + reportId 更新同一行，并保存当时的候选快照。
- JEV 不进入这条生成链。
