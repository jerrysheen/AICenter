# 2026-10-12 小时补跑推进未准备来源

`1923dce` 之后，补跑和回扫会按时启动，也不挡住当前小时。模型调用已经成功。待处理条数却不动：00:00 的补跑不到 1 秒，仍是 2 条；23:00 只有两次浓缩，没有分类，10 条变成 11 条；01:00 的 `edition-pending` 约 1 秒，25 条仍在。

## 原因

刊期 `pendingCount` 是 `pendingIds` 的长度，也就是这一小时的候选里还没有变成信息节点的来源。最常见的原因是 `information-not-ready`：没有匹配来源版本的准备阶段。它 `retryable` 为 false，也没有 `retryAt`，所以旧的回补不会重试。补跑调用的仍是这一小时的 `generateHour`，只浓缩已经有的节点，再把同一份未就绪清单发布出去，不排 `report.information.prepare`。信息准备一次一条，旧小时的优先级是 0，当前两小时才是 20/30。

20:00 当时有 1 条未处理。主小时若是 01:00，它仍在默认 6 小时窗口里。没被回扫是因为 `AI_CENTER_HOURLY_SWEEP_LIMIT` 默认 2，而且总是取窗口里最新的两小时。

## 补跑

带 `followUp` 的任务，以及定时任务本身，会为仍可准备的来源各入队一张信息准备。本小时新入队的优先级是 30，补跑和更早小时是 10，不高于当前小时已有的 20/30。已经排队的只向上抬到这个优先级。正在跑或已经排队的不重复入队。准备仍由 Worker 的 `informationPreparationLimit` 限制同时跑几条。

`needs-content`、`stale-policy`，以及同一准备阶段连续失败达到 `AI_CENTER_INFORMATION_PREP_ATTEMPTS`（默认 3）次的 `prep-exhausted`，原因留在刊期 `pending` 里，但不进入 `pendingIds`，也不再触发补跑或回扫。还没有失败阶段的 `information-not-ready` 不会因为被看过几次就变成终态。文章整理的 `article:` 阶段和 `information:` 阶段都会用来判断原因。

每次带 `followUp` 的任务用 `console.log` 写一行 `[worker] hourly-pending`：小时、原因、按待处理原因的计数，以及准备队列的排队、运行、缺失和本次入队数量。

## 回扫

窗口和每轮张数不变。窗口内的小时按主小时轮转，不再每次都拿最新的两小时。比窗口更早的不排。补跑不连环。本小时自己的补跑仍先入队。

需要重启 Worker。
