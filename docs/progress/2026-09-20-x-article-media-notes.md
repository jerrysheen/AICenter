# 2026-09-20 X 长文封面卡与未抓取媒体备注

## 目标

核对上一轮 X Article 是否真正入库；把抓不到的视频 / 图片 / 外链卡片标进现有 `body`。

## 发现

上一轮只认 `/article/` 链接。首页长文卡片实际是 `article-cover-image`，没有 `/article/` href，推文 `tweetText` 经常是空的。库里 923 条 X 动态 **0 条**含 `/article/`，典型长文（如 `0xCodila/status/2100984487802708306`）只留下导语。打开 status 页后正文在 `twitterArticleRichTextView`，不是另开 `/i/article/`。

## 决定

- 封面卡按 `article-cover-image` 识别，打开 **status 页** 抽标题和长文正文，仍只拼进 `body`。
- 抽不到的视频、图片、外链卡片写成 `[未抓取] …`，不加 Feed JSON 字段。
- 长文打开失败时写 `[未抓取] X 长文` 和原链接，避免空 body 被过滤器丢掉。

## 验证

`npm test -- test/twitter.test.js`
已登录浏览器打开 `0xCodila` status 页，长文正文约 12k 字。
