# ETF 鲸鱼缺分钟线时用日线近似指数分

日期：2026-10-15

## 决定

- 新浪 5 分钟线大约只有最近 1000 根，覆盖不了 2024 以来的交易日。`index-daily` 回填只写腾讯日线的开高低收和成交额，形态列是空。
- 形态列是空，或三列都是 0 且没有 `low_time` 时，不当作已经测过的 0 分。`saveSignal` 若看到 `inputs_json.insufficient` 含 `index` 或 `turnover`，对应列写成 null。缺数据时接口分项是 null，页面写「数据不足」。
- 该指数当天 `etf_whale_intraday_bars` 有 5 分钟线时，仍用原来的规则，并优先于日线近似：最低价相对昨收跌超过 1% 且收盘相对最低价反弹至少 1%，或尾盘（收盘相对 14:30）涨幅至少 1%，算命中。
- 没有 5 分钟线、但日线开高低收自洽时，用日线近似。`inputs_json.index.method` 为 `daily-approx`。同一天有的指数走分钟、有的走日线时，`method` 为 `mixed`。全部走分钟时是 `intraday`。
- 日线近似命中满足任意一条：
  - 最低价相对昨收跌超过 1%，收盘相对最低价反弹至少 1%，且收盘处在当日高低区间的上 30%（`(close-low)/(high-low) >= 0.7`）。
  - 下影线至少占当日高低区间的 40%（`(min(open,close)-low)/(high-low) >= 0.4`），收盘不低于开盘，且收盘相对最低价反弹至少 1%。
  - 成交额至少是此前最多 20 个交易日成交额算术平均的 1.5 倍（至少要有 10 个更早的成交额），最低价相对昨收跌超过 0.5%，收盘在高低区间上 30%，且收盘相对最低价反弹至少 1%。
- 命中个数不变：1 个指数 15 分，至少 2 个或沪深300自己命中 25 分，否则这一项是 0。0 分表示近似做了、形态没有命中，不是数据不足。
- 成交额、净申购、同时异常不改。总分把指数分加回去，档位按原来的 70 / 50 / 30 重算。初判仍用折算分。
- 日线开高低收不自洽，或该指数没有日线时，这一项不参与。6 个指数都没有分钟线也没有可用日线时，`sIndex` 为 null，`insufficient` 含 `index`。
- 15:30 的 `etf.whale.market` 固定抓 `quotes`、`intraday`、`index`、`turnover`。5 分钟线继续写入 `etf_whale_intraday_bars`。没有单独的 2024 分钟回填。

## 迁移

不新增 migration。方法记在已有的 `etf_whale_signals.inputs_json`。`s_index` 本来就能空。下一号仍是 73。

## 重启和重算

需要同时重启 Web 和 Worker。Worker 下次 15:30 才会继续累加 5 分钟线。不要重建数据库，不清 `jobs.attempt_count`。

指数日线和成交额已经在库里时，只重算分数。`--end` 省略时用上海今天。

```bash
sqlite3 data/ai-center.db "VACUUM INTO 'data/ai-center.db.bak-20261015-index-approx';"
sqlite3 data/ai-center.db "PRAGMA integrity_check;"
node --env-file=.env scripts/etf-whale-backfill.mjs signals --start 2024-01-02
```

`integrity_check` 应返回 `ok`。`signals` 不访问交易所。
