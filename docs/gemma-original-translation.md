# Gemma 原文翻译

2026-10-07 用户授权纯原文翻译接入 Gemma 31B 和 26B（用户确认最初的“24B”指 26B）。该职责独立于 Article Normalize、Tag、小时和日报；仅本翻译链路不消耗其他模型额度，不表示其他业务停用原模型。

## 路由和执行

`createTranslateService` 默认使用 `packages/connectors/src/translate/gemma.js`，仅允许 `gemma-4-31b-it` 和 `gemma-4-26b-a4b-it`。通过 Google 官方 `streamGenerateContent?alt=sse` 请求，`thinkingLevel: minimal`、输出上限 2048；逐项逐段翻译，不要求模型生成批量 JSON。思考正文省略，流内错误、缺少 STOP、空输出或截断不能成为成功译文。

`AI_CENTER_GEMMA_TRANSLATION_MODELS` 默认依次包含两个模型、按请求轮换；用户后续授权五账号翻译池，`AI_CENTER_GEMMA_TRANSLATION_KEY_ENVS` 默认包含 `GEMINI_API_KEY` 至 `GEMINI_API_KEY5`，缺失和重复凭据跳过。显式旧 `AI_CENTER_GEMMA_TRANSLATION_KEY_ENV` 仍可固定一个账号，多账号配置优先。缺凭据或失败不回退 Flash、Grok、DeepL 或其他 API。Router 注入仅用于测试。

复用 `ModelQuotaRepository`，按密钥/显式项目和模型保存租约和冷却。用户后续授权移除本地每日/小时请求数上限，每账号两个 Gemma 模型共用最小 10 秒发起间隔、每分钟最多 10 次，理论每账号约 6 次/分钟；五账号理论约 30 次/分钟。16K 输入 TPM 仍按模型预留，UTF-8 字节数作为保守输入 Token 估算，不记为实际用量。同项目 Key 共用节流；跨模型节奏在同一 Repository 事务内检查并保存，重启不能绕过。分钟窗口本地最多等待约 61 秒，其他配额等待按 retryAt 延期。供应商 429 持久冷却；5xx、流内错误和超时另作一分钟可用性退避，不称额度耗尽。本地无每日上限不代表供应商承诺无限额度。

`WorkerJobConcurrencySchema.translationLimit` 默认 1，最大 5；Worker composition root 默认通过 `AI_CENTER_WORKER_TRANSLATION_CONCURRENCY=5` 启用五个翻译执行位，仅影响 `feed.translation.run`，不增加 Ask、小时报等任务并发。使用同一 Connector 与现有注册 handler，不增加 Agent。失败状态另表保存，见 migration 50。

每次实际 HTTP 尝试沿用用量账本，缺失用量保持未知。新的翻译任务最多 4 次尝试，退避从 1 秒起按指数增加，单次间隔不超过 5 分钟；次数用尽后停在失败，不再无限重试。31B 失败冷却后可用 26B 接续。任务租约过期同样记失败并退避，不把条目留在进行中。只有完整有效译文才通过现有 Feed Repository 落库，与 Outbox 同事务。上游 HTTP 失败在 Worker 日志记录状态码和响应体，不记录密钥。

## 排版和缓存

保留原文标题、段落、列表、表格和脚注关系，完整翻译，不生成摘要；提示明确要求保留金额、否定、且/或条件、比较基准和不确定性。长输入按至多 2400 字符分段，保持原始字符和 Unicode 边界，全部完成后合并。媒体沿用现有逐段稳定 ID 与原文哈希。

旧译文和原文保留，已保存的相同 workspace/ID/原文哈希直接复用。信息流在调用翻译前先读取小时报信息节点里已有的中文标题，以及相同原文哈希的既有译文。Feed 既有每项 20000 字符输入、8000 字符译文存储限制保持；超限 Feed 项不会阻断中文整理，媒体全文通过分块覆盖。不能把原文前缀当全文保存。未执行全历史补译。

新采集内容通过现有 enrich handler 独立排队 `feed.translation.run`；中文整理继续原路径，小时/日报继续消费原有投影。这些其他业务仍使用原模型预算。

后续小时报已独立接入 Google Harness，原文翻译仍只走本 Connector；小时报配额和内容验收见 `progress/2026-10-07-gemini-hourly.md`。

## HTTP 和 Worker

`POST /api/v1/translate`、`/api/v1/translate/batch` 返回 202 / jobId，模型任务进入已注册 Worker handler。`GET /api/v1/translate/jobs/:id` 仅返回同 workspace/type 的状态和完成结果，不返回 Job 输入或内部错误。页面适配等待结果，旧客户端需刷新静态资源或适配 202。SSE 复用现有 Job/译文事件与重放。

本轮未改 Harness、主文章模型池、Tag、小时/日报预算或已执行 migration。失败状态随后由 migration 50 追加，不改写已执行迁移。外部能力由 Connector 适配，业务写入仍经 Service/Repository。

## 验收限制

31B 诊断曾通过流式基础响应和两次短段翻译，新适配器实测仍出现 500/流内错误，不能称已稳定。26B 新适配器的英文标题、表格、条件列表样本完整响应并落库，人工核对数字和条件正确；不推广为所有长文质量通过。官方规则：<https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api>。
