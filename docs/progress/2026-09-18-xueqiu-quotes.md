# 持仓沪深/港股通行情改走雪球批量报价

## 目标

A 股、场内 ETF、B 股和港股通现价应对齐个人看盘级准实时，而不是 Yahoo 延迟盘；同花顺仍留作缺票回退。

## 决定

- 新增 Connector `packages/connectors/src/xueqiu-quotes.js`。先 `GET https://xueqiu.com/hq` 取匿名 `xq_a_token`，再请求 `/v5/stock/batch/quote.json`。股票和 ETF 同一批，不再拆同花顺基金接口。
- 内部仍用 Yahoo 风格代码：`.SS` → `SH600519`，`.SZ` → `SZ300750`，港股补齐 5 位（`0981.HK` → `00981`）。页面 Contract 只消费 `lastPrice` / `previousClose`。
- `market.quotes` 路由：雪球 → 同花顺（仅沪深缺票）→ Yahoo。汇率和美股/亚洲观察池看板仍走 Yahoo。
- Source TTL 降到 3 秒。可选 `XUEQIU_COOKIE` 只放 Instance `.env`，不进 Git、不回传手机。不常驻浏览器、不读 DOM、不新增 QuoteWorker 进程。
- 2026-09-18 交易时段实测：旧 `quotec.json` 已空返回；`batch/quote.json` 可用，报价时间戳落后墙钟约数秒。定位为个人监控级准实时源，不是交易所 tick。

## 验证

- `npm run check`
- 持仓页刷新后，芯片 ETF / A 股 / 港股通现价应贴近券商；失败时仍可回退同花顺或 Yahoo。
