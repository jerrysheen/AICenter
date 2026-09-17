# 股票看板一直停在「正在连接行情」

## 目标

总览 / 美股 / 亚洲切换后不再假装还在连接；失败、未配对或超时要把原因写在状态行上。

## 决定

- 未配对时不再静默跳过拉数，状态显示「尚未配对」。
- Yahoo 单批失败或整体抛错时仍返回看板（空价 + 部分数据说明），避免前端一直停在占位文案。
- 行情请求 25 秒超时；同看板并发请求共用一次 Yahoo 拉取。

## 改动

- `apps/web/public/app.js`：状态文案、配对门槛、超时、过期响应丢弃。
- `packages/connectors/src/yahoo.js`：分批并行，单批失败不中断。
- `packages/connectors/src/market-service.js`：Yahoo 抛错时仍组板；进行中请求去重。
- `test/markets.test.js`：Yahoo 失败仍返回 partial。

## 验证

- `npm test` 覆盖 Yahoo 失败组板。
- 本机 `/api/v1/markets?board=us` 在修复前已能返回 live；前端主要修的是失败/未配对时的假连接文案。

## 后续

- 手机需重新打开网页或杀掉鸿蒙壳再进，才能拿到新的 `app.js`。
- 后端 Yahoo 容错需重启 `npm start` 后生效。
