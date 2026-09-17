# 契约草案（未冻结）

前端提出、双方评审后再写入 `packages/contracts`。页面不得依赖同花顺 `thscode`、Yahoo spark 原始字段或 B站脚本内部字段。

所有新业务对象预留 `workspaceId`。时间一律毫秒时间戳。

## FeedItem

```json
{
  "id": "uuid",
  "workspaceId": "default",
  "platform": "manual",
  "externalId": "post:uuid",
  "authorName": "本机",
  "authorHandle": "",
  "title": "标题",
  "summary": "摘要",
  "body": "正文",
  "sourceUrl": "https://example.com",
  "publishedAt": 0,
  "processing": "",
  "subscriptionId": "",
  "captureId": ""
}
```

`platform`: `manual | bilibili | x`。`processing`: `"" | subtitle | ai`。

第一版 X 接入：`GET /api/v1/feed/x?feed=for-you|following&limit=50` 调用旧仓 `fetch_home_timeline`（已登录 Chrome），返回 `{ ok, feed }`，`feed.items` 为 `FeedItem[]`。页面不得依赖 GraphQL / CDP 原始字段。

## Subscription

```json
{
  "id": "uuid",
  "workspaceId": "default",
  "platform": "bilibili",
  "displayName": "结构笔记",
  "externalAccountId": "472747194",
  "handle": "mid:472747194",
  "paused": false,
  "lastSyncAt": null,
  "lastError": "",
  "priority": "normal"
}
```

## CaptureEnvelope

Adapter 读完旧 Skill JSON 后的最小包装：`platform`、`externalId`、`fetchedAt`、`payloadRef`（blobs 相对路径）、`status`。

## Instrument / QuoteSnapshot

标识规则（草案）：

- A股：`300750.SZ`、`600519.SH`（与同花顺 `thscode` 对齐，前端只显示这一层）
- 美股：Yahoo 代码 `AAPL`
- 全球资产：稳定符号 `XAUUSD`、`BTC-USD`、`CL`，另存 `assetClass`

```json
{
  "id": "uuid",
  "symbol": "300750.SZ",
  "name": "宁德时代",
  "market": "cn",
  "assetClass": "equity",
  "currency": "CNY",
  "expiry": null
}
```

```json
{
  "instrumentId": "uuid",
  "symbol": "300750.SZ",
  "lastPrice": 252.18,
  "changePct": -0.68,
  "prevClose": 253.91,
  "currency": "CNY",
  "asOf": 0,
  "session": "closed",
  "provider": "mock"
}
```

`market`: `cn | us | global`。`assetClass`: `equity | index | fx | rate | metal | energy | futures | crypto`。

## PortfolioSummary / Position

```json
{
  "portfolioId": "uuid",
  "baseCurrency": "CNY",
  "nav": 186420.55,
  "dayPnl": 1240.2,
  "positionPnl": 8320.18,
  "totalReturn": 16420.55,
  "asOf": 0
}
```

- `dayPnl`：相对上一交易日收盘
- `positionPnl`：相对买入成本
- `totalReturn`：相对初始资金，计入入金出金、分红、费用、汇率

持仓变更只通过 `transactions`（`buy | sell | adjust | dividend | fee | deposit | withdraw`）。

## Inspiration / KnowledgeDocument

灵感保留 `body` 原文。`aiReply` 只作为过渡；目标模型是独立 `ai_runs`。知识文档带 `sourceType`、`sourceId`、版本，检索结果必须能回到原文。

## AgentJob / DomainEvent

任务：`type`、`status`、`inputRef`、`attempts`、`errorKind`、`nextRetryAt`、`outputRef`。
事件：持久化 outbox，SSE 用 `Last-Event-ID` 补发。前端本轮只消费已有 `post.created`。
