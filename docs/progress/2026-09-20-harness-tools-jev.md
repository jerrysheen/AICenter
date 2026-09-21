# 2026-09-20 Harness Ask 对齐 Domain Tool 与 Jev

在冻结 `dsh-base` 上继续原方案：不再只开放 `holdings.rank`。

## 决定

- 未设置 `AI_CENTER_HARNESS_TOOL_IDS` 时，Ask 的可见 Tool 与本地循环相同，并尊重 `webMode` / 研究档位。
- Jev Prior 仍在 Worker 侧 shadow/advisory；Evidence Gate 在 Tool Gateway 返回前过滤，Harness 模型看不到被拒条目。
- 文章阅读仍走本地 `AgentRuntime`。不接 Elucid Grok；Harness 只用 `DEEPSEEK_API_KEY`。
- 真机联调脚本：`node scripts/live-harness-ask.mjs`

## 验证

- `node --test test/harness-runtime.test.js`
