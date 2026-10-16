# 看板改读观察清单

`GET /api/v1/market-native/board` 不带 `predictionLimit` 时，默认只返回快照里的前 24 条。观察清单按配置顺序排在后面的黄金 GC、地缘、H100、H200 和比特币因此不会出现，11 月的「下一期尚未出现」也看不到。快照里的旧成交额排序结果同样不会再盖掉观察清单。

Web 现在用 `polymarket_outcomes` 里 `watched = 1` 的行替换快照中的 Polymarket 报价。Kalshi 等其他场所仍来自快照。`AI_CENTER_POLYMARKET_LEGACY=1` 时继续只用快照。

H100 的种子 slug 改为 `gpu-rental-prices-h100-end-of-october`。2026-10-16 对活接口核对过：事件 id `836031`，标题 “GPU rental prices (H100) end of October?”，系列 `h100-rental-price`，尚未结束。发布日和 H200 一样，是纽约时间 2026-10-31。持有一期，10 月结算后滚动到 11 月。

不新增 migration。需要重启 Web。Worker 不用为这项重启。
