# 任务详情：goal / progress 与继续做

## 目标

投递任务立刻落下 goal 与 progress，任务卡可点进详情看状态和步骤拆解；详情里下新指令时带着旧任务开一个新 session。

## 决定

- 创建工作包时由 Knowledge Service 调用 Trace Port 写下 `goal.json` / `progress.json`，不等人领取。
- `#inspire/tasks/:id` 展示目标、进展、`steps.jsonl` 拆解和继续做输入框。
- `POST /api/v1/work-packages/:id/continue` 另建工作包，`parentWorkPackageId` 走 V24；正文带上一任务和上一结果。
- 新 session 仍走现有 `notify` / `work-package.dispatch`，不在收件箱对话里实现。

## 验证

- `test/work-package.test.js`：创建即有 goal/progress；continue 带旧指令并入队。
