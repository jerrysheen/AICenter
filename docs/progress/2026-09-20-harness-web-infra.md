# 2026-09-20 公开互联网收回 Harness 基建

切到 DeepSeek Harness 后，第一阶段 overlay 把 `dsh-tool-web` 和 bash / fs / subagent 一起关了，再把 `web.search` 做成 Domain Tool。这把基建误当成了上层开关。

## 决定

- Ask / 文章阅读的公开互联网是 Harness 内置 `web_search` + `web_fetch`，始终完整可用。
- Domain Gateway 不再注册 `web.search`。不要再设计 `web.page.get` Domain Tool。
- `webMode` 在 Harness 上只改 Prompt 倾向，不隐藏联网工具。
- bash / fs / subagent 仍是 Host 工具，公网 Ask 继续关闭。
- Jev Evidence Gate 只过滤 Gateway 检索；内置 web 从 Session `tool/call` / `tool/result` 观察。
- Domain `web.search` 与 `search.web` Source 留给本地循环测试或显式 `AI_CENTER_AGENT_RUNTIME=local`。

## 验证

- `node --test test/harness-runtime.test.js`：18 通过，含内置 `web_fetch` 观测、Gateway 校验失败入轨迹。
- `node --test test/agent-quality.test.js test/article-analysis-runtime.test.js test/research-profile.test.js test/agent.test.js`：本地循环仍按 `webMode` 开关 Domain `web.search`；Final Guard 同时认 `web.search` / `web.fetch`。
