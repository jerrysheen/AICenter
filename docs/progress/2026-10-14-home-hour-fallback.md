# 总览小时报缺刊时回退

日期：2026-10-14

## 线上

鸿蒙手机上的总览「小时报」停在 10 月 13 日，桌面已经是 10 月 14 日。服务端 00–11 点刊期已经生成，03 和 07 没有任务，对应的 `reading-hour` 是 404。手机拿到了 bootstrap 200 和最新的 `app.js`。没有 CDN，也没有 Service Worker。

## 决定

- 总览小时区不再因为最新一小时没有快照就整段清空。404 或中间缺一小时时，跳过这一小时，显示后面最近已有的刊期。已经读到的快照不会被后来的 404 抹掉。
- 总览 bootstrap 的本地缓存最多用 2 小时。新的请求失败、旧路径也失败时：缓存还在 2 小时内就继续显示并每隔约 20 秒再试；超过 2 小时就改成失败和重试，不再一直停在昨天的缓存上。
- 已配对设备可以把总览请求失败和改走旧路径 POST 到 `/api/v1/runtime/client-error`。同一设备每分钟最多 30 条，多出来的是 429。服务端打一行 `[web] client-error`。访问日志的路径带上查询串，`token`、`password` 这类参数仍然不写。
- 总览和 `#report` 的日期、小时用上海时间固定 UTC+8 计算，不跟手机自己的时区。`Asia/Shanghai` 没有夏令时。
- 小时快照大约整点后 40 分钟才出现，是因为开启文章整理时定时任务在第 30 分钟才入队，分类和浓缩还要再跑一会儿。整点后的补跑已经是大约一分钟。把定时提前会在这一小时的材料还没到齐时先出一版，这次不改调度。

## 验证

`node --test test/shanghai-time.test.js test/home-timeline.test.js test/page-cache.test.js test/client-report.test.js test/brief-page.test.js test/access-log.test.js test/overview-home-p0.test.js`

## 重启

需要重启 Web。浏览器再加载一次。Worker 不用为这项重启。不新增 migration。不要重建数据库。
