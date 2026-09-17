# 股票行情接入（Yahoo 总览 / 美股 / 亚洲）

## 目标

把 AI-Hub 的美股观察和亚洲半导体行情适配进 AI Center：真实 Yahoo 数据、原有分组和简介，页面按手机先排。

## 决定

- 股票二级改为 `总览 | 美股 | 亚洲`，不再用 A股/美股 mock 列表。
- 总览：美股+亚洲指数、宽度、领涨领跌；不列出全部标的。
- 分览：沿用原观察池分组、名称、简介、价格、涨跌、走势、成交量；高低价在宽屏显示。
- Adapter 放在 `packages/connectors`，前端只消费 `QuoteSnapshot` / `MarketBoard`。
- 自选仍先存在本机 localStorage，不写入 SQLite。
- 同花顺 A 股本轮未接。

## 改动

- `packages/connectors/src/yahoo.js`、`us-catalog.js`、`asia-catalog.js`、`market-boards.js`、`market-service.js`
- `GET /api/v1/markets`、`GET /api/v1/markets/search`
- 交易页股票看板与手机布局
- `test/markets.test.js`、`test/markets-api.test.js`

## 验证

- `npm test` 19 项通过。
- 本机 `GET /api/v1/markets?board=us` 返回 live，标普 500 / NVIDIA 与旧页一致。
- 浏览器总览出现美股/亚洲宽度；美股分览出现分组和真实涨跌。

## 后续

- 把本机自选迁到 `watchlists` 表。
- 指数 sparkline 为空时补数据源。
- 再接同花顺 A 股总览。
- 全球资产已另接 `board=global`。
