# 官方发布列表在手动重定向后变成 0 条

#163 把官方请求改成 `redirect: 'manual'` 之后，发布列表连续多轮是 0 条，日历仍有数据，任务也显示完成。日志里没有「重定向超过 3 跳」或「缺少地址」。

`Number(response.status) || 0` 把 status 0 的不透明重定向算进「小于 300」，直接把这个响应交给解析器。`ok` 为假，调用方抛出 `HTTP 0`，定义层接住后写成不可用快照，不打错误日志。发布列表的缓存键只有 `limit`，这条空快照会留 15 分钟；日历的时间范围每轮都变，所以日历仍会重新请求。

现在能读到 `Location` 时仍逐跳核对白名单，最多 3 跳。列表请求如果遇到 status 0 或 `opaqueredirect`，再用 `redirect: 'follow'` 取正文，并核对最终地址仍在已登记官网里。详情读取不走这第二次跟随。列表失败会打一行 `[official-release] category=...`，类别包括 `opaque-redirect`、`redirect-missing-location`、`redirect-too-many`、`redirect-off-allowlist`、`redirect-not-followed`、`http`、`network`、`parse`。不可用快照不再写入 Source 缓存，下一轮会重新请求并再次打出类别。

不新增 migration。不要重建数据库。91 是硬件报价快照索引。下一号仍是 92。空号仍是 63、79、80、82。需要同时重启 Web 和 Worker。列表采集在 Worker 的 `source.static-signal-board.snapshot`；Web 的官方详情读取共用这一套请求。
