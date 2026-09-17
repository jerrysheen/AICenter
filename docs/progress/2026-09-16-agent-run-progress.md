# 问答过程进度

## 目标

问答卡片在「正在生成回答」时显示 Runtime 中间步骤，让用户知道当前在思考还是在读持仓/信息流。

## 决定

- 不改 Worker 循环、不新增 SSE。现有 JSONL trace 已有 `model.*` / `tool.*`。
- Web 轮询 `GET /api/v1/agent/runs/:id` 时附带压缩 `progress`。每步有短标签，另附最多 100 字的 `detail`（检索词、命中标题、持仓名称），不含完整 Tool data。
- 进行中的 `ai.agent.run` 仍由当前 Worker 执行，不必为这次改动重启 Worker。

## 验证

- `npm run check`
