# 媒体列表读出补漏译文，补漏按 72 小时窗口扫失败条目

2026-10-14 `#103`（`df3a464`）上线后，逐条保存已经生效。媒体接口仍读不出补漏写入的中文标题。最后一次任务为 failed 的标题停在失败任务里，不再入队。`feed_translation_chunks` 部署后仍是 0 条新记录。

## 根因

媒体列表的展示正文是 `标题`，摘要和标题不同时拼成 `标题\n\n摘要`。阅读接口只在 `feed_item_translations.source_hash` 等于这段展示正文的哈希时标 `ready`。补漏对未核实全文的条目写入的是 `media:<externalId>`，哈希只覆盖标题。两边对不上就标 `stale`，列表投影把这种状态收成空的中文标题。所以「Microsoft denies cloud leadership…」在 00:27 已经有「微软否认云业务领导层曾要求…」，接口仍显示 stale、没有中文。

全文标题块用的是另一套 id：`media-block-v2:<externalId>:<原文哈希>:<上下文哈希>`（旧 id 是 `media-full:…`）。这些行只在文章被核实为全文时，由文章译文投影读出。标题任务已经完成、文章却还不是核实全文时，接口只查 `media:<externalId>`，所以「IURC approves AES…」00:26 任务完成，列表仍查不到译文。

补漏上一轮只看最新约 80–200 条媒体索引，以及启动补译那条查询。`listOpenJobs` 只含排队和进行中的任务，失败任务不在里面。终态失败的标题一旦掉出最新一页，就再也不会入队。「Nvidia's Jensen Huang pledges $2 billion…」和「AI guardrails…」属于这种情况。7 条标题停在 23:36 的失败任务里，之后也没有新任务。

`feed_translation_chunks` 是续翻缓冲，不是翻译日志。连接器只在同一条原文被切成多段、且这一段 `status=ok`、条目 id 存在、并且调用方注入了 `chunkStore` 时插入一行。`status=retry` 不写。单段标题会打 `translation-chunk`，但不进这张表。切段阈值默认 1500 字（`AI_CENTER_TRANSLATION_CHUNK_CHARS`，400–2400）。媒体正文在成为任务条目前已经按最多 2400 字切成独立块；块不超过 1500 字时仍是一段，不会插入。块超过 1500 字时，前面的段会先写入，整段译文经 `saveTranslations` 落库时会按条目删掉这些行。Worker 和 Web 都已经注入 `chunkStore`。因此健康部署之后这张表保持 0 行是预期：只有「某条超过 1500 字的原文已经译完前面的段、全文还没落库」时才会暂时有行。这次不改写入路径。

## 决定

仍只用 Gemma 26B。不改信息树，不新增 migration。63 仍空着，67 不变，下一次迁移从 68 起。

读取侧认标题。`media:<externalId>` 的哈希对上标题时，列表和详情都标 `ready` 并带出中文。同时也查标题块 id（含旧 id）。展示正文整段的哈希仍然优先。对不上任何一条时，已有行仍是 `stale`，没有行是 `pending`。

补漏改为按时间窗口扫全部缺译条目，不再停在最新 80 条。每轮仍限制入队条数。扫到入队上限时记住游标，下一轮从那里继续；本轮从窗口中间开始时，扫到窗口尾部再回到窗口头部一次。反复失败的条目按失败次数递增等待，避免刚失败就再次入队。

## 改动

`packages/domain/src/media-ingestion-service.js` 在读媒体列表时同时加载 `media:` 行和标题块行，按上面的顺序选用。

`packages/database` 增加 `listEntriesSince` 和 `listFeedBodiesSince`。空游标表示从窗口头部开始；`null` 不再被当成时间 0。媒体索引用 `published_at`，没有发布时间时用 `observed_at`。社媒正文用 `content_items.created_at`。

`fillUncoveredTranslations` 扫窗口内缺译的媒体标题、文章块和社媒正文。终态失败也入队，但要过递增间隔，并且跳过仍在排队或进行中的条目。新任务的第一次失败如果发生在已经用尽 4 次之后，失败计数在原计数上加一，之后按这个计数等待。第一次任务自己的 1–4 次和 `nextRetryAt` 不变。

| 环境变量 | 默认 | 范围 |
| --- | --- | --- |
| `AI_CENTER_TRANSLATION_GAP_FILL_WINDOW_MS` | 259200000（72 小时） | 短于 72 小时仍按 72 小时；最长 30 天 |
| `AI_CENTER_TRANSLATION_GAP_RETRY_BASE_MS` | 900000（15 分钟） | 小于 60000 回到 15 分钟；用尽 4 次后再入队先等这个基数，之后每次翻倍，最长 24 小时 |

原有的 `AI_CENTER_TRANSLATION_GAP_FILL_INTERVAL_MS`（默认 5 分钟）和 `AI_CENTER_TRANSLATION_GAP_FILL_LIMIT`（默认 20，最大 80）不变。优先级仍是 -10。

## 验证

`node --test test/translation-batch-persist.test.js test/translation-reliability.test.js test/media-reading.test.js test/translation-chunks.test.js test/media-ingestion.test.js` 通过。覆盖补漏写入后媒体列表读出中文、标题块译文在未核实全文时也能读出、70 小时前的失败标题入队、刚失败的标题等待、窗口外的标题不入队、失败计数跨任务递增。信息树没有改。

## 遗留

需要同时重启 Web 和 Worker。不要重建数据库。浏览器不用为这项再加载；媒体中文来自接口。Worker 进程里的补漏游标在重启后从头再扫。分段表没有改写入条件。
