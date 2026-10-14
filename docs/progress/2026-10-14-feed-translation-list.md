# 社媒列表译文、长文入队和阅读页

2026-10-14。

## 决定

`GET /api/v1/feed/x` 的列表形状继续不带正文，也不带 `translation.text`。已有译文时，列表除了第一句标题，还带最多 200 字的 `translation.summary`。列表可以挂上中文整理的标题和摘要，不为此重读正文。列表另用正文前 480 字判断 `needsTranslation`。中文来源即使标题像英文，也不标「暂未翻译」。

阅读页先用接口返回的 `translation.text`。本地内存和 localStorage 不能盖过它。`normalizedArticle.body` 只有在本身是中文时才当作译文。从简报打开、信息流里还没有这条时，按内容条目读取作者、`publishedAt`、平台和译文。社媒有正文时不再标成「仅摘要」，也不再把来源写成 TrendForce。

`feed.translation.run` 以前在正文超过 20000 字时直接不建任务；同步翻译路径还会跳过被截断的条目。Gemma 本来就按 2400 字分段。现在入队和保存上限改为 20 万字符，任务里带全文，保存全文译文和全文哈希。超过 20 万字的仍不入队。不把原文前缀当成全文译文。列是 TEXT，不新增 migration。

Worker 启动时补入还没有中文译文、且需要翻译的社媒条目。默认 80 条，`AI_CENTER_TRANSLATION_BACKFILL_LIMIT` 可以改小，或设为 0 关闭这次启动的补入；即使设得更大也停在 80。五把密钥每天大约 5000 次调用，长文还要按 2400 字分段，所以启动不能一次排进更多。日志是 `[worker] translation-backfill enqueued=N limit=M`。已有未完成的相同任务不重复创建。快讯来源跳过。超过 2 万字的排在前面。手动补入可以另给上限：

```text
node --env-file=.env scripts/backfill-feed-translations.mjs [--limit 80]
```

本命令只入队。翻译由 Worker 执行。

手机先打开总览时，X 列表是不带翻译请求预载的。预载之后 `xLoaded` 挡住了下一次加载，列表正文又是空的，所以手机不会提交 `/api/v1/translate/batch`。现在只要信息流页面正在显示 X，就对屏幕上还没有中文的条目请求翻译。没有正文时用标题和摘要。总览预载仍然不请求翻译。

## 02:00 阅读小时

`GET /api/v1/reports/reading-hour` 在没有已发布快照时返回 404。`scoreWindow` 在窗口里没有信息节点时不发布，原因是 `empty`。2026-10-13 22:00 到 2026-10-14 09:29 采集浏览器没开，09:34 才恢复。02:00 这一小时没有材料，和已经记过的 03、07 点一样，不是路由写错。

小时窗口按入库时间 `created_at`，不按 `publishedAt`。发布在 02:00、入库在 09:34 的帖属于 09:00 那一小时，日报仍可以收录。小时补跑默认只看约 6 小时，不会回头重开 02:00。这次不改小时归属。

信息流里“找不到”这条，是列表只有英文标题和「暂未翻译」，搜索也不查译文。列表带上中文标题和摘要之后，同一条可以从社媒列表辨认。

## 验证

`node --test test/feed-translation-display.test.js test/feed-list-pagination.test.js test/feed-normalized-reading.test.js test/contracts.test.js`。

## 重启

需要同时重启 Web 和 Worker。浏览器再加载一次。不新增 migration。不要重建数据库。
