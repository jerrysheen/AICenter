# 任务详情按进展刷新并保住本地输入

## 目标

打开任务详情后能跟上 CLI 写入的 `progress.json` / `steps.jsonl`，不要只等 claimed/completed 这类状态 SSE。刷新或重绘时，投递框和「继续做」里还没提交的字要留下来。

## 决定

- 详情打开且状态是 `open` / `claimed` 时，每 2.5 秒走已有 `GET /api/v1/work-packages/:id` 与 `GET /api/v1/work-packages/:id/trace`（Contract → Service → TracePort），用 `progress.updatedAt` 和 steps 指纹决定是否重绘。
- 不新增 progress SSE，也不改 schema。终态后停表。
- 投递正文和按任务 id 的继续指令草稿写在页面 localStorage，重绘前先从 DOM 收一次，画完再填回去。

## 验证

- `test/work-package.test.js` 锁住轮询、草稿键和契约说明。
- 只改 `apps/web/public`、`docs`、`test`，立刻生效，不弹进程。
