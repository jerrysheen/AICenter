# Gemma 只守 RPM 和 TPM

## 原因

五个 Gemma 账号不该再被本地每日 1.44 万次拦住。真正要守住的是每把密钥每分钟 25 次（常用到 28）和 16000 token。原先同密钥间隔默认 2–3 秒，再加上 240 秒的单行租约，一把密钥在请求没返回前不能发出下一笔。

补扫窗口里，模型正常看完但没有标签的新帖如果没有落一行记录，下一轮还会选中同一条。上线起点写死在代码里，不能按环境挪动。

## 决定

`requestsPerKeyPerDay` 默认是 `Infinity`。只有设置了正整数的 `AI_CENTER_GEMMA_TRANSLATION_REQUESTS_PER_DAY` 才做本地日封顶。429 仍按 Google 给出的延迟冷却该密钥上的该模型，同一次请求不换密钥。

RPM 默认仍是 25，环境变量仍可写成 28，上限钳制仍是 1–60。TPM 仍是每把密钥 16000。调用前用输入字符估算加上这次输出上限占住 TPM；调用方给的 `estimatedTokens` 更低时抬到这个数。这不是按 UTF-8 字节记账。响应里有 `usageMetadata` 时仍改成实际用量。

同密钥间隔默认 0–500 毫秒。`AI_CENTER_GEMMA_TRANSLATION_KEY_CONCURRENCY` 默认 2，只能设 2 或 3。满员时大约 250 毫秒后再看有没有空位。240 秒只用来丢掉崩溃后没释放的占位，不再把这一把密钥卡成一次只能跑一个请求。RPM 和 TPM 的一分钟滑动窗口仍是硬上限。

补扫起点改为 `AI_CENTER_TAG_RESCAN_NOT_BEFORE`。不填或写错时仍是 2026-10-21 14:47（UTC+8）。窗口内模型正常看完但没有标签的帖，包括整批回了空的 `items`，写一条空的 `resource_taggings`。下一轮不再选中。回复不是 JSON 或调用失败不写。

不新增 migration。当前 schema 是 95。下一号是 96。空号仍是 63、79、80、82。不要重建数据库。

需要重启 Worker。页面没有改，Web 不用为这项重启。

## 验证

`node --test test/gemma-translation.test.js test/tagging.test.js test/gemini-hourly.test.js`
