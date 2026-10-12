# 2026-10-12 旧刊期待处理回扫

`9e585a4` 之后，60 秒补跑只对准当次主小时，而且带 `followUp` 的任务不再排下一张。23:00 刊期留下 10 条未处理、20:00 留下 1 条时，00:43 之后没有任务再去看这两小时。

## 回扫

每次定时小时任务先完成本小时，并先排本小时自己的补跑。然后在最近 `AI_CENTER_HOURLY_SWEEP_HOURS`（默认 6）小时里，找刊期 `pendingCount>0` 或阅读分类仍是 `classification-failed` / `budget-deferred`、且没有排队或运行中小时任务的小时。按从新到旧最多再排 `AI_CENTER_HOURLY_SWEEP_LIMIT`（默认 2）张，原因是 `edition-pending-sweep`，优先级低于本小时。比这个窗口更早的小时不排。这张补跑自己再跑时不再排下一张。查找失败不会挡住本小时。

## finishReason

`[worker] tree-hourly` 的 `finishReason` 写完整枚举，例如 `max-tokens`、`SAFETY`、`stop`，或调用上带的完整结束原因。不再截断。只有 `body` 和 `message` 先脱敏，再留前 300 字。

需要重启 Worker。
