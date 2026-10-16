# 看板改读观察清单

`GET /api/v1/market-native/board` 不带 `predictionLimit` 时，默认只返回快照里的前 24 条。观察清单按配置顺序排在后面的黄金 GC、地缘、H100、H200 和比特币因此不会出现，11 月的「下一期尚未出现」也看不到。快照里的旧成交额排序结果同样不会再盖掉观察清单。

Web 现在用 `polymarket_outcomes` 里 `watched = 1` 的行替换快照中的 Polymarket 报价。Kalshi 等其他场所仍来自快照。`AI_CENTER_POLYMARKET_LEGACY=1` 时继续只用快照。

H100 的种子 slug 改为 `gpu-rental-prices-h100-end-of-october`。2026-10-16 对活接口核对过：事件 id `836031`，标题 “GPU rental prices (H100) end of October?”，系列 `h100-rental-price`，尚未结束。发布日和 H200 一样，是纽约时间 2026-10-31。持有一期，10 月结算后滚动到 11 月。

生产库里已经有 H100 的 11 月行、还没有 10 月种子时，下一次观察清单抓取会请求 `gpu-rental-prices-h100-end-of-october`。只要这个种子还没结束，它就盖过同一系列里更晚结束的事件。种子已经在库里并且已结束，或处在「下一期尚未出现」时，继续按原来的滚动规则找下一月。

看板把快照和观察清单放在同一层 45 秒缓存里。`predictionLimit` 只截断 Kalshi 等其他场所，观察清单全部保留。没有观察清单时，快照仍按 `predictionLimit` 的两倍截断。

不新增 migration。需要重启 Web。Worker 也要重启，下一次抓取才会改跟踪 H100 的 10 月。
