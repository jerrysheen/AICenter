# search.web 默认 Provider 切到 DeepSeek Native Search

## 目标

把 `search.web` 的默认 Adapter 从本机 SearXNG 换成 DeepSeek Native Search，不改 `web.search`、SourcePort、JEV Evidence Gate 或 Agent Runtime。

## 决定

- 新增 `DeepSeekSearchProvider`：用 `DEEPSEEK_API_KEY` 调 `https://api.deepseek.com/anthropic/v1/messages`，工具为 `web_search_20250305`，只解析结构化 sources。
- 不把 DeepSeek 生成的答案写入搜索结果。
- 启动不做 probe。缺 Key 不注册 `search.web`；401 / 403、无 `web_search_tool_result` 或请求失败时 `available: false`。不回退 Bing / DDG / SearXNG。
- SearXNG Connector 与本机脚本保留为 legacy，主链路不调用。

## 验证

- `node --test test/deepseek-search.test.js test/searxng.test.js test/source.test.js`
