# 2026-09-17 Market-native Sources

## 目标

在既有官方日程 / 官方发布静态信号层旁边，增加不会与其混淆的市场原生只读数据。

## 决定

- 使用独立 `market-native.*` Source ID 与独立 Board Contract，不改变原有 Calendar / Official Release 语义。
- 第一批接入 Polymarket、Kalshi、Hyperliquid 与 DefiLlama。
- Polymarket / Kalshi 报价逐场所保存，不计算跨场所“真实概率”。
- Hyperliquid 第一版只取 BTC / ETH 的 mark、mid、oracle、funding、base-asset OI 与 24h notional volume。
- DefiLlama 第一版只取总稳定币供给、USDT / USDC 与 Ethereum / Solana / Tron / Base / Hyperliquid L1 分布，以及 1d / 7d / 30d 确定性差额。
- 所有来源仍是带 TTL 的只读 SourceSnapshot，不新增数据库表或后台 Job。

## 改动

- 新增 market-native Contract、Connector、Source Definition、聚合 Board 与 `/api/v1/market-native/board`。
- 总览新增事件市场、Crypto 永续和稳定币流动性三个面板。
- 单源失败归一化为 unavailable / partial，不影响官方静态信号看板。

## 验证

- 固定样本覆盖两个预测市场、Hyperliquid、DefiLlama、Contract 严格字段与 Board 聚合。
- 使用公开端点做实时 smoke test，四组来源均能通过运行时 Schema。

## 遗留

- 24/7 tokenized equity 仍未接入；上线前应先确认可稳定获取 Hyperliquid 原生 xStocks 标识及其 wrapped multiplier / halt 状态。
- 公开 API 的限速和字段漂移仍需逐源运行验收。
