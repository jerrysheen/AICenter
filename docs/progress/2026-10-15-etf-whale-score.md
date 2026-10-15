# ETF 鲸鱼打分和日频接口

日期：2026-10-15

## 决定

- 算法 `gjd-score-v1`，满分 100。打分池是参考池 20 只。`588000` 留在观察池里作对照，不进池，也不计入合计。
- 成交额、净申购、同时异常、指数形态各 25 分。分位用当天之前最多 250 个交易日，不含当天。
- 同时异常仍是至少 3 只才从 15 分起算，每多 1 只加 2.5，上限 25。单只成交额达到自己近 20 日中位数的 8 倍时，基础分至少取 15，再与只数规则取高。有红色标记加 5，仍不超过 25。例如只有 510310 约为 25 倍时，这一项是 15+5=20。
- 确认阶段里，单只份额变化的 250 日分位达到 95 也算异常，计入只数，不因此标红。
- 指数形态不加部分分。6 个指数里，最低点相对昨收跌超过 1% 且收盘相对最低点反弹至少 1%，或者尾盘涨幅至少 1%，算命中。1 个命中 15 分。至少 2 个命中，或沪深300自己命中，是 25 分。
- 初判在 T 日 15:30 的 `etf.whale.market` 之后写入，只算成交额、同时异常和指数，满分 75，并保存折算后的 100 分制。确认分在份额任务写完日频之后补上净申购，满分 100。净申购小于等于 0 时这一项是 0。
- 确认分大于等于 70 是强疑似，50 到 69 是疑似，30 到 49 是观察。初判用折算分套同一档。同一算法可以重算，按日期、阶段和算法覆盖。
- 中信期货 IF/IH/IC/IM 净空和净空变化只在日频接口展示，不进入分数。
- `GET /api/v1/etf-whale/etfs/{code}` 是正式路径。格式不对由处理函数抛 `ValidationError`，路由返回 400。不在观察池返回 404，`error` 为 `not_in_universe`。`GET /api/v1/etf-whale/series?code=` 返回同一份正文；`code` 缺失或格式不对也是 400。
- 总览增加 `sharesLatest`、`quotesLatest`、`pendingDates`，用来区分份额截至日和行情截至日。
- 只读令牌新增 `daily`、`signals`、`series`。持仓和个人资产接口不开放。
- 页面和接口写明「不构成投资建议」。
- 页面请求不打分。15:30 行情任务写初判，份额任务写确认分。历史重算用手动命令，启动时不跑。

## 迁移

不新增 migration。`etf_whale_signals` 已在 migration 70。69 仍是硬件报价当前规格。

## 手动补数

先备份并检查完整性。路径按 Instance 数据库，常见是 `data/ai-center.db`：

```bash
sqlite3 data/ai-center.db "VACUUM INTO 'data/ai-center.db.bak-20261015';"
sqlite3 data/ai-center.db "PRAGMA integrity_check;"
```

`integrity_check` 应返回 `ok`。然后抓数，最后才重算分数。`signals` 不访问交易所，只读已经入库的成交额、份额和指数形态：

```bash
node --env-file=.env scripts/etf-whale-backfill.mjs shares --start 2026-10-08 --end 2026-10-15
node --env-file=.env scripts/etf-whale-backfill.mjs index-daily --start 2024-01-02 --end 2026-10-15
node --env-file=.env scripts/etf-whale-backfill.mjs turnover --start 2024-01-02 --end 2026-10-15
node --env-file=.env scripts/etf-whale-backfill.mjs futures --start 2024-01-02 --end 2026-10-15
node --env-file=.env scripts/etf-whale-backfill.mjs supersede-stack-errors
node --env-file=.env scripts/etf-whale-backfill.mjs signals --start 2024-01-02 --end 2026-10-15
```

5 分钟线没有单独的 2024 回填。15:30 的任务会把新浪当前能给的根累加进 `etf_whale_intraday_bars`。不清 `jobs.attempt_count`，不重建数据库。

## 环境变量

代码里已有默认值，不改 `.env` 也会按这些时刻跑。要写进 `.env` 时用：

```text
AI_CENTER_ETF_WHALE_SHARE_AT=09:00,12:00,16:30,18:30,20:30
AI_CENTER_ETF_WHALE_MARKET_AT=15:30
AI_CENTER_ETF_WHALE_FUTURES_AT=17:00
AI_CENTER_ETF_WHALE_CITIC_PARTY_ID=0018
```

`AI_CENTER_ETF_WHALE_SYNC=0` 关闭全部槽位。`AI_CENTER_ETF_WHALE_AT` 不再决定唯一一次份额抓取。中信期货的 `partyid` 要对照服务器上当天 XML 里简称是中信期货的那一行；默认 `0018` 需要核实。简称乱码时以 `partyid` 为准。

## 重启

需要同时重启 Web 和 Worker。Worker 才会在行情和份额任务末尾写分数。不要重建数据库。
