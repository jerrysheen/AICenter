# 全局文本粗筛 Tag

## 目标

给本地文本打预定义 tag。信息流、灵感、知识文章共用同一套 catalog 与 Worker。本轮只做召回，不生成知识、不改 Taxonomy。

## 决定

- Tag 是全局概念：输入一批文本，按 `item_id` 输出 `tags[]`。
- `content-item` / `knowledge` 可多标；`inspiration` 只保留 1 个 tag。
- 字典在 `config/tags.json`，与 Knowledge Taxonomy 分离。模型只能选 catalog 里的 id。
- 结果表 `resource_taggings`（V17），一条资源一份当前结果。幂等键是 `resource + tag_catalog_version + prompt_version`。
- 复用 `packFeedAiBatches(purpose=analyze)`：每批最多 20 条 / 30k chars，单条最多 6000（头 4500 + 尾 1500）。一行 JSONL = 一批。
- 豆包 `task=tag_texts`，走现有网页聊天队列。等待以「回复文本是否还在变长」为准：还在涨就继续等，不把上限超时当成失败。JSON 只作弱解析，格式歪了也尽量抽出 `items`。
- 豆包页面 `innerText` 常把输入信封和结果粘在一起，结果还经常是顶层数组而不是 `{ items: [] }`，并夹杂「展开全部」。解析必须跳过 `tag_texts` 信封 / `tag_catalog` 输入项，只认带 `tags` 的条目；否则会把待标注原文当成空标签写入 `resource_taggings`。
- 按 item_id join；未知 tag/item 丢弃；漏项重试；空数组合法。
- 不自动补父 tag，不要 confidence。
- HTTP 只入队 `tagging.analyze`；Worker 执行。SourceHub 不改。

## 验证

- `npm run check`
- `npm test -- test/tagging.test.js test/feed-ai-batch.test.js`
