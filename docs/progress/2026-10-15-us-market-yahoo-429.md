# 美股看板停在旧快照

2026-10-15 美股交易时段，看板里 ^GSPC、AAPL、NVDA 的 `lastPrice` 连续几小时是 null，快照任务仍记成功。Worker 重启后大约两分钟又冻住。同一台机器上 `curl` Yahoo spark 返回 HTTP 429。单独起一个新的 Node 进程用仓库里的 Yahoo 客户端可以一次拿满报价，因为新进程还没有把额度打满。

## 原因

`market.boards.snapshot` 和 `market.holdings.snapshot` 每分钟各打一轮 Yahoo。看板读美股、亚洲和全球资产，持仓用 `refresh: true` 绕过 20 秒缓存。几路一起把 `query1.finance.yahoo.com` 打到 429。请求等到单次超时（大约 8–12 秒，加上调度就是观察到的约 13 秒一轮）才失败。失败被 `Promise.allSettled` 丢掉，`loadUs` 用空 `catch` 吞掉错误，看板被当成空结果。

`cached()` 发现新结果没有价格，就返回上一份结果，不更新缓存时间，也没有上限。`fetchedAt` 停在最后一次成功的时刻。快照任务不看这个时间，所以仍然成功。页面一直显示那一份旧报价。

`market.native-board.snapshot` 读的是 Polymarket、Kalshi 和 Hyperliquid，不请求 Yahoo。它和上面两路排在同一分钟，Yahoo 把主线程堵到超时的时候，这一路也会一起变慢。

## 改动

- 进程内共用一层 Yahoo 报价：同一拍进来的代码合成一次请求，进行中的代码复用同一个 Promise。默认缓存 45 秒（`AI_CENTER_YAHOO_CACHE_MS`，30–60 秒），所以同一分钟里的看板和持仓用同一份报价。两次请求至少间隔 800 毫秒（`AI_CENTER_YAHOO_MIN_INTERVAL_MS`）。单次超时默认 8 秒（`AI_CENTER_YAHOO_TIMEOUT_MS`）。生产请求走单独的 undici 连接池，连接数 2，连接、响应头和正文超时都跟这一次请求走，不再占用全局 `fetch` 连接池。
- HTTP 429 按 `Retry-After` 和本进程退避里较大的一个等待，从 15 秒起翻倍，上限 5 分钟，并打 `[market] Yahoo HTTP 429`。退避期间不再访问 Yahoo。
- 401 或空的 spark 结果会重新取 cookie 和 crumb，再试一次。
- Yahoo 失败或正在退避时，美股和指数改走腾讯 `qt.gtimg.cn`（`usAAPL`、`usNVDA`、`us.INX`、`us.DJI`、`us.IXIC`）。腾讯没有的，包括 `^SOX`，改走新浪 `hq.sinajs.cn`（`gb_aapl`、`gb_sox`），请求带 `Referer: https://finance.sina.com.cn`。字段按 2026-10-15 的实测正文解析。超过 3 天的报价丢掉，所以腾讯上停在 9 月的 VIX 不会盖掉上一份价格。每条报价的 `provider` 写成 `yahoo`、`tencent` 或 `sina`。
- 上一份有价格的看板继续留着。默认 3 分钟内不标过期（`AI_CENTER_MARKET_STALE_MS`）。超过之后 payload 带 `stale: true`，价格不删。页面状态写成「已过期 · 10月15日 21:40」，时间是上海时间的 `fetchedAt`。
- 报价为 0，或者不到期望数量的一半，打 `[market] 美股报价不足`。请求抛错时记下原来的错误，不再使用空的 `catch`。
- 美股常规交易时段（美东 9:30–16:00，工作日）如果 `fetchedAt` 超过 10 分钟（`AI_CENTER_MARKET_US_FRESH_MS`），看板快照先写入再把任务标失败，并打警告。休市不因为这个失败。

不新增 migration。

## 重启

需要同时重启 Web 和 Worker。Worker 重启后才会换上共享报价层和 429 退避。Web 重启后页面才会显示「已过期」。不要重建数据库。
