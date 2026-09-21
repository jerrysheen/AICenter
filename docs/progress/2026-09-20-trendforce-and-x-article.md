# 2026-09-20 TrendForce 公开源与 X Article 拼进正文

## 目标

- TrendForce 按两种公开程度入库：免费页抓全文，会员报告只收标题+介绍。
- X 长文进 article 页拉正文，但不改 Feed JSON，只拼进现有 `body`。

## 决定

- 新 Source `content.trendforce.public`，provider `trendforce`，`authMode=public`。
- 只打公开 HTML：`/insights`、`/insights/{slug}`、`/research`、`/price/dram/dram_spot`、`/price/flash/flash_spot`。不跟 `/api/*`、`/pricedetail`、历史图、PDF。
- 会员研报正文加「仅收录标题与介绍」说明。
- X home 采集若卡片或正文有 `/article/`，同一登录会话打开文章页，把正文拼进 `tweet.text`。`tweetToFeedItem` 不加字段。首页封面卡实际是 `article-cover-image`，后续补丁见 `2026-09-20-x-article-media-notes.md`。

## 验证

`npm test -- test/trendforce.test.js test/twitter.test.js test/contracts.test.js`
