# ETF 鲸鱼回填换腾讯日线，中金所假期不再记失败

日期：2026-10-15

## 决定

- 指数日线和实际成交额先读腾讯不复权日线：`https://web.ifzq.gtimg.cn/appstock/app/newfqkline/get`，失败再读 `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get`。参数是 `sh000300,day,开始,结束,480,`，最后一截留空，不复权。
- 这一路的 `day` 数组比 `fqkline/get` 多字段。顺序是日期、开盘、收盘、最高、最低、成交量，然后一个对象，再往后第 9 列（下标 8）是成交额，单位万元。入库前 `Math.round(万元 * 10000)`，按元写入。`fqkline/get` 只有 6 列，没有成交额，不用于这两项。
- 单次返回盖不住开始日时，把结束日改到已拿到的最早一根的前一天再请求，直到盖住开始日或没有更早的数据。
- 新浪 `CN_MarketDataService.getKLineData` 现在 HTTP 200，正文是 `{"__ERROR":3,"__ERRORMSG":"Service not valid"}`。这算失败，不当成空数组。新浪仍排在腾讯后面，东财 `push2his` 排在最后。东财在这台非大陆环境能返回元成交额；大陆服务器连不上时会落到失败记录，不把整段悄悄跳过。
- 一只指数或一只 ETF 三个来源都失败时，写 `etf_whale_fetches`：`index-daily:{代码}` 或 `turnover:{代码}`，`status=error`，并打 `[worker] etf-whale`。成功写 `ok`。成交额行的 `source` 仍是 `sina-amount`，这样打分不用改查询；真正用了哪个上游看回填摘要和 `etf_whale_index_daily.source`。
- 回填结束时按上游打印行数：`tencent=`、`sina=`、`eastmoney=`、`errors=`、`rows=`。
- 中金所持仓 URL 没有在 2026-06-24 换格式，也没有分页。仍是 `http://www.cffex.com.cn/sj/ccpm/YYYYMM/DD/IF.xml`（IH、IC、IM 相同）。2026-06-25、2026-06-26、2026-10-14 都返回和 2026-06-24 一样的 XML。`https://www.cffex.com.cn` 握手超时，继续用 http。日期循环本身没有停在 06-24；单日保存或读正文若抛错，原先会把后面的日期整段停掉。现在每一天单独接住，正文另有硬超时，循环走到 `--end`。
- 2024、2025 不在已核对的交易日历里，工作日假期会被当成交易日去拉。中金所对这种日子返回 HTTP 200，并跳到 `error_404.html`。距今天超过 7 天的这种结果记 `holiday`，不再记 `error`。日历里已经标明的休市日直接记 `holiday`，不再发请求。近 7 天的 404 仍记 `error`，17:00 的任务还会再试。已有持仓、`ok` 或 `holiday` 的日期重跑时跳过，原先的 `error` 会再试。
- 2026-06-24、2026-06-25、2026-10-14 的 IF XML 里，简称「中信期货(代客)」的 `partyid` 是 `0018`。默认值不用改。
- 成交额没有当天参考池合计，或 6 个指数都没有跌幅、反弹、尾盘涨幅时，`sTurnover` / `sIndex` 写 null，`inputs_json.insufficient` 带 `turnover` 或 `index`。页面这两项显示「数据不足」。输入都在时，`gjd-score-v1` 的算法不变；缺的那一项不给分，总分仍按 0 计入，避免把已有输入的分数改掉。5 分钟线仍然没有 2024 回补，所以只有日线、没有形态时指数分是数据不足，不是 0。

## 迁移

不新增 migration。`etf_whale_fetches.status` 继续用已有的 `error` 和 `holiday`。信号表的 `s_turnover`、`s_index` 本来就能空。下一号仍是 73。

## 已核对的上游

在当前这台非大陆环境实请求：

- 腾讯 `newfqkline`：沪深300、上证50、中证500、中证1000、科创50、创业板指，以及 510300、159915，HTTP 200，不复权，第 9 列有成交额。沪深300 2024-01-02 为 18409609.74 万元，折 184096097400 元；东财同日 184096097448.70 元，差 48.70 元。510300 2024-01-05 为 579696.45 万元，东财 5796964474 元。
- `proxy.finance.qq.com` 的同一路径与 `web.ifzq.gtimg.cn` 对中证500返回同一行。
- 新浪日 K：HTTP 200，`__ERROR` 3，`Service not valid`。
- 东财 `push2his.eastmoney.com`：这里能拿到元成交额。大陆机器连不上时只作为最后兜底。
- 中金所上述 XML：2024-01-02、2026-06-24 至 2026-06-26、2026-10-14 有持仓；2024-02-09、2024-10-01 是 404 页。

## 重启和补数

需要同时重启 Web 和 Worker。Worker 下次 15:30、17:00 才会走新的抓取和打分。不要重建数据库，不清 `jobs.attempt_count`。

先在服务还开着时备份并检查完整性：

```bash
sqlite3 data/ai-center.db "VACUUM INTO 'data/ai-center.db.bak-20261015-kline';"
sqlite3 data/ai-center.db "PRAGMA integrity_check;"
```

`integrity_check` 应返回 `ok`。部署并重启之后重跑。`--end` 省略时用上海今天。已经入库的中金所持仓会跳过，2026-06-24 之后会继续；原先记成 error 的假期会改成 holiday。

```bash
node --env-file=.env scripts/etf-whale-backfill.mjs index-daily --start 2024-01-02 --end 2026-10-15
node --env-file=.env scripts/etf-whale-backfill.mjs turnover --start 2024-01-02 --end 2026-10-15
node --env-file=.env scripts/etf-whale-backfill.mjs futures --start 2024-01-02 --end 2026-10-15
node --env-file=.env scripts/etf-whale-backfill.mjs signals --start 2024-01-02 --end 2026-10-15
```

`signals` 不访问交易所，放在最后。份额和 `supersede-stack-errors` 这次不用重跑。
