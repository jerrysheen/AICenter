# YouTube 中文整理排队

2026-10-20。All-In `youtube:2Zj6uMv3kTA` 只有中文标题，正文仍是英文，也没有要点。`youtube:2tAywoHiIpo` 和 `youtube:U3x7aZ11WT4` 同样停在整篇翻译的第 13 段。

整理以前只在每天 07:00 的 `youtube.podcasts.sync` 收尾跑一次。每天默认 2 期，名额用完就静默跳过，统计里看不出来。新入库的一期最长要等到下一次 07:00。

文章页把 YouTube 内容映射成 `platform=manual`，于是仍会 `POST /api/v1/translate`。Gemma 对去重后的滚动字幕译文偏短，`chunkLooksShort` 每次都判同一段失败。租约恢复又把 `max_attempts` 往上加，任务一直重新排队。页面只轮询，看不出失败。

现在：

- 新入库 36 小时内的期次先整理。已经排进当天的接着做。更早的积压排在后面。需要再修的已完成期次最后处理，不占当天名额。
- 每天默认 4 期，仍由 `AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY` 配置，范围 1 到 8。名额用完的期次写下 `holdReason=daily-limit`，并计入 `dailyLimit`。当天不再重试，下一次机会从明天算。
- 除 07:00 同步收尾外，增加 `youtube.podcasts.article`。默认每 3 小时一次，可用 `AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_EVERY_HOURS`（2 到 12）。时刻对齐本地 :10（0:10、3:10、6:10……），避开小时报的 :30。同步任务正在跑时，这一轮补跑跳过，不和抓取叠在一起。
- YouTube 期次不再走 feed 整篇翻译。打开文章只查询整理状态。Worker 启动时取消还开着的 YouTube 翻译任务，不再重新排队。`youtube:2Zj6uMv3kTA`、`youtube:2tAywoHiIpo`、`youtube:U3x7aZ11WT4` 会在这次启动时取消。中文正文仍由 Gemma 整理写出。
- 其它来源同一段连续失败 3 次，写成失败，不再无限重排。配额推迟和单次调用上限不计入这 3 次。
- 期次接口返回 `article.status`、`article.message`、`article.done`、`article.total`、`article.holdReason`、`article.nextAt`。中文版没好时，列表和文章页写「中文整理排队中，预计 X 点处理」「整理中 12/27 段」或「整理失败：原因，将于 X 点重试」。英文原文放在默认折叠的「英文原文」里。

正文仍是按时间顺序的忠实翻译，写清谁说了什么。导读最多放在开头。翻译用 Gemma 26B，缺的段落可以改用 Flash。整理完成后仍只用 Gemma 按正文起标题。

migration 92 `feed_translation_chunk_failures` 只新增同段失败次数表。不改已有 migration。当前 schema 是 92。下一号是 93。空号仍是 63、79、80、82。不要重建数据库。

需要同时重启 Web 和 Worker，浏览器再加载一次。Worker 重启后新的整理调度、整理任务和卡住的 YouTube 翻译取消才会生效。Web 重启后期次接口才带整理状态，文章页才不再提交整篇翻译。
