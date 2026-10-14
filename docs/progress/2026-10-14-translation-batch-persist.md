# 翻译按条落库，标题五条一批，补上没有任务的条目

2026-10-14 `#102`（`4188f48`）上线后，`feed_translation_chunks` 没有新行，日志里却有大量 `translation-chunk status=retry`。22–29KB 的 `feed.translation.run` 四次用尽后报「翻译未完整结束」，已经返回的译文没有留下。任务 `da52a73a` 一批 18 条标题，8 次 HTTP 200、6 次 HTTP 500，最终一条未保存。另外有标题停在 pending 或 partial，库里没有对应的排队或进行中任务。

## 根因

Gemma 路由器 `batch: false`，连接器按条调用 `translate()`。`feedService.translateMany` 却等整批 `translateMany` 返回后才 `persistTranslations`。后一条抛出 HTTP 500 或「翻译未完整结束」时，前面已经成功的译文只在内存里，随异常丢掉。Job Runner 用原来的整批入参重试，最多 4 次。`noteTranslationFailure` 把还没落库的条目都记成失败，包括已经拿到 200 的标题。`da52a73a` 的 8 次成功因此没有进入 `feed_item_translations`；6 次 500 发生在后续条目，整批中断后其余标题不再请求。

`feed_translation_chunks` 只在多段正文的某一段 `status=ok` 时写入。`status=retry` 和 `status=error` 不写。单段标题也会打 `translation-chunk`，但本来就不进这张表，成功后只进 `feed_item_translations`。22–29KB 是打包后的任务 JSON（最多 30 条或 12000 字），不是一篇文章切成 1500 字段。这些任务里成功的多是单段条目，失败发生在整批返回之前，所以分段表不会出现新行。长文里已经 `ok` 的段会当场写入；下一次只重翻失败段。Web 的 `createTranslateService` 以前没有接上 `chunkStore`，页面内联翻译即使翻完一段也无法写入。翻译任务在 Worker 上跑，Worker 当时已经接了这段存储。

启动补译把已经用尽重试、`nextRetryAt` 为空的条目标成 failed 后跳过。文章因此停在 pending 或 partial，又没有排队或进行中的 `feed.translation.run`。

## 决定

仍只用 Gemma 26B。不改信息树，不新增 migration。63 仍空着，67 不变，下一次迁移从 68 起。

一条任务里每条成功就写入 `feed_item_translations`。失败只把还没成功的条目留在该任务的入参里再试。配额顺延（`budget-deferred`）停在当前条，后面的条目一并留到下次，不再继续打模型。长文仍按段写入 `feed_translation_chunks`，重试跳过已存段。

单行且不超过 240 字的标题每批最多 5 条。正文、摘要和媒体正文块仍按 30 条、12000 字打包，优先级低于 0 时一次最多新建 8 条。

Worker 在启动补译之后，以及之后每隔一段时间，扫描媒体标题、未译完的文章块，以及译文状态为 failed 且没有开放任务的社媒正文。只入队还没有排队或进行中任务的条目，优先级 -10。

## 改动

`packages/domain/src/feed-service.js` 按条调用翻译端口并当场落库，错误上带 `failedItemIds`。`packages/database/src/index.js` 增加 `replaceRunningJobInput`，只改仍由当前 Worker 持有的 `feed.translation.run` 入参。任务处理器在失败集合是原批次的真子集时先收窄入参，再把错误抛回，由原来的 `failJob` 只给剩下的条目记失败。

标题上限用于媒体列表标题、官方看板、`requestTranslation` 全是标题的请求，以及页面上的来源标题切片。页面切片固定为 5，与默认值一致；服务端仍按环境变量再切。X 帖子批次仍是 30。

`fillUncoveredTranslations` 由 Worker 启动时跑一次，再用 `setInterval` 重复。`close()` 清掉定时器。日志是 `[worker] translation-gap-fill enqueued=N limit=M scanned=S media=A feed=B`。

| 环境变量 | 默认 | 范围 |
| --- | --- | --- |
| `AI_CENTER_TRANSLATION_TITLE_BATCH_LIMIT` | 5 | 1–30，非法值回到 5 |
| `AI_CENTER_TRANSLATION_GAP_FILL_INTERVAL_MS` | 300000 | 0 关闭；其余收进 60000–86400000 |
| `AI_CENTER_TRANSLATION_GAP_FILL_LIMIT` | 20 | 0 关闭；最大 80，非法值回到 20 |

## 验证

`node --test test/translation-batch-persist.test.js test/translation-chunks.test.js test/feed-ai-batch.test.js test/feed-translation-display.test.js test/translation-reliability.test.js` 通过。覆盖三条里成功两条只重试失败条、配额顺延留下后续条目、长文段落后重试跳过已存段、标题 5 条和环境变量 2 条、正文仍是 30 条、两个例子标题里已有任务的跳过、终态失败重新入队。`test/information-tree.test.js` 里「translation persists each successful batch」在 `4188f48` 上已经失败：保存的短译文被截断判断留在 pending，这次没有改信息树，也没有改这条测试。

## 遗留

需要同时重启 Web 和 Worker。不要重建数据库。浏览器再加载一次后，来源标题才按 5 条提交。信息树代码没有改。
