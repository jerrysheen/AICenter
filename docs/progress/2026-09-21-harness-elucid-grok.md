# 2026-09-21 Harness 主模型接入 Elucid Grok

按 DeepSeek Harness 官方 LLM 配置接入 Elucid Grok，并收口成一条开关。

## 决定

- Ask 上层不再用 `AI_CENTER_AGENT_PROVIDER`。只看 `AI_CENTER_HARNESS_PROVIDER`：`deepseek-official` 或 `elucid-grok`。
- `$DSH_HOME/settings.yaml` 始终写入 `llm-deepseek` 和 `llm-pi-ai`（Elucid：`openai-responses` / `grok-4.6`）。Key 只引用环境变量名。
- 主循环、内置 `web_search` / `web_fetch`、本地回退和结构整理共用这一套。Gemini 只给翻译 / Tag。

## 验证

- `node --test test/harness-runtime.test.js`
