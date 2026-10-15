# ETF 鲸鱼多次补份额和新行情源

日期：2026-10-15

## 决定

- 份额按 T+1 公布。北京时间 09:00、12:00、16:30、18:30、20:30 各入队一次 `etf.whale.sync`。上一交易日的上交所和深交所份额都已经到齐，并且没有 pending 时，这次直接跳过，不再打交易所。
- 15:30 入队 `etf.whale.market`：参考池和 588000 的腾讯前复权日线、6 个指数和这些 ETF 的 5 分钟线、指数日线、不复权实际成交额。17:00 入队 `etf.whale.futures`，抓 IF/IH/IC/IM。
- 原来的单次调度键 `etf.whale.sync` 在启动时关掉，避免和 18:30 的新槽重复。`maxAttempts` 是 3。
- 上交所返回空：交易日（510300 日线有这一天，否则用交易日历；日历未覆盖的年份按工作日）记 `pending`，非交易日记 `holiday`。pending 下次必抓，不受 `refreshFrom` 和 12 天回看限制。距该日超过 5 个交易日仍空，改为 `stale`，并写 `[worker] etf-whale sse stale`。
- 深交所分段不再只看 `status=ok`。最大份额日已经不早于结束日前最后一个交易日才跳过。同日先手动跑过、但文件还没覆盖到最后交易日时，定时任务会再抓。
- `xlsx-workbook.js` 用逐格比较得到列宽，不再把全部单元格展开进 `Math.max`。Worker 登记调度时，把深交所 `error` 文本含 `Maximum call stack` 的记录改成 `superseded`。只改状态，不删行，可重复执行。
- 5 分钟线先读新浪 `CN_MarketDataService.getKLineData` `scale=5`，失败再用东财。新浪大约只有最近 1000 根，从现在累加，不在启动时回补更早的 5 分钟线。
- 指数日线先读新浪 `scale=240`，不够再用东财日线。实际成交额优先用带 `amount` 的日线，否则用东财不复权成交额，统一写入 `source='sina-amount'`。
- 中金所 XML 只在服务器上抓。测试用夹具。会员按 `partyid` 识别。中信期货默认 `0018`，可用环境变量改。简称乱码不影响识别。净空只入库，这一阶段不计分。
- 启动和定时任务都不按历史区间自动补数。补数是手动命令，不清 `jobs.attempt_count`，不重建数据库。

## 调度默认值

不改 `.env` 也会用这些时刻。要改时写：

```text
AI_CENTER_ETF_WHALE_SHARE_AT=09:00,12:00,16:30,18:30,20:30
AI_CENTER_ETF_WHALE_MARKET_AT=15:30
AI_CENTER_ETF_WHALE_FUTURES_AT=17:00
AI_CENTER_ETF_WHALE_CITIC_PARTY_ID=0018
```

`AI_CENTER_ETF_WHALE_SYNC=0` 仍关闭全部槽位。`AI_CENTER_ETF_WHALE_AT` 不再充当唯一一次份额抓取。中信期货的 `partyid` 需要对照服务器上当天 XML 里简称是中信期货的那一行；默认 0018 只是起点。

## 手动补数

先在服务还开着时做一致备份，并检查完整性。下面的路径是 Instance 数据库，常见是 `data/ai-center.db`：

```bash
sqlite3 data/ai-center.db "VACUUM INTO 'data/ai-center.db.bak-20261015';"
sqlite3 data/ai-center.db "PRAGMA integrity_check;"
```

`integrity_check` 应返回 `ok`。然后：

```bash
node --env-file=.env scripts/etf-whale-backfill.mjs shares --start 2026-10-08 --end 2026-10-15
node --env-file=.env scripts/etf-whale-backfill.mjs index-daily --start 2024-01-02 --end 2026-10-15
node --env-file=.env scripts/etf-whale-backfill.mjs turnover --start 2024-01-02 --end 2026-10-15
node --env-file=.env scripts/etf-whale-backfill.mjs futures --start 2024-01-02 --end 2026-10-15
node --env-file=.env scripts/etf-whale-backfill.mjs supersede-stack-errors
```

`supersede-stack-errors` 和 Worker 启动时做的是同一件事。5 分钟线没有单独的历史命令，15:30 的任务会把新浪当前能给的根写入 `etf_whale_intraday_bars`。

## 迁移

migration 70，只建五张新表。69 已由硬件报价当前规格占用。`etf_whale_fetches.status` 增加使用 `pending`、`holiday`、`stale`、`superseded`，没有改列。

## 重启

需要同时重启 Web 和 Worker。Worker 才会关掉旧的 18:30 单次槽，并登记新的份额、行情和中金所任务。不要重建数据库。
