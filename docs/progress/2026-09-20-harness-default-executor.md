# 2026-09-20 生产执行器改为 DeepSeek Harness

先前把 Harness 做成可选双跑、默认本地循环，理解偏了。产品要求：现在的 `AgentRuntime` 就是冻结 DeepSeek Harness；资料搜索以后在这套上加自己的插件，不另建执行器。

## 决定

- 未设置 `AI_CENTER_AGENT_RUNTIME` 时，Ask 与 `ai.article.analyze` 都走 `createHarnessAgentRuntime`。
- 注入 fake LLM 的测试仍走本地循环；显式回退是 `AI_CENTER_AGENT_RUNTIME=local`。
- 翻译 / 粗筛 Tag / 知识结构化仍用 Gemini，不经过 Agent 执行器。
- 不在本轮实现搜索插件。

## 验证

- `node --test test/harness-runtime.test.js`
- `node --test test/agent.test.js test/article-analysis-runtime.test.js`
