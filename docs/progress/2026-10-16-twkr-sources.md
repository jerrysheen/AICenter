# 台湾和韩国第一批来源

2026-10-16 从这台服务器核对过这些地址可以打开。旧的钜亨 RSS 会 404，所以台股新闻改走 JSON。DigiTimes 公开 RSS 只有标题和摘要，正文在付费墙后面，不跟进文章页。THE ELEC 用 `https://www.thelec.net/rss/allArticle.xml`。`config/media.json` 里原来的 `thelec` 仍指向 CDN，并且保持关闭，避免和这条新地址抢同一条来源。`digitimes` 仍是需要许可的接口，也不启用；公开 RSS 用来源 id `digitimesrss`。

新闻写入现有媒体索引，频道是产业科技：

| 来源 | 地址 | 间隔 |
| --- | --- | --- |
| 证交所重大讯息 `twsematerial` | `https://openapi.twse.com.tw/v1/opendata/t187ap04_L` | 15 分钟 |
| 钜亨网台股 `cnyes` | `https://api.cnyes.com/media/api/v1/newslist/category/tw_stock?limit=30` | 12 分钟 |
| 工商时报证券 `ctee` | `https://www.ctee.com.tw/rss_web/livenews/stock` | 12 分钟 |
| 经济日报 `udnmoney` | `https://money.udn.com/rssfeed/news/1001/5590?ch=money` | 12 分钟 |
| DIGITIMES `digitimesrss` | `https://www.digitimes.com/rss/daily.xml` | 15 分钟 |
| THE ELEC `thelec` | `https://www.thelec.net/rss/allArticle.xml` | 15 分钟 |

发布时间用稿件自己的时间。证交所用发言日期和发言时间，民国年换成公元，时区是台北。工商时报和 THE ELEC 的时间没有时区，分别按台北和首尔（都是 UTC+8）解释。钜亨用 `publishAt` 的 Unix 秒。经济日报和 DIGITIMES 的 RSS 自带时区。没有可解析时间的条目不入库，也不改用抓取时间。

同一来源、同一链接或同一外部 id 不另建一条。一轮每个来源最多新写入 40 条，更早的留到下一轮。重大讯息的链接带上公司代号、发言时间和主旨摘要，避免同一家公司的不同公告被收成一条。

翻译不新开模型。新条目交给已有的 `media.index.enrich`，仍只走 Gemma 26B。

证交所月营收 `twserevenue` 每天 08:30（Asia/Shanghai）抓 `https://openapi.twse.com.tw/v1/opendata/t187ap05_L`。行按工作区、公司代号和资料年月累加。同一个月再次出现只更新这一行，以前的月份留着。它不写媒体索引，也不进新闻流。

每个来源一条任务：`feed.twkr.news` 或 `feed.twkr.revenue`。不放进 `media.sources.sync`，也不放进订阅同步。这个来源已经排队或正在跑时，调度不再入队。请求用 `AbortSignal.timeout`，默认 15 秒（`AI_CENTER_TWKR_TIMEOUT_MS`，5 到 30 秒）。月营收文件大约 600KB，默认同样 15 秒；下载偏慢时把 `AI_CENTER_TWKR_REVENUE_TIMEOUT_MS` 调到 5 到 60 秒，它仍是单独的每日任务。

单源开关有两处，环境变量优先。`config/twkr-sources.json` 里把对应键写成 `false`。或者设置 `AI_CENTER_TWKR_TWSEMATERIAL`、`AI_CENTER_TWKR_TWSEREVENUE`、`AI_CENTER_TWKR_CNYES`、`AI_CENTER_TWKR_CTEE`、`AI_CENTER_TWKR_UDNMONEY`、`AI_CENTER_TWKR_DIGITIMESRSS`、`AI_CENTER_TWKR_THELEC`。`0` 关闭，`1` 打开。改完要重启 Worker。

migration 76 `twse_monthly_revenue` 只建表和索引，语句带 `IF NOT EXISTS`。75 仍是 GPU 日表。不要重建数据库。需要重启 Worker。Web 不用为这项重启。

回滚：把上述开关全部设为 `0` 或在配置里写成 `false`，再重启 Worker，抓取就停。已经写入的新闻留在媒体索引里，月营收行也留在 `twse_monthly_revenue`。不要为了撤回而删表或重建数据库。代码撤回之后，已经执行过的 76 不会重跑，表可以空着。
