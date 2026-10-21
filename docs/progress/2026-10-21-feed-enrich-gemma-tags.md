# 信息流整理补上 Gemma 标签

## 原因

`#195` 只改了 `createGeminiTagPort`。生产打开文章整理后，`feed.items.enrich` 走 `articleNormalizePort.prepareInformation`，不再调用 `taggingService.analyzeItems`。这条旁路从 2026-10-07 Gemini 文章整理接入正式流程时就存在：信息树节点上的 `tagId` 由 Flash Lite 在整理正文时一并返回，`resource_taggings` 不再写入。页面覆盖率读的是这张表，所以 10-07 之后新帖一直是 0%。`#195` 上线后 Gemma 的 `tagging` 调用仍是 0，因为生产根本没有打到这个入口。

## 决定

文章整理仍然先排队。短帖在排队之前先走原来的标注服务，模型仍是 Gemma 26B，结果写入 `resource_taggings`。信息树如果已经读到这份标签，节点的 `tagId` 用其中第一个有效标签，不再采用 Flash Lite 在正文里顺手返回的标签。没有标签时正文整理照旧。Bamboo 的信息流准入分类不动。媒体正文整理不改。

不新增 migration。当前 schema 是 95。下一号是 96。空号仍是 63、79、80、82。不要重建数据库。

需要重启 Worker。页面没有改，Web 不用为这项重启。

## 验证

`node --test test/article-normalize.test.js test/feed-automation.test.js test/gemini-tag.test.js`

`normalize branch queues title and summary for link items` 和 `automatic translation is visible on the feed item id` 在 `917318c` 上已经失败，这次没有改它们。
