# Agent 基座：Single Agent 自己选 Tool

日期：2026-09-17

## 目标

拆掉 Runtime 在第一次 LLM 之前的硬编码 Web Router。模型每轮看到完整可见 Tool Table，自己决定直接回答或调用哪些 Tool。`@ref` 仍在进 Agent 前确定性解析，不改成 Tool。

## 决定

- Single Agent 负责 reasoning 和 Tool Selection；Runtime 负责 Tool visibility、权限、Schema、预算、并发、超时、`@ref` 确定性解析和 provenance validation。
- Runtime 不在模型首轮前执行 Intent Router。
- `webMode` 只控制能力是否可用与用户倾向：`off` 不暴露 `web.search`；`fallback` / `always` 都暴露，区别只在统一 System Prompt。`always + 今天` 不再等于必须 `web.search`。
- Final Guard 仍拒绝：声称联网但没有 `web.search`；`web.search` 不可用却声称查到公开事实；用户明确要求联网但整次 Run 没有调用 `web.search`。
- 新增只读 Tool `tag.list` 与 `feed.tag.search`。后者自己把「算力」解析到 `ai_compute`，用 Runtime 本地时区计算 `today`。
- Worker 先创建 TaggingService，再 `createLocalToolRegistry` / `createAgentRuntime`。
- `model.requested` trace 记录本轮 `visibleToolIds`，用来区分模型选错和 Runtime 没给对 Tool。

## 改动

- `packages/runtime/src/agent-runtime.js`、`web-evidence.js`、`agent-prompt.js`、`agent-trace-log.js`、`local-tools.js`
- `packages/domain/src/tagging-service.js`、`packages/database/src/repositories/tagging-repository.js`
- `packages/connectors/src/gemini-agent.js` / `elucid-grok-agent.js`：正常轮 AUTO，不再由 Runtime 发送 required tool choice
- `apps/worker/src/worker.js` 初始化顺序
- `docs/architecture-modules-v1.md`、`docs/contracts-v1.md`、`docs/ai-development-guide.md`

## 验证

`npm run check`

`npm test -- test/agent.test.js test/local-tools.test.js test/tagging.test.js test/gemini-agent.test.js test/elucid-grok-agent.test.js`
