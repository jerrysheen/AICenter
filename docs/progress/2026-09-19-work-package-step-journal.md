# 2026-09-19 工作包步骤账本

Worker 领取任务包后，先用 `sha256(id)` 前 12 位作为 `hashId`（派生，不改 schema），在 Instance `logs/work-packages/<hashId>/` 写下 `prompt.txt`、`meta.json`，并往 `steps.jsonl` 追加领取行。提示词要求 CLI 每完成一步再追加一行 JSON，不改已有行。`GET /api/v1/work-packages/:id/trace` 反查。任务卡显示 hashId 和最后一步。

`hashId` 不是数据库列。V22 保持不变。
