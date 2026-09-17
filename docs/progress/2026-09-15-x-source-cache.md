# X 来源缓存与采集 Chrome 关闭

## 目标

拉取结果按 Feed 设计落入 SourceAccount，刷新后仍能读到；同一推文 ID 去重；拉完关掉专用采集 Chrome，不只关标签。

## 设计对照

`SourceAccount -> Subscription -> Capture -> ContentItem`。X 首页是来源账号 `x:home:for-you` / `x:home:following`，不是临时 HTTP 快照。页面仍只读 FeedItem。

## 行为

- `GET /api/v1/feed/x` 只读已缓存 Capture/ContentItem，不唤起 Chrome。
- `?refresh=1` 才拉 50 条，写入来源并按 `workspace + provider + externalId` 去重。
- 采集 Chrome 使用 `.ai-data/chrome-profile`，拉完发送 CDP `Browser.close`。

## 验证

- `npm test`
- 点「拉取 50 条」后检查 `127.0.0.1:9222/json/version` 应不再可达。
