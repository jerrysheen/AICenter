# 2026-10-14 问答联网搜索只走 Grok

2026-10-14 14:59 的问答任务 `9787b826` 里，`web.search` 打到 DeepSeek 搜索并收到 401。主模型已经是 Elucid Grok，子进程也设置了 `DSH_WEB_SEARCH_PROVIDER=elucid-grok`，但搜索仍走 DeepSeek。

## 原因

`@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 把插件 `web` 的 `searchProvider` 写成 `deepseek-official`。`@deepseek-ai/dsh-web` 用 `config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER`。配置已经有值，环境变量不会再生效。`packages/harness/aicenter.cordis.yml` 以前只插入 `web-search-elucid`，没有改这一行。

不改 `node_modules`。

## 决定

- 问答和同一条 Harness 上的公开 `web_search` 只使用 `elucid-grok`。主模型仍可以是 `deepseek-official` 或 `elucid-grok`。
- overlay 覆盖整个 `web` 行：`searchProvider` 由 `resolveHarnessWebSearchProvider()` 写入，结果固定是 `elucid-grok`；`fetchProvider` 仍是 `http`。patch 会替换整段 config，所以 fetch 要重写。
- `web-search-deepseek` 设为 `disabled: true`。`DSH_WEB_SEARCH_PROVIDER=deepseek-official` 也不会被采用，生成结果仍是 `elucid-grok`。
- 没有 `ELUCID_GROK_API_KEY` 或 `AI_CENTER_GROK_API_KEY` 时，Grok 搜索不可用，调用报错。不改走 DeepSeek 搜索，也不把 DeepSeek 的聊天密钥拿去打 Elucid。
- `web_fetch` 仍是 HTTP。不加 `web_read`。
- `web.search` 的 `tool.started` / `tool.completed` / `tool.failed` 写下 `searchProvider`。成功时是这次 overlay 强制的 `elucid-grok`。工具错误里如果是 DeepSeek 搜索（`DeepSeek API error` 或 `api.deepseek.com/anthropic`），记成 `deepseek-official`，用来发现又走回 DeepSeek。页面进度文案不写供应商。
- 显式 `AI_CENTER_AGENT_RUNTIME=local` 的本地循环仍使用原来的 Domain `web.search`。生产默认不是这条路径。

## 验证

- `node --test test/web-search-elucid.test.js test/harness-runtime.test.js`
- 本环境没有 `ELUCID_GROK_API_KEY` / `AI_CENTER_GROK_API_KEY`，没有做真实 Grok 问答。请求目标用假 fetch 核对：聊天模型是 DeepSeek 时，搜索仍 `POST https://hk.getelucid.com/v1/responses`，Bearer 用 Grok 密钥，模型是 `grok-4.7`。

## 重启

不新增 migration。不要重建数据库。需要重启 Worker，已经拉起的 dsh 子进程才会读到新 overlay。Web 不用为这项重启。浏览器不用重新加载。
