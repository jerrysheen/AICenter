# 2026-09-20 Harness 会话复用、实时 Trace 与 Final Guard

Ask 在冻结 `dsh-base` 上继续对齐本地 Runtime 的确定性边界，不改 0.2.0 默认 `local`。

## 决定

- Worker 在可见 Tool 集合不变时复用同一个 `dsh` 子进程。同一 `sessionId` 的后续轮次只发送新用户消息，把对话状态交给 Harness Session。
- `webMode` / 研究档位 / allowlist 变化时重启子进程，避免模型看到不该出现的 Tool。
- `session.event` 在回合进行中写入 agent-trace-log；结束后再补投影，避免只在收尾才出现 `tool.started`。
- 最终回答走与本地循环相同的 `resolveFinalAnswer`：虚构 `web.search` 或明示要搜却没搜，纠正一轮；仍不合格则失败。
- 文章阅读仍走本地 `AgentRuntime`。

## 验证

- `node --test test/harness-runtime.test.js`
- `node scripts/live-harness-ask.mjs` 调用 `holdings.rank`（空账本返回 0 条）
