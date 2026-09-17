# 持仓现价改用沪深实时源

## 目标

当日盈亏看起来不对，根因是现价来自 Yahoo spark，沪深大约延迟 15 分钟。

## 决定

- 公式仍是 `(现价 - 昨收) × 数量`，不改 Contract。
- `.SS` / `.SZ` 现价、昨收已改为同花顺快照，见 `2026-09-16-holdings-ths-quotes.md`。
- 页面仍只消费 `lastPrice` / `previousClose`。

## 验证

- `npm run check`
- 刷新持仓后，芯片 ETF 现价应贴近券商，而不是 Yahoo 慢一拍的价。
