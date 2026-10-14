# Gemma 原文翻译

2026-10-07 用户授权纯原文翻译接入 Gemma 31B 和 26B（用户确认最初的“24B”指 26B）。该职责独立于 Article Normalize、Tag、小时和日报；仅本翻译链路不消耗其他模型额度，不表示其他业务停用原模型。

## 路由和执行

`createTranslateService` 默认使用 `packages/connectors/src/translate/gemma.js`，仅允许 `gemma-4-31b-it` 和 `gemma-4-26b-a4b-it`。通过 Google 官方 `streamGenerateContent?alt=sse` 请求，`thinkingLevel: minimal`、输出上限 4096；逐项逐段翻译，不要求模型生成批量 JSON。思考正文省略，流内错误、缺少 STOP、空输出或截断不能成为成功译文。

`AI_CENTER_GEMMA_TRANSLATION_MODELS` 默认只有 `gemma-4-26b-a4b-it`。`gemma-4-31b-it` 仍是合法模型，显式写入环境变量或测试注入后可以参加第一次请求的轮换；未设置时不再调用 31B。用户后续授权五账号翻译池，`AI_CENTER_GEMMA_TRANSLATION_KEY_ENVS` 默认包含 `GEMINI_API_KEY` 至 `GEMINI_API_KEY5`，缺失和重复凭据跳过。显式旧 `AI_CENTER_GEMMA_TRANSLATION_KEY_ENV` 仍可固定一个账号，多账号配置优先。缺凭据或失败不回退 Flash、Grok、DeepL 或其他 API。Router 注入仅用于测试。

复用 `ModelQuotaRepository`。五把密钥在五个 Google 项目里，本地按密钥节流；同一个 `PROJECT` 仍共用一份节奏。账号之间按当日已用次数和上次请求时间均衡，五把密钥仍可以在同一次调度里同时发出。默认池只有 26B，`thinkingLevel` 保持 `minimal`。重试不加 31B：只要配置里还有 26B，重试只走 26B。配置被显式收成只有 31B 时，重试才留在 31B。每个密钥的本地限额：

| 限额 | 默认 | 环境变量 | 允许范围 |
| --- | --- | --- | --- |
| 可重试状态码 | 500,502,503,408 | `AI_CENTER_GEMMA_TRANSLATION_RETRY_STATUSES` | 400–599 的整数，逗号分隔；空或无效时回到默认 |
| 每分钟请求 | 25 | `AI_CENTER_GEMMA_TRANSLATION_REQUESTS_PER_MINUTE` | 1–60 |
| 同密钥间隔下限 | 2000 毫秒 | `AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS` | 0–120000 |
| 同密钥间隔上限 | 3000 毫秒 | `AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS` | 0–120000，小于下限时抬到下限 |
| 退避基数 | 10000 毫秒 | `AI_CENTER_GEMMA_TRANSLATION_BACKOFF_BASE_MS` | 0–600000 |
| 退避上限 | 40000 毫秒 | `AI_CENTER_GEMMA_TRANSLATION_BACKOFF_CAP_MS` | 0–600000，小于基数时抬到基数 |
| 同一次生成的最大重试 | 2 | `AI_CENTER_GEMMA_TRANSLATION_MAX_RETRIES` | 0–8 |
| 每分钟 Token | 16000 | `AI_CENTER_GEMMA_TRANSLATION_TOKENS_PER_MINUTE` | 1–16000 |
| 每个太平洋日请求 | 14400 | `AI_CENTER_GEMMA_TRANSLATION_REQUESTS_PER_DAY` | 1–14400 |

未填或不是整数时用默认值，超出范围的整数收进上表。同密钥两次请求的间隔在下限和上限之间随机取整毫秒，默认 2–3 秒。这个随机值记在进程内。配额表持久保住的是下限，所以重启后下一跳至少相隔下限。每分钟最多 25 次也按密钥计算。

Token 只按响应里的 `usageMetadata` 记账。有 `totalTokenCount` 就用它；没有总数时用 `promptTokenCount` 加 `candidatesTokenCount`。没有用量就记 0，不按 UTF-8 字节估算。失败响应里若带 `usageMetadata`，同样记入这一次预留。每分钟 Token 上限只累计已经记下的实际用量。31B 只在显式加入模型池后参加第一次请求；间隔、每分钟请求、每分钟 Token 和每日次数仍按密钥把 31B 和 26B 算在一起。分钟窗口本地最多等待约 61 秒。跨模型节奏在同一 Repository 事务内检查并保存，重启不能绕过。

