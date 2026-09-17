# 持仓沪深现价改用同花顺快照

## 目标

A 股 / B 股现价和当日盈亏应对齐券商实时价，而不是 Yahoo 延迟盘。

## 决定

- Connector 对股票走 `GET /api/a-share/prices/snapshot`，对场内 ETF/LOF 走 `GET /api/fund/market/snapshot`。ETF 不能混进 A 股 `thscodes`，否则整批 `1002`，现价会掉回延迟 Yahoo。
- B 股代码当前不在同花顺 A 股快照里，仍回退 Yahoo。
- 持仓内部仍用 Yahoo 风格 `.SS` / `.SZ`；请求前映射 `.SS` → `.SH`。
- 密钥走 `HITHINK_FINANCE_API_KEY`（与 AI-Hub 同名），可选 `AI_CENTER_FINANCE_BASE_URL`。不把 AI-Hub 代码拷进本仓。
- 未配置密钥或快照失败时回退 Yahoo；港股通和汇率仍走 Yahoo。
- 页面 Contract 不变：只消费 `lastPrice` / `previousClose`。

## 验证

- `npm run check`
- 配置密钥后刷新持仓，芯片 ETF 现价应贴近券商。
