# 总览小时报缺刊时回退

日期：2026-10-14

## 线上

鸿蒙手机上的总览「小时报」停在 10 月 13 日，桌面已经是 10 月 14 日。服务端 00–11 点刊期已经生成，03 和 07 没有任务，对应的 `reading-hour` 是 404。手机拿到了 bootstrap 200 和最新的 `app.js`。没有 CDN，也没有 Service Worker。

## 决定

根因：总览 bootstrap 的请求地址和本地缓存键都是固定的 `GET /api/v1/home/bootstrap`，没有上海日期。手机昨天写下的那一份，今天仍是同一把钥匙。页面先把这份画上，再用它的 ETag 发 `If-None-Match`。304 时新正文是空的，调用方把「已经画过缓存」当成成功，并把缓存时间改成现在，10 月 13 日就留在屏幕上。鸿蒙浏览器对这个没有日期的地址，即使用户在服务端看到 200，脚本仍可能拿到磁盘里的旧 JSON；这份旧正文的最新刊期就是 10 月 13 日。桌面没有这份旧缓存，拿到的是当天的快照，所以是 10 月 14 日。localStorage 里更旧的一份还会压过 IndexedDB 里更新的一份。

- 缓存键加上上海日期。窗口已经结束的正文不再当作今天来画，也不拿它的 ETag 去对。200 如果仍是上一天，先丢掉，再用 `cache: 'no-store'` 和不带 ETag 的 `refresh=1` 重取一次；仍然不是今天才改走旧路径。新正文先拿来画，再写入缓存，写入卡住也不会挡住替换。同一把钥匙上，更新的 `savedAt` 胜出。
- 总览小时区不再因为最新一小时没有快照就整段清空。404 或中间缺一小时时，跳过这一小时，显示后面最近已有的刊期。已经读到的快照不会被后来的 404 抹掉。
- 总览 bootstrap 的本地缓存最多用 2 小时。新的请求失败、旧路径也失败时：缓存还在 2 小时内就继续显示并每隔约 20 秒再试；超过 2 小时就改成失败和重试，不再一直停在昨天的缓存上。
- 已配对设备可以把总览请求失败和改走旧路径 POST 到 `/api/v1/runtime/client-error`。同一设备每分钟最多 30 条，多出来的是 429。服务端打一行 `[web] client-error`。访问日志的路径带上查询串，`token`、`password` 这类参数仍然不写。
- 总览和 `#report` 的日期、小时用上海时间固定 UTC+8 计算，不跟手机自己的时区。`Asia/Shanghai` 没有夏令时。
- 小时快照大约整点后 40 分钟才出现，是因为开启文章整理时定时任务在第 30 分钟才入队，分类和浓缩还要再跑一会儿。整点后的补跑已经是大约一分钟。把定时提前会在这一小时的材料还没到齐时先出一版，这次不改调度。

## 验证

`node --test test/shanghai-time.test.js test/home-timeline.test.js test/page-cache.test.js test/home-bootstrap.test.js test/client-report.test.js test/brief-page.test.js test/access-log.test.js test/overview-home-p0.test.js`

## 重启

需要重启 Web。浏览器再加载一次。Worker 不用为这项重启。不新增 migration。不要重建数据库。
