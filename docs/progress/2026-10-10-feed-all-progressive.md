# 2026-10-10 信息流全部增量合并与重点窗口

公网刷新 `#feed`「全部」时，官方、X、雪球返回有快有慢。先回来的来源会先画进列表，计数却写成最终的「已显示 X / N 条」，所以总数会在 12、50、60 之间跳，第一屏有时只剩社媒。

## 决定

「全部」在 `posts`、X、雪球、官方都返回或失败之前，计数只写还没到的来源，例如「官方读取中…」。来源到达后按 id 合并：新条在前，已有条目只更新字段，列表仍按时间重排。到齐后才写「共 N 条」。失败的来源算已经返回，不再一直占着读取中。

「重点」不再靠未读优先的前 200 条碰运气。进入该标签时，X 和雪球另拉 `saved=1`（接口缺省仍是原来的时间线，旧客户端不用带这个参数）。已读且 `is_saved` 的星标能进列表。标为重点时把 `isSaved` 写回内容状态，和取消星标对称。窗口还在读、列表仍空时显示「正在读取重点…」，不先写「这个筛选下还没有信息」。

卡片摘要优先用客户端译文这件事已经在 main（`b487ccf`）：`feedCardExcerpt` 有 `state.translations` 就走 `postListExcerpt`，没有才用 `post.excerpt`。没译文且服务端 `pending` / `running`，或 X 批量翻译进行中，仍是「正在翻译…」；这轮结束仍无译文是「暂未翻译」。这次没有改翻译生成。

`#market` 和 `#market/global` 去掉页签上方单独一行「更新 10月10日 17:28」，也去掉市场概览里「北京时间 17:00 后至次日 05:00 及周末显示美股观察。完整分组在美股分览。」这段说明。各行情块标题旁的更新时间小字还在。`#sources` 总览行情条没有改。

## 改动

`apps/web/public/app.js`、`packages/contracts/src/index.js`、`packages/domain/src/feed-service.js`、`packages/database/src/repositories/feed-repository.js`，以及对应测试。没有新依赖，没有改总览时间线函数、主导航、分类和翻译生成。

`npm run syntax` 通过。`npm test`：1015 项，通过 1004，失败 10。失败都在这次改动之外：analysis-skill 6 项、information-tree 策略 1 项、model-usage 的 zstd（Node 22.14 没有 `createZstdCompress`）、本机没有 Cursor CLI 1 项。
