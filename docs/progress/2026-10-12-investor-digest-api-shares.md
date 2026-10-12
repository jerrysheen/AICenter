# 2026-10-12 股民讨论日摘接口隐藏不足样本的占比

外部机器人读 `GET /api/v1/investor-discussion`。南大光电只有 2 条方向发言，库里仍是看多 100%，接口原样返回了 `shares.bull`。

读出时若方向发言少于阈值（默认 5，行上有 `minDirectional` 则用那个数），`crowd.shares` 改为 `null`，并加上 `insufficient: true`。`counts` 和 `sampleSize` 保留。达到阈值时 `shares` 不变，`insufficient` 为 `false`。已经落库的行不用重跑。页面本来就不画这条百分比。

没有新的 migration。Web 重载后即可。Worker 不用重启。