供应商 429 或配额耗尽仍按 Google 给出的重试延迟冷却该密钥上的该模型，同一次请求不换密钥。每日配额冷却到下一个太平洋零点。HTTP 状态落在可重试列表里时不写冷却表，立刻换下一把密钥。默认列表是 500、502、503、408。响应超时和 Google 连接超时按 408 计入这个列表。列表外的状态不换密钥。同一次 `generate` 的重试次数默认 2。同一密钥连续出现可重试错误时，进程内退避从基数开始，之后每次翻倍，直到上限；默认是 10 秒、20 秒、40 秒。成功后清零。这不是配额冷却，重启后不保留。日志写 `[worker] Gemma 翻译上游 500 退避`。只有每分钟请求、每分钟 Token、每日上限、同密钥间隔或 429 冷却让席位排不上时，才抛出 `Gemma 翻译等待配额窗口`。上游退避超过本次准入时限时，抛出 `Gemma 翻译上游 500 退避`。下一席约 1.5 秒内排不上就抛出原来的上游错误，交给任务级最多 4 次重试。不回退 Flash、Grok、DeepL 或其他 API。

直连 `generativelanguage.googleapis.com` 使用 npm `undici` 自己的 `fetch` 和同一份 `Agent` 的 `connect.timeout`，默认 8000 毫秒，由 `AI_CENTER_GOOGLE_CONNECT_TIMEOUT_MS` 配置（整数，1000–30000）。不把这份 Agent 交给 Node 内置 `fetch`。这是 TCP 连接预算，和响应的 `AbortSignal.timeout`（Gemma 默认 180 秒，`AI_CENTER_GEMMA_TRANSLATION_TIMEOUT_MS`）分开。连接超时记用量 HTTP 408，并按上面的规则换密钥。不替换 undici 的全局 dispatcher。Harness / `dsh` 自己的 HTTP 客户端不走这个 Agent。

`WorkerJobConcurrencySchema.translationLimit` 默认 1，最大 5；Worker composition root 默认通过 `AI_CENTER_WORKER_TRANSLATION_CONCURRENCY=5` 启用五个翻译执行位，仅影响 `feed.translation.run`，不增加 Ask、小时报等任务并发。使用同一 Connector 与现有注册 handler，不增加 Agent。失败状态另表保存，见 migration 50。

每次实际 HTTP 尝试沿用用量账本，缺失用量保持未知。新的翻译任务最多 4 次尝试，退避从 1 秒起按指数增加，单次间隔不超过 5 分钟；次数用尽后停在失败，不再无限重试。任务租约过期同样记失败并退避，不把条目留在进行中。只有完整有效译文才通过现有 Feed Repository 落库，与 Outbox 同事务。上游失败在 Worker 日志写一行：`status`、`model`、密钥后缀（`KEY` / `KEY2`）、`inputBytes`、`latencyMs`、当前路由器上的 `concurrency`，以及脱敏后的 Google 响应体。不记录密钥本身。长文按 `AI_CENTER_TRANSLATION_CHUNK_CHARS` 分段，默认 1500，允许 400–2400。每一段另加约 286 字的翻译说明（系统说明 263 字，加上「原文数据」包装 23 字），1500 字的段大约 1786 字。整篇正文不会放进同一次请求。每一段写一行 `[worker] translation-chunk item=… chunk=i/n chars=… requestChars=… latencyMs=… status=ok|retry|error|cached`。`chars` 是这一段原文，`requestChars` 含说明。Token 在响应返回后按 `usageMetadata` 记账，不在发请求前按字节估算拒绝。单次响应超时默认 180 秒，由 `AI_CENTER_GEMMA_TRANSLATION_TIMEOUT_MS` 配置（120000–300000）。连接超时仍分开计算。2026-10-07 的 31B 诊断在短提示上也会返回 HTTP 500 `INTERNAL`。2026-10-13 16:00 之后 2054 次翻译里 877 次失败（43%），其中 860 次是 HTTP 500 `INTERNAL`，与 31B 留在默认轮换里相符。默认池因此只保留 26B。同一天到 `generativelanguage.googleapis.com` 有 201 次 `UND_ERR_CONNECT_TIMEOUT`，所以连接超时单独设短预算，并在 26B 上换密钥。默认五个翻译执行位没有证据需要下调。不回退到其他模型家族。

