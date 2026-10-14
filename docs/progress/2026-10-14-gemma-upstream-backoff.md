# Gemma 上游错误换密钥，Token 按实际用量记账

2026-10-14 当天 Google 对 Gemma 返回 1567 次 HTTP 500 `INTERNAL`，没有 429。五把密钥在五个项目里均匀出现，和输入长度、请求参数对不上。用户确认这是 Google 端的随机错误。每次 500 把该密钥冷却 60 秒，空闲配额被跳过，准入失败又写成「等待配额窗口」。本机没有生产库，以上是用户给出的线上计数。

## 目标

默认池仍只有 26B，`thinkingLevel` 保持 `minimal`，重试不加 31B。HTTP 500、502、503、408 立刻换下一把密钥。同一密钥连续失败才按基数翻倍退避，成功后清零。Token 只记响应 `usageMetadata`。每个密钥每分钟最多 25 次，同密钥间隔 2–3 秒随机。这些数值都可以用环境变量改。

## 决定

冷却表只留给 429 和 Google 给出的重试延迟。可重试状态放在 `AI_CENTER_GEMMA_TRANSLATION_RETRY_STATUSES`，默认 `500,502,503,408`。响应超时和连接超时按 408 处理。列表外的状态不换密钥。退避放在翻译路由器的进程内存里：第一次连续失败等待基数，之后每次翻倍，直到上限，成功后清零。重启不保留。默认基数 10000 毫秒，上限 40000 毫秒。同一次 `generate` 默认最多再试 2 次，重试窗口约 1.5 秒，只接已经空闲的下一把密钥。

同密钥间隔在下限和上限之间随机，默认 2000–3000 毫秒，记在进程内。配额表持久保住下限，重启后下一跳至少相隔下限。每分钟请求默认 25。准入失败的文案按原因分开：上游退避写「上游 500 退避」，每分钟请求、每分钟 Token、每日上限、同密钥间隔和 429 冷却仍写「等待配额窗口」。每日窗口用太平洋零点。不新增 migration。

Token 预留先写 0。响应里有 `usageMetadata.totalTokenCount` 时改成这个数；没有总数时用 prompt 加 candidates。没有用量保持 0，失败响应带用量时同样写入。不再按 UTF-8 字节数估算。

## 改动

`packages/connectors/src/translate/gemma.js` 的准入和生成。`model-quota-repository.js` 的 `recordActualTokens` 继续把实际用量写回已有的 `estimated_tokens` 列。Gemma 传入的两个模型在每分钟 Token 和每日次数上按密钥合并计算，文章准入不传这组模型，计数方式不变。`.env.example` 写上各变量的默认值和范围。

| 环境变量 | 默认 | 范围 |
| --- | --- | --- |
| `AI_CENTER_GEMMA_TRANSLATION_RETRY_STATUSES` | `500,502,503,408` | 400–599，逗号分隔 |
| `AI_CENTER_GEMMA_TRANSLATION_REQUESTS_PER_MINUTE` | 25 | 1–60 |
| `AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS` | 2000 | 0–120000 |
| `AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS` | 3000 | 0–120000 |
| `AI_CENTER_GEMMA_TRANSLATION_BACKOFF_BASE_MS` | 10000 | 0–600000 |
| `AI_CENTER_GEMMA_TRANSLATION_BACKOFF_CAP_MS` | 40000 | 0–600000 |
| `AI_CENTER_GEMMA_TRANSLATION_MAX_RETRIES` | 2 | 0–8 |
| `AI_CENTER_GEMMA_TRANSLATION_TOKENS_PER_MINUTE` | 16000 | 1–16000 |
| `AI_CENTER_GEMMA_TRANSLATION_REQUESTS_PER_DAY` | 14400 | 1–14400 |

未填或不是整数时用默认值。间隔上限小于下限时抬到下限，退避上限小于基数时抬到基数。五把密钥仍按当日已用次数和上次请求时间均衡，可以在同一次调度里同时发出。

## 验证

`node --test test/gemma-translation.test.js test/translation-reliability.test.js test/gemini-quota-balance.test.js test/gemini-article.test.js` 通过。覆盖五密钥同刻发出、重启后至少相隔 2 秒、随机间隔的上下限、14400 的太平洋日上限、每分钟 2 次时第三请求等到 60 秒、500 不写冷却、10/20/40 秒退避以及自定义基数和上限、成功后回到基数、502/503/408 换密钥、504 默认不换、配上 504 后换、最大重试 1 次只再打一把密钥、429 仍冷却、`usageMetadata` 写回 30 或失败响应里的 17、缺用量时记 0。

## 遗留

退避和间隔的随机上沿不跨进程。Worker 重启后下一跳可以按持久化的下限马上重用同一密钥。真实 429 仍在冷却表里，不受这次重启影响。

## 重启

不新增 migration。63 仍空着，67 是 `feed_translation_chunks`。下一次迁移从 68 起。不要重建数据库。

需要同时重启 Web 和 Worker。原文翻译任务在 Worker 里准入；Web 启动时也会装入同一个翻译端口。没有新的页面脚本。
