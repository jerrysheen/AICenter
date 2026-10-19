# 股票资金单独成页

2026-10-19 港股通南向卡片从市场概览、A股、美股市场、亚洲市场拿掉。股票子页最后新增「资金」，地址是 `#market/flow`。刷新和深链接都停在这一页，电脑和手机共用这一条路由。

南向仍读 `GET /api/v1/market/southbound`。金额写成「净买入 / 净卖出 … 亿港元」，并标明数据日期。不是今天时写成「数据日期 YYYY-MM-DD，不是今天」。

北向没有新的上游。东财 `RPT_MUTUAL_DEAL_HISTORY` 的 `001` / `003` / `005` 和 `RPT_MUTUAL_TOP10DEAL` 里对应的行，以及港交所日文件里的 `SSE Northbound`、`SZSE Northbound`，原来就在南向那一次请求里，解析时被丢掉。2026-10-16 的夹具里，这三档的 `NET_DEAL_AMT`、`BUY_AMT`、`SELL_AMT` 都是 null，十大成交的 `NET_BUY_AMT` 也是 null。成交额还在，并且和港交所总成交额一致：汇总单位是百万元人民币，十大成交单位是元。页面只显示成交额和沪、深各自的十大成交，写明「每日净买入没有公布。2024年8月19日起……这里的金额是成交额，不是净流入。」没有入库时写「北向成交额还没有入库，所以没有数据日期。」不把成交额显示成净流入。

同一任务 `southbound.daily.sync` 在 17:00 和 17:30（Asia/Shanghai）顺手把北向成交额和十大成交写入新表。港交所北向成交额和东财合计相差超过 1% 时，卡片只显示「与港交所成交额不一致」。页面不出现供应商、`check_status`、`fetchedAt`、「更新时间」或「已处理」。

migration 88 `northbound_flow` 只建 `northbound_daily` 和 `northbound_top10`。表里没有净额列。87 仍是 YouTube 补录。空号仍是 63、79、80、82。不要重建数据库。需要同时重启 Web 和 Worker。历史成交额用原来的回填命令补，进度另记 `northboundThrough`：

`node --env-file=.env scripts/southbound-backfill.js --from 2021-10-16 --to 2026-10-16 --part northbound`

`--part all` 也会补北向。南向已经补过的日期不会因为这次重抓。
