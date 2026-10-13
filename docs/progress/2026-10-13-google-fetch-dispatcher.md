# Google 直连不再把 npm undici Agent 交给 Node fetch

`#83` 上线后原文翻译 440/440 失败。错误是 `TypeError: fetch failed`，原因 `InvalidArgumentError: invalid onRequestStart method`。`google-fetch.js` 用 npm undici 8.10.2 创建 `Agent`，再作为 `dispatcher` 传给 Node 22 内置 `fetch`。两套 undici 的 dispatcher 不兼容。

`googleFetch` 在走生产全局 `fetch` 时改为调用同一份 undici 的 `fetch`，只把这份 Agent 交给它。注入的测试 `fetch` 仍然原样返回。连接超时仍是 `connect.timeout`，默认 8000 毫秒，`AI_CENTER_GOOGLE_CONNECT_TIMEOUT_MS` 为 1000–30000。调用方的 `AbortSignal.timeout` 仍是响应预算。26B 默认池和 5xx / 连接超时换另一把 26B 密钥的重试不变。

配额探针同样改走 `googleFetch`，不再把 Agent 交给内置 `fetch`。

不新增 migration。需要同时重启 Web 和 Worker。不要重建数据库。