## 排版和缓存

保留原文标题、段落、列表、表格和脚注关系，完整翻译，不生成摘要；提示明确要求保留金额、否定、且/或条件、比较基准和不确定性。长输入按上面的段长切开，优先落在换行或空格，不拆开半个 Unicode 字符。各段译文用一个空行接上，不会把后半篇再送进同一次请求。一段失败时，多段正文在这一段上再试两次（先等 12 秒，再等 30 秒），只针对 5xx、超时和未完整结束；429 不在这里重试。已完成的段写入 `feed_translation_chunks`（migration 67）。任务失败后下一次尝试仍读入整篇，但按原文哈希和段序号接上，不再请求已经完成的段。进程内相同文本也不重复请求。全文译文落库时删掉这些段。只有一段的短帖仍只走原来的换密钥重试，不额外等待 12 秒。媒体沿用现有逐段稳定 ID 与原文哈希。

旧译文和原文保留，已保存的相同 workspace/ID/原文哈希直接复用。信息流在调用翻译前先读取小时报信息节点里已有的中文标题；同一原文哈希只复用引擎为 hourly-report 的译文，不拿别的条目的 Gemma 译文顶替。2026-10-14 起，Feed 原文和译文的契约上限从 20000 / 8000 改为 20 万字符，列类型本来就是 TEXT，不新增 migration。入队不再因为正文超过 2 万字而跳过；翻译按上面的段长分段后合并，保存的是全文译文和全文哈希。不能把原文前缀当全文保存。超过 20 万字的正文仍不入队。Worker 每次启动最多补入 80 条，由 `AI_CENTER_TRANSLATION_BACKFILL_LIMIT` 配置（0 关闭，大于 80 仍按 80）。日志写 `[worker] translation-backfill enqueued=N limit=M scanned=…`，并带上 `cjk`、`flash`、`hidden`、`too-long`、`translated`、`failure`、`hourly-title`、`stale`、`other-provider`。`stale` 和 `hourly-title` 仍会入队。有条数时最多带 8 个 id。手动命令 `node --env-file=.env scripts/backfill-feed-translations.mjs [--limit 80]` 同样只入队，并打印同样的计数。已有未完成的相同任务不重复创建，快讯来源跳过。每个密钥每个太平洋日最多 14400 次。长文按 1500 字分段，启动补译仍最多 80 条。只有正文哈希对得上的译文才算译完。列表上的短标题，以及小时报标题被存成整篇译文的情况，都会重新入队。汉字满 12 个只在 280 字以内或汉字占主导时当作中文；长篇英文里夹几句中文仍要翻译。

新采集内容通过现有 enrich handler 独立排队 `feed.translation.run`；中文整理继续原路径，小时/日报继续消费原有投影。这些其他业务仍使用原模型预算。

后续小时报已独立接入 Google Harness，原文翻译仍只走本 Connector；小时报配额和内容验收见 `progress/2026-10-07-gemini-hourly.md`。

## HTTP 和 Worker

`POST /api/v1/translate`、`/api/v1/translate/batch` 返回 202 / jobId，模型任务进入已注册 Worker handler。`GET /api/v1/translate/jobs/:id` 仅返回同 workspace/type 的状态和完成结果，不返回 Job 输入或内部错误。页面适配等待结果，旧客户端需刷新静态资源或适配 202。SSE 复用现有 Job/译文事件与重放。

本轮未改 Harness、主文章模型池、Tag、小时/日报预算或已执行 migration。失败状态随后由 migration 50 追加，不改写已执行迁移。外部能力由 Connector 适配，业务写入仍经 Service/Repository。

## 验收限制

31B 诊断曾通过流式基础响应和两次短段翻译，新适配器实测仍出现 500/流内错误，不能称已稳定。26B 新适配器的英文标题、表格、条件列表样本完整响应并落库，人工核对数字和条件正确；不推广为所有长文质量通过。官方规则：<https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api>。
