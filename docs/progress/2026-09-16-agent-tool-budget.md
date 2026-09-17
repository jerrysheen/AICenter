# Agent 工具预算与收敛

## 目标

科创板持仓问答两次撞上 `工具调用总数超过上限 6`，已有工具结果被整次 Run 丢掉。把工具预算和收敛规则改成 Runtime 契约，而不是只把上限调大。

## 决定

- `maxToolCalls` 6 → 12；`maxModelCalls` 仍为 7。
- 每轮把 `used / remaining / max` 交给模型（Grok / Gemini 写入 system/instructions）。
- 单轮请求超过剩余次数：整批不执行，写入 `tool.batch.skipped`，要求模型基于已有证据作答。预算耗尽 ≠ Run 失败。
- 收紧重叠 Tool 的描述；本轮仍暴露 `context.build`，不改成自动预取。

## 改动

- `packages/runtime/src/agent-runtime.js`
- `packages/runtime/src/local-tools.js`
- `packages/connectors/src/elucid-grok-agent.js`、`gemini-agent.js`
- `docs/architecture-modules-v1.md`

## 验证

- `npm run check`
