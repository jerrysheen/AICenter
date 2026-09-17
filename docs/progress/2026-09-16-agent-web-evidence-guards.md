# Agent 时间 grounding 与 Web 证据约束

## 目标

不增加 Planner / 多 Agent，只给现有 Single Agent Runtime 加上不可违反的事实约束：当前时间、需要联网时必须尝试 `web.search`、禁止虚构 Tool 使用，并收窄 `market.global.get`。

## 根因与对应修改

1. 模型没有权威“今天” → 每轮注入 `Current UTC time` / `Current local time`（默认 `Asia/Shanghai`）。
2. `webMode=always` 只暴露工具、不保证调用 → `webEvidenceRequired` + 拒绝无 `web.search` 的 Final。
3. 回答可声称已搜网页 → 确定性 provenance guard。
4. `market.global.get` 被当成新闻工具，且 overview 投影只看 `sections` → 收窄 description；Global Board 真实字段在 `watchlist` / `groups`（利率、美债、黄金、原油），`projectGlobalMarketBoardForAI` 单独投影这些字段。
5. 搜索结果缺日期 → SearXNG `publishedDate` 标准化为 `publishedAt`，没有则为 `null`。

## 修改文件

- `packages/runtime/src/runtime-context.js`
- `packages/runtime/src/web-evidence.js`
- `packages/runtime/src/agent-runtime.js`
- `packages/runtime/src/local-tools.js`
- `packages/source/src/source-projections.js`
- `packages/source/src/market/definitions.js`
- `packages/connectors/src/searxng.js`
- `docs/architecture-modules-v1.md`、`docs/contracts-v1.md`、`docs/ai-development-guide.md`

## 测试

`test/agent.test.js`：显式搜索必须 Web、先调 market 也不能结束、虚构 web.search、unavailable 不无限重试、HBAO/持仓不强制 Web、provider 请求含本地时间、原始加息问题 fake trace。
`test/searxng.test.js`：`publishedAt`。
`test/local-tools.test.js`：global `watchlist` projection 与空结果 warning。

## Fake trace（原始问题）

```text
帮我搜今天的美国加息情况 / webMode=always
→ market.global.get（可选，不能结束）
→ Runtime 拒绝 Final
→ web.search
→ Final
```

不再接受：`market.global.get` → 空 `sections` → 声称已用 `web.search`。

需要 Web 证据且尚未调用时，Runtime 强制 Provider function calling（只允许 `web_search`），纠正时把被拒草稿留在 history。不再用兜底文案盖掉未搜索。
