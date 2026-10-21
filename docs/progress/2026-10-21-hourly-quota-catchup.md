# 小时报补上太平洋日切，文章整理的新回退改走 Gemma

## 原因

`#200` 把 Flash Lite 的 480 次按密钥分开了。账号并发下还有一条更早的合计：`AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_DAY` 默认 2500，把所有密钥的预留加在一起。3.5 的合计一旦到 2500，这条路径直接把 `retryAt` 设成太平洋午夜，也就是夏令时期间的北京时间 15:00，并且不带 `flashHeadroom` 和 `quotaExhausted`。另一把模型如果已经按密钥到了 480，两边合在一起会被看成「只差下一分钟」。小时浓缩和阅读分类因此不改走 Gemma，错误里仍是等到 15:00。

小时浓缩还会把这次失败写进 `tree-cache`。14:02 重排的 13/10/05 再跑时，缓存的 `retryAt` 还在 15:00 之后，调用模型之前就原样抛出。补跑看起来一直没执行。

启动日志里的模型和预留用的是同一个太平洋日，但没有写出起止时刻，空的 `key_env` 也不单列。北京时间「今天」从 00:00 起算，会切掉前一天 15:00 到 24:00 的那一段，所以和本地预留、用量账对不上。用量账是 `model_usage_index` 里 `kind=request` 的次数。预留是 `model_quota_reservations`。Gemma 26B 的次数在用量账上，不是 Flash 的预留。

`report.information.prepare` 走 Grok 的入口是 2026-10-07 就有的：所有候选密钥都在供应商冷却里，并且 `AI_CENTER_HARNESS_ARTICLE_FALLBACK=elucid-grok`，才用 `grok-4.7`。`#200` 新给本地 Flash 日上限加上 `quotaExhausted`。文章整理认的是这个标记，于是本地日上限也会打开原来的 Grok。上线后的 114 次是这条新的交叉，不是新写的 Grok 客户端。

五把密钥都没有 `GEMINI_API_KEY*_PROJECT`。不需要为了这次额度去配。没配时，每把密钥自己一桶 14 RPM / 480 RPD。只有两把环境变量其实是同一个 Google 项目、必须共用这一桶时才要写成同一个项目名。不要为此改 `.env`。

这个仓库没有生产库，不能代替线上再算一遍。重启后的启动日志按太平洋日列出每把密钥的预留，`full=1` 表示这一日已经不少于 480。用户看到的大约 497 次如果就是这个窗口里的 `key_env` 预留，那一把已经超过本地 480。多出来的可以是探针，探针写入预留时不查这个上限，也可以是按密钥设限之前已经打过的调用。3.5 合计 2529 超过默认 2500，就是上面那条没标成日上限的路径。

## 决定

Flash Lite 的合计日上限，以及按密钥的日上限，都标成 `flashHeadroom=rpd` 和 `quotaExhausted`。两把模型都这样时，小时浓缩和阅读分类改走 Gemma 26B。只差下一分钟时仍等 Flash。已经缓存的「Gemini 文章任务等待流量窗口」不再挡住下一次小时浓缩，13/10/05 可以补。别的失败缓存照旧。

文章整理碰到这个本地日上限时改走 Gemma 26B，不打开 `grok-4.7`。所有密钥都在供应商冷却、且没有这个 Flash 日上限标记时，仍按 10-07 的开关使用 Grok。

Worker 启动日志写明太平洋窗口的起止，并同时给出太平洋和北京时间。预留按密钥列出，空 `key_env` 也列出，以便和模型合计对上。`full` 用 480 比较。

不新增 migration。当前 schema 是 95。下一号是 96。空号仍是 63、79、80、82。不要重建数据库。

需要重启 Worker。页面没有改，Web 不用为这项重启。

## 验证

`node --test test/flash-lite-headroom.test.js test/gemini-hourly.test.js test/gemini-article.test.js test/hourly-condense-log.test.js test/gemma-translation.test.js`
