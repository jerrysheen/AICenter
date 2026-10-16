# Polymarket 改为固定观察清单

原来按 24 小时成交额取大约前 100 条，再用标题里的子串关键词留下前 24 条。日频和小时级的加密价格占满名额，地缘、宏观和 GPU 租金进不来。`eth`、`oil` 这类子串也会误伤标题。

现在观察哪些市场只改 `config/polymarket-watchlist.json`。Worker 的 `market.polymarket.watchlist` 每 5 分钟把配置里的 slug 分成每批最多 10 个，请求 `gamma-api.polymarket.com/events`。同一地址的进行中请求会合并，两次请求至少间隔 800 毫秒；遇到 HTTP 429 按 `Retry-After` 退避并打日志。内部用事件 id 做主键，slug 上的时间戳后缀不作为身份。

migration 73 新增两张表，不改旧表，也不删已有的 `event_quote_snapshots`：

- `polymarket_outcomes`：事件、市场、结果、系列、是否在看，以及页面要用的标题和报价。
- `polymarket_probability_points`：每 5 分钟一个概率点。超过 30 天的点收成每小时一个。

较昨日从这张概率表计算，已经写上的值不会再被按小时的事件快照盖掉。多个结果的事件在页面上合成一张卡片，列出领先的几个结果和各自的较昨日。二元事件仍是「Yes / 对立」。页面不展示事件 id、系列 id、slug 或告警配置。

比特币月度区间放了两条 slug：`what-price-will-bitcoin-hit-in-october-2026` 已在 2026-10-16 的接口里核对到。`what-price-will-bitcoin-hit-in-november-2026` 按 2026 年 1 月到 10 月的同一命名写进配置，当天系列 `bitcoin-hit-price-monthly` 里还没有 11 月这场，抓取找不到时不会编造报价，也不会把已经写下的其他市场清掉。全年的 `what-price-will-bitcoin-hit-before-2027` 不在清单里。日频和小时盘也不在清单里。

`AI_CENTER_POLYMARKET_LEGACY=1` 时，看板继续走原来的成交额排序和标题关键词，观察清单任务停用。代码回退时，已经执行过的 migration 73 留在库里，不要删除或改写。

需要同时重启 Web 和 Worker。不要重建数据库。
