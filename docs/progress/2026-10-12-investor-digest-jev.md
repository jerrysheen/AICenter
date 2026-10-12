# 2026-10-12 股民讨论日摘改为 JEV v2 占比

线上日摘不再让总结模型直接写偏多、偏空、分歧或平淡。每条帖子和评论先按 `config/jev-questions.v2.json` 做是非判断，再在代码里算加权多空占比。总结仍只概括观点、热度和传闻，不写交易建议。旧日摘没有这组占比时，页面继续显示原来的情绪字段。

## 题集

默认文件是 `config/jev-questions.v2.json`。`AI_CENTER_DIGEST_JEV_QUESTIONS` 为空时用它。可以写成 `v2`，或仓库内相对路径、绝对路径。文件缺失、JSON 不合法或字段对不上时直接报错，不会悄悄换成另一套题。每次日摘把用到的 `version` 写入 `investor_discussion_digests.question_set`（migration 56，只加列）。

文件要有这些字段：

- `version`：短标识，例如 `v2`。
- `system`：完整系统提示词。每个问题都要在里面出现一行 `id：text`。
- `questions`：`{ id, text }`。`id` 以字母开头。
- `user.intro`、`user.bodyClip`、`user.parentClip`：用户提示第一句，以及原文、原帖截断长度。空白会收成一个空格，超长用 `…`。
- `stance.rules`：按顺序命中第一条。`when` 里写问题 id 和 true/false，可选 `maxChars`。`stance.fallback` 是都没命中时的立场。立场名必须是 `aggregation.stances` 里的四个字符串。
- `weight.engagement`：`likes-else-replies`、`replies-else-likes`、`sum`、`likes`、`replies`、`none`。
- `weight.transform`：`1+log1p`、`log1p`、`flat`。
- `weight.factors`：`{ question, whenTrue, whenFalse }`，乘数在 0 到 10。
- `aggregation`：`minDirectional`、`insufficientLabel`、`bullShare`、`bearShare`、`gap`、`splitMin`，以及 `bull`、`bear`、`split`、`flat` 和 `stances`。
- `batch`：`size`、`singleAttempts`、`backoffMs`。

v2 的立场顺序是：不谈本组标的为无关，不进入占比分母；不是直接说出口且原文收成空格后不超过 8 字，记为中性；只有看多为看多，只有看空为看空，其余为中性。只提问、只转述、自己买卖会问，但不改立场，也不乘权重。权重是互动权重乘直接 1 或推断 0.6，再乘有依据 1.2，再乘传闻 0.7。有点赞用点赞，否则用回复数，互动权重是 `1 + log1p`。方向性发言少于 5 条时页面显示「数据不足」，占比和计数仍写入该标的。

评论只在链接最后一段对上同一标的的帖子 id 或帖子链接最后一段时附上原帖前 160 字。原文截到 280 字。长度判断用收起空白后的原文，不用截断后的提示词。

一批 12 条。整批解析失败且多于 1 条时对半拆开，两半都放回队列前面，左半先打。只剩 1 条时最多打 3 次（含第一次），中间等待 2 秒、4 秒。缺字段或不是布尔值的条目同样再打。调用次数算进 `AI_CENTER_INVESTOR_DIGEST_JEV_MAX_CALLS`，默认 200。

## 调用和页面

总结仍走原来的单 key Gemini。打标签另走可轮换的 Gemini key：`AI_CENTER_GEMINI_KEY_ENVS` 默认 `GEMINI_API_KEY` 到 `GEMINI_API_KEY5`，按当天太平洋日用量选更空的 key。429 写入现有配额冷却；日配额冷却到太平洋午夜。没有 Grok 回退。没有密钥时任务失败，不会把这些发言当成未标注后继续出占比。

页面有占比时显示「多空占比 看多 x% · 中性 y% · 看空 z%」，并写出样本数和看多、中性、看空条数。方向不足时只显示「数据不足」。没有占比的旧行仍显示原来的情绪。覆盖率里会写未标注条数和题集版本。

离线 A/B 的方案 A 改用同一套题和同一套打标。方案 B 不变。方案 A 的默认批大小改为题集里的 12；`AI_CENTER_INVESTOR_DIGEST_AB_BATCH` 或 `_BATCH_A` 仍可覆盖。方案 A 的单条次数看 `AI_CENTER_INVESTOR_DIGEST_JEV_ATTEMPTS`，不看 `AI_CENTER_INVESTOR_DIGEST_AB_RETRIES`。

## 环境变量

- `AI_CENTER_DIGEST_JEV_QUESTIONS`：空为 `config/jev-questions.v2.json`；也可写 `v2` 或路径。
- `AI_CENTER_INVESTOR_DIGEST_JEV_BATCH`：空为题集里的 12。
- `AI_CENTER_INVESTOR_DIGEST_JEV_MAX_CALLS`：默认 200。
- `AI_CENTER_INVESTOR_DIGEST_JEV_ATTEMPTS`：空为题集里的 3。
- 日摘原有变量不变：`AI_CENTER_INVESTOR_DIGEST`、`_AT`、`_TIMEZONE`、`_MODEL`、`_RETRIES`、页数和评论帖数，以及 `GEMINI_API_KEY` / `AI_CENTER_GEMINI_KEY_ENVS`。

改完需要重启 Web 和 Worker。服务启动时会跑 migration 56，不用重建数据库。
