# 港股通南向资金日度

2026-10-16 从这台环境直接请求过东财和港交所，原始响应在 `test/fixtures/southbound/`。

东财汇总 `RPT_MUTUAL_DEAL_HISTORY`。`MUTUAL_TYPE`：`001` 沪股通、`002` 港股通（沪）、`003` 深股通、`004` 港股通（深）、`005` 北向合计、`006` 南向合计。只入库 `002`、`004`、`006`，对应 `sh`、`sz`、`total`。买卖额、净额、成交额的单位是百万港元，入库前乘 1,000,000，取整为港元。可以按日期区间分页：`filter=(MUTUAL_TYPE="006")(TRADE_DATE>='2026-10-01')(TRADE_DATE<='2026-10-16')`，`pageNumber` / `pageSize`，`sortColumns=TRADE_DATE`，`sortTypes=-1`。10 月 1 日到 16 日返回 `pages=3`、`count=7`，只有交易日。

十大成交 `RPT_MUTUAL_TOP10DEAL`，`filter=(TRADE_DATE='YYYY-MM-DD')`。2026-10-16 返回 40 行，四种类型各 10 行。`002` 和 `004` 按代码相加，存成 `channel=total`、`source=derived`，按净买卖额绝对值排序。金额已经是港元。

港交所 `www.hkex.com.hk/eng/csm/DailyStat/data_tab_daily_YYYYMMDDe.js`。`tabData` 里南向市场是 `SSE Southbound` 和 `SZSE Southbound`。汇总表字段是 Total Turnover、Buy Turnover、Sell Turnover、Total Trade Count、Buy Trade Count、Sell Trade Count、ETF Turnover，单位百万港元。十大成交字段是 Rank、Stock Code、Stock Name、Buy Turnover、Sell Turnover、Total Turnover，单位港元。HTTP 404 视为当天没有这份文件。

2026-10-16 参考值：`006` 净额 -3568.43 百万港元，合 -35.68 亿港元。沪 -2065.77、深 -1502.66，两者相加等于合计。成交额 65402.11 百万港元。沪、深成交额相加等于合计。合并后净额绝对值前三：友邦保险 `01299` +7.64 亿、药明生物 `02269` -6.68 亿、小米集团-W `01810` -5.06 亿。港交所沪深南向成交额加总是 65,402,110,000 港元，和东财合计相同，差异 0。

金额一律存港元。`southbound_daily` 主键是工作区、交易日、通道。`southbound_top10` 主键是工作区、交易日、通道、代码，另有 `(workspace_id, code, trade_date DESC)`。写入是 upsert。同一天再抓只更新这一行。

任务名 `southbound.daily.sync`。默认每天 17:00 和 17:30（Asia/Shanghai），可用 `AI_CENTER_SOUTHBOUND_AT` 改成 `HH:MM` 或 `HH:MM,HH:MM`。只给一个钟点时，补跑在 30 分钟后。`AI_CENTER_SOUTHBOUND_SYNC=0` 关闭排程。同一槽位已经排队或正在跑时不再入队。请求超时 15 秒，两次上游请求至少间隔 1 秒。

交易日在任务里判断。`hk-connect-calendar.js` 使用港交所 2026 年沪深港通日历：周末关闭；港股休市或沪深休市也关闭。2026-12-24 和 2026-12-31 是半日，南向仍开放。2027 年港股通正式日历还没有公布，交易日历页只有 2025 和 2026 的 CSV。港交所通告 CT/077/26（2026-06-01）和港交所日历给出了 2027 年港股休市，这些工作日直接关闭，不再请求上游。2027 年其余工作日，以及更早、更晚还没有整年日历的日子，不当成休市。实时任务里东财还没有数时，17:00 记 `pending`，17:30 记 `late`。回填时两边都没有数据仍记 `closed_by_data`，不入库。当天合计已经是 `ok`，并且当天已经有合并后的十大成交，才跳过。17:00 十大成交失败时汇总仍可以是 `ok`；17:30 只再拉十大，不重写汇总。

校验只比成交额：港交所沪深南向成交额之和相对东财合计。差异超过 1% 记 `mismatch`，1% 及以内记 `ok`。港交所文件不存在只记 `hkex_missing`，不把这一天判失败。请求港交所时 Referer 用 `https://www.hkex.com.hk/`，不带东财地址。告警不推送。`mismatch` 和 `late` 写入 `provider_health` 为 unhealthy，`hkex_missing` 为 degraded。17:00 还没有数是常态，`pending` 保持 healthy，快照里写「等待公布」。同一份状态写入 `runtime_snapshots` 键 `southbound-health`。卡片只显示中文角标：「与港交所成交额不一致」「港交所尚未公布」「今日南向尚未公布」。等待公布时显示「等待公布」。卡片另有一句：「十大成交口径：合计是沪、深各自前十相加。只进了一边前十的股票，另一边的成交会少算。」页面不出现 `check_status`、`source` 或供应商字段。

接口：

- `GET /api/v1/market/southbound?days=20`，`days` 为 1 到 60，默认 20。未加版本的 `/api/market/southbound` 同样可读。
- `GET /api/v1/market/southbound/top10?date=YYYY-MM-DD`。带 `code` 时返回该代码近 N 日合计记录。

股票页南向卡片和行情分开加载，有 60 秒缓存。卡片含当天沪、深、合计净买入，近 20 日柱，5 日和 20 日累计，净买和净卖各前 5。点名称打开个股。持仓里当天进入合计前十的港股通代码显示「南向 +7.64 亿」这类标签。个股页对 `*.HK` 显示近 20 日南向记录。只读令牌可以读南向接口，持仓接口仍不在白名单里。

日报列表和研究方向日报在未打开单篇时多一行，例如「南向净卖出 35.68 亿港元；友邦保险 +7.64 亿、药明生物 -6.68 亿、小米集团 -5.06 亿」。小时报不读这条。

回填：`node --env-file=.env scripts/southbound-backfill.js --from 2021-10-16 --to 2026-10-16`。汇总按传入区间抓，建议至少 3 年、这次按 5 年。`--part all`（默认）时十大成交只补区间末端最近 365 天。进度写在数据库旁边的 `southbound-backfill.json`。中断或上游暂时失败后，同一命令从下一天继续。已经记过的日期不重抓。港交所 404 标 `hkex_missing`。两边都没有数据记 `closed_by_data`，不入库。回填不写健康状态。

migration 81 `southbound_flow` 只建这两张表和索引，语句带 `IF NOT EXISTS`，在事务里执行。77–79 尚未分配。80 留给其他功能，这次不占用。63 仍空着。按 `schema_migrations.version` 补执行，不看最大号。不要重建数据库。需要同时重启 Web 和 Worker。回填放在重启之后。

回滚：把 `AI_CENTER_SOUTHBOUND_SYNC` 设为 `0`，再重启 Worker，排程停止。已经写入的行留在两张表里。不要为了撤回而删表或重建数据库。代码撤回之后，已经执行过的 81 不会重跑，表可以空着。
