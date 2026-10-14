# ETF 鲸鱼序列、只读令牌和日 K 缺口

日期：2026-10-14

## 线上

`GET /api/v1/etf-whale/etfs/159915` 固定返回 `{ inPool: false, points: [] }`。`etf_whale_shares` 和 `etf_whale_daily` 里 159915 有数据，最新交易日到 2026-10-08。399006、000688 的日 K 经常只剩当天一根。159915、588000、510300 的日 K 缺 2026-10-13。159915 在 2026-10-14 出现过开 3.029、高 2.981 的柱。

## 决定

- 单只序列改用路由捕获的 `params.values[0]`。
- 总览和单只都是 GET，已登录可读。这两条进入只读令牌白名单。POST 和其他 ETF 鲸鱼路径不开放。
- Worker 启动时登记 `etf.whale.sync`，默认 Asia/Shanghai 18:30。`AI_CENTER_ETF_WHALE_SYNC=0` 关闭。时刻用 `AI_CENTER_ETF_WHALE_AT`，时区用 `AI_CENTER_ETF_WHALE_TIMEZONE`。任务没有写起止日期时，从结束日往前覆盖 `AI_CENTER_ETF_WHALE_LOOKBACK_DAYS` 天，默认 12。第一次跑会把停在 10-08 的份额补到当前。
- 六位 `.SS` / `.SZ` 里，`399xxx.SZ` 和 `000xxx.SS` 走 Tushare `index_daily`。`15/16/50/51/52/56/58` 开头走 `fund_daily`。其余走 `daily`。请求字段加上 `amount`，柱上保留这个成交额，不换算。
- 日 K 在写入 `market_history_cache` 之前丢掉不自洽的柱：`high` 必须大于等于 `max(open, close)`，`low` 必须小于等于 `min(open, close)`。上海收盘（15:00）前，当天的柱不写入、也不当作完整日 K 返回。已缓存的序列如果缺了最后一个已收盘交易日，或者中间缺了 2026 年的交易日，就删掉这行再取。周末和当年休市日不算缺口。

## 验证

`node --test test/etf-whale.test.js test/market-history.test.js test/api-tokens.test.js test/domain-services.test.js test/market-metrics.test.js`

## 重启

需要同时重启 Web 和 Worker。Web 加载路由、白名单和日 K 校验；Worker 才会登记 18:30 的份额同步。不新增 migration。不要重建数据库。
