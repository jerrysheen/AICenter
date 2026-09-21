# 2026-09-21 Elucid 路由下 web_search 走 Grok 原生搜索

主模型切到 Elucid Grok 后，内置 `web_search` 仍默认打 DeepSeek Anthropic 搜索。实测 Elucid `/responses` 已能返回 `web_search_call`，所以按官方 `ctx.web` 缝换搜索后端。

## 决定

- 模型侧仍只有 `web_search` + `web_fetch`。不加 `web_read`。Grok 搜索自己会跟读；精确 URL 继续走 HTTP `web_fetch`。
- `AI_CENTER_HARNESS_PROVIDER=elucid-grok` 时，子进程设置 `DSH_WEB_SEARCH_PROVIDER=elucid-grok`，由 overlay 插件 `web-search-elucid` 注册 Responses `{ type: "web_search" }`。
- 切回 `deepseek-official` 时仍钉 `deepseek-official`，避免两个 provider 同时可用触发 `WEB_PROVIDER_AMBIGUOUS`。
- 不把 Domain `web.search` 灌进 Gateway。不引入 Exa / Perplexity / 第三方搜索插件。

## 验证

- `node --test test/web-search-elucid.test.js test/harness-runtime.test.js`
