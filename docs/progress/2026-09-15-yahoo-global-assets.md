# 全球资产接入 Yahoo

## 目标

把交易页「全球资产」从 mock 换成真实行情，页面继续只读稳定符号和 `assetClass`，不暴露 Yahoo 原始代码。

## 决定

- 复用已有 Yahoo spark Adapter 与 `GET /api/v1/markets`；新增 `board=global`。
- 页面符号保持 `DXY`、`USDCNY`、`XAUUSD`、`CL`、`GC` 等；Yahoo 代码只作为 `InstrumentAlias` 语义的 Connector 映射。
- 实测：`XAUUSD=X`、`DXY`、`DX=F` 无稳定报价；黄金用 `GC=F`，美元指数用 `DX-Y.NYB`。
- 不引入 Massive 或其他付费源。

## 改动

- `packages/connectors/src/global-catalog.js`
- `packages/connectors/src/market-boards.js`、`market-service.js`
- `packages/contracts/src/index.js` 允许 `board=global`
- 全球资产页改为与美股观察池同一套行：简介、日内走势、涨跌幅排序、成交量和高低。
- `test/markets.test.js`、`test/markets-api.test.js`、`test/contracts.test.js`

## 验证

- 本机 Yahoo spark：10 条全部报价（上证、标普、DXY、USD/CNY、十年美债、COMEX 黄金、WTI、BTC、ETH）。
- `npm test` 52 项通过。`npm run check` 的 `architecture:verify` 仍被既有 `packages/connectors/src/x/index.js` 依赖 domain 拦住，与本轮无关。
- 浏览器交易页「全球资产」显示 Yahoo 实时价；分类「加密」只剩比特币/以太坊；股票总览仍正常。

## 后续

- 黄金现货若找到稳定公开源，再替换 `GC=F` 代理。
- 全球资产自选与报价落库仍未做。
