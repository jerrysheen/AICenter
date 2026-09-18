# 抓取英文统一豆包翻译，view 不再展示原文

## 目标

社媒、官媒和信源抓到的英文（及韩文）在入库后统一走豆包翻译并轻度清洗。原文继续保存，但用户 view 只看中文。

## 决定

- Capture / ContentItem 仍保存原文；`Capture.metadata.originalText` 在入库时一并写下。
- 译文仍落 `feed_item_translations`，不覆盖来源事实字段。官方日程标题、官媒标题、预测市场问题复用同一张表，Source Snapshot 保持原文。
- 豆包 JSONL 允许轻度清洗（去界面残渣、重复空白），禁止总结、扩写和评论。
- 刷新入库会等待本批翻译；缓存读取只贴已有译文，页面再补未完成项。
- 用户 view（信息流详情、总览时间线、官方列表、预测市场问题）只显示译文或「正在翻译…」。
- 原文读取：`GET /api/v1/content-items/:id/original` 与 `GET /api/v1/feed/items/:id/original`。

## 验证

`npm run check`。
