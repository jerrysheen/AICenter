# Gemma 默认只用 26B，Google 连接超时单独计时

2026-10-13 16:00 之后 2054 次原文翻译里 877 次失败（43%），860 次是 HTTP 500 `INTERNAL`。这和 2026-10-07 的诊断一致：`gemma-4-31b-it` 在短提示上也会返回 `INTERNAL`。同一天到 `generativelanguage.googleapis.com` 有 201 次 `UND_ERR_CONNECT_TIMEOUT`。本机没有生产库，以上是用户给出的线上计数。

## 决定

`AI_CENTER_GEMMA_TRANSLATION_MODELS` 的默认值改为只有 `gemma-4-26b-a4b-it`。`gemma-4-31b-it` 仍可通过环境变量或测试注入加入第一次请求的轮换。未设置时不再请求 31B。

5xx、流内 5xx、`TimeoutError` 和连接超时把当前密钥上的当前模型冷却一分钟，然后在同一次 `generate` 里最多再试两次。池里还有 26B 时，重试只换另一把密钥上的 26B，不再转到 31B。环境变量如果只写了 31B，重试才在 31B 上换密钥。约 1.5 秒内没有空闲席位就抛出原来的上游错误。429 仍不在同一次请求里重试。不回退 Flash、Grok 或 DeepL。翻译并发默认仍是 5。

直连 Google Generative Language API 的 `fetch` 增加 undici `Agent` 的 `connect.timeout`。默认 8000 毫秒。`AI_CENTER_GOOGLE_CONNECT_TIMEOUT_MS` 接受 1000–30000 的整数。这是 TCP 连接预算，响应体仍用各调用点原来的 `AbortSignal.timeout`。连接超时在用量账本记 408。注入的测试 `fetch` 不挂这个 dispatcher。不替换 undici 全局 dispatcher。Harness / `dsh` 自己的 HTTP 客户端不走这个 Agent。

覆盖的直连点：Gemma 翻译、Gemini 任务路由、Gemini Agent、字幕整理、音频转写、投资者讨论 / JEV / 对照实验，以及配额探针。投资者讨论和 JEV 在连接超时时换下一把已配置的密钥。探针把连接超时记为 408，不因此解除冷却。

## 重启

不新增 migration。63 仍空着，64 是 `capture_feed_filter_columns`，65 是 `outbox_payload_bytes`。下一次新迁移从 66 起。不要重建数据库。

需要同时重启 Web 和 Worker。Worker 跑原文翻译和配额探针；Web 上的 Gemini 直连同样使用新的连接超时。没有新的页面脚本。
