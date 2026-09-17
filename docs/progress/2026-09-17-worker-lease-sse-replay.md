# Worker 租约回收、执行者校验、轮询监听器与 SSE 分页补发

## 目标

修掉会影响长期运行和状态一致性的四项问题。豆包仍保持**当前进程实例内** `DoubaoAskQueue`，不改成跨进程全局串行。

## 决定

1. Worker 启动时只回收租约已过期的 `running` 任务；`createJobRunner().start()` 再按间隔周期回收。不把全部运行中任务重置为 queued。
2. `completeJob` / `failJob` 必须同时匹配 `locked_by` 与 `attempt_count`。过期 attempt 的迟到结果不写 jobs、不写 outbox。领域 Handler 仍须自身幂等。
3. 空闲 `wait()` 在定时器正常结束和 abort 两条路径都移除 abort listener。
4. SSE 重连按页补发（默认每页 200、上限 10000）。触达上限且仍有后续事件时 `ready.snapshotRequired`，页面再拉 REST 快照。

## 改动

- `packages/database/src/index.js`：执行者校验；`recoverStaleJobs` 去掉 60s 下限，允许用观测时间计算 cutoff。
- `packages/runtime/src/job-runner.js`：周期回收；complete/fail 带 executor；`wait` 清理监听器。
- `apps/worker/src/worker.js`：把租约和回收间隔传给 runner。
- `apps/web/src/http/event-stream.js`、`apps/web/public/app.js`：分页补发与快照刷新。
- 测试：`test/domain-foundation.test.js`、`test/runtime.test.js`、`test/event-stream.test.js`。
- `docs/architecture.md`、`docs/ai-development-guide.md`、`.cursor/rules/jobs-events-migrations.mdc`。

## 未改

豆包 Web / Worker / CLI 仍各自建队列。长浏览器任务收回 Worker、跨进程同账号互斥留到后续。

## 验证

`npm run check`。
