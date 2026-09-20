# 工作包 Cursor CLI 并行

## 目标

本地任务包不再一个 CLI 排队；同一 Worker 可以同时拉起多个 Cursor CLI，整体验收。

## 决定

- 只并行 `work-package.dispatch`，默认 3 路，可用 `AI_CENTER_WORKER_WORK_PACKAGE_CONCURRENCY` 覆盖（1–8）。
- 问答 `ai.agent.run` 和其他 Job 仍各一路，不抢同一个 Agent Runtime。
- 并发上限走 Contract `WorkerJobConcurrency`；Job Runner 按类型占槽后再 `claimNextJob`。
- 不新开 Worker 进程，不改领取/完成契约，不自己杀进程。

## 改动

- `packages/contracts/src/runtime.js`：`WorkerJobConcurrency`
- `packages/runtime/src/job-runner.js`：`start()` 按类型填槽
- `apps/worker/src/worker.js`：读环境变量
- 稳定文档同步默认 3 路 CLI

## 验证

`npm test -- test/runtime.test.js test/work-package.test.js test/contracts.test.js`
