# 领取循环不再因重排序号撞车而停住

日期：2026-10-14

## 线上

10-13 22:34 Worker 还在，但不再领任务。手动重排把 `jobs.attempt_count` 写成 0，`job_attempts` 的旧行留着。`claimNextJob` 仍插入 `attempt_number = attempt_count + 1`，撞上 `UNIQUE constraint failed: job_attempts.job_id, attempt_number`（`packages/database/src/index.js`）。异常没有接住，`createJobRunner.start()` 的循环退出，调度和其他定时器让进程继续空转。

同一时段，一条来源 id 为空的订阅在自动刷新里抛「source account metadata 缺少可重放参数」。失败后 5 分钟再试，大约每小时出现两次。

## 决定

- 领取序号是 `max(jobs.attempt_count + 1, 该任务已有 attempt_number 的最大值 + 1)`，并把它写回 `jobs.attempt_count`。完成和失败仍用这个序号匹配。
- 领取抛错时，错误带上已经选中的 `jobId`。循环记录 `[worker] claim failed`，调用 `failQueuedJob`。它只更新仍是 `queued` 的行；回滚后的任务还在排队，运行中的任务不动。然后等待一个轮询间隔再继续。`runOnce()` 仍把错误抛给调用方。
- 循环每轮开始记下时间。超过 `AI_CENTER_JOB_LOOP_WATCHDOG_MS`（默认 300000）没有进入下一轮，打一行 `[worker] job loop has not ticked for Ns`。恢复进入下一轮之前不重复打。
- `autoRefresh` 且 `sourceId` 为空或只有空白时，按订阅间隔 `deferSubscriptionSync`，结果 `status=skipped`、`reason=empty-source-id`。不调用 `refreshPersistedSource`，不计失败。有 id 但没有 `sourceInput` 仍抛原来的错误。
- 不新增 migration。

## 验证

`node --test test/domain-foundation.test.js test/runtime.test.js test/feed-automation.test.js` 中与领取、循环和空来源 id 相关的用例。

## 重启

需要重启 Worker。Web 不用为这项重启。不要重建数据库。
