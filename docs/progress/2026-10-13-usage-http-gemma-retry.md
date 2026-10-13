# 2026-10-13 用量 HTTP 状态与 Gemma 500 重试

## 之前

`model_usage_index.http_status` 有 158 行是 null，集中在信息树和小时阅读分类。这两条路走 Harness，不走 `createUsageFetch`。成功的 `assistant/message` 把请求标成 succeeded，但不写状态码；`turn/end` 只在错误对象带 400–599 时才抄状态。模型执行超时也没有记成 408。

Gemma 原文翻译一段样本是 44 次成功、29 次 HTTP 500，大约四成。本环境没有这 73 行的生产库，对照的是代码和 2026-10-07 的 31B 诊断：短提示、`maxOutputTokens` 256、带或不带 `systemInstruction`，31B 都会返回 500 `Internal error encountered.`，同一次正式适配器上的 26B 成功。翻译输入已经按至多 2400 字符分段，超过 16000 字节会在发请求前拒绝。Worker 默认五个翻译执行位。诊断里的 500 是单次调用，不能证明是并发打满。

## 决定

- 成功的 Harness 请求、成功的整轮汇总，以及直连响应写 HTTP 200。供应商错误写响应状态码。`ModelExecutionTimeout`、`TimeoutError` 和「模型执行超时」写 408。排队超时、阶段预算超时、用户取消的 `AbortError` 保持 null。补读会话日志时保留已经记下的状态码，避免被重放冲掉。200 只补到成功或仍在等待的请求上，不把失败行改成 200。信息树和阅读分类走真实 Harness `run`，成功后 `model_usage_index.http_status` 不是 null。
- 字幕整理、音频转写的 `generateContent`，以及投资者对照实验的模型调用，改经 `createUsageFetch`。上传、轮询和删除文件不记成模型请求。没有用量观察者时仍然不写账本。
- 不增加 Flash、Grok 或 DeepL 回退。Gemma 的 HTTP 5xx、流内 5xx 和超时：记下输入字节、密钥后缀、耗时、当前路由器并发和脱敏响应体，把该密钥上的该模型冷却 60 秒，然后换另一把 Gemma 密钥或另一个 Gemma 模型。同一次 `generate` 最多 3 次 HTTP。退避 0.5 秒起、封顶 2 秒。下一席若不能在约 1.5 秒内排上，抛出原来的上游错误，任务级最多 4 次重试照旧。429 和日配额不在同一次请求里重试。默认并发保持 5。

## 改动

- `packages/harness/src/model-usage-observer.js`、`packages/harness/src/harness-agent-runtime.js`
- `packages/connectors/src/model-usage-fetch.js`、`packages/connectors/src/translate/gemma.js`
- `packages/connectors/src/bilibili/format.js`、`packages/connectors/src/audio-transcribe.js`、`packages/connectors/src/investor-digest-ab-model.js`
- `packages/runtime/src/gemini-article-admission.js`：探针超时记 408

## 验收

不新增 migration。63 仍然空着，64 是 `capture_feed_filter_columns`，下一次新迁移追加为 65。不要重建数据库。需要同时重启 Web 和 Worker：信息树、阅读分类和 Gemma 翻译在 Worker，Ask 和部分翻译入口在 Web。
