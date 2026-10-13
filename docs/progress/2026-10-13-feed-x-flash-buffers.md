# X、快讯和简报目录改走预备缓冲区

日期：2026-10-13

## 线上（9150b42）

已经赢的：`feed/xueqiu` 7/16ms，bootstrap 2/17ms，`prepared-slots` hit 84、pending 0。

还在堵的：`feed/x` 313/1084ms，`feed/flash` 753/792ms，`hardware-prices` 7/714ms（服务端工作 1ms，在等事件循环），事件循环 max 0.82–1.10 秒/分钟。长任务：`feed.x` 最高 1056ms，`json.stringify` 最高 910ms，`events.flush` 最高 673ms。

`feed.x` 只在请求没有对上槽位、走进实时查询时才会标上。界面实际会要的、当时没有槽位的是：推荐（`for-you`，省略 `feed` 时解析器也落到这里）、收藏第一页（`saved=1`、`limit=50`）、真实翻页游标，以及 `refresh=1` 的抓取。快讯每次 `listFlash` 再 `JSON.stringify`。报价分类和 `snapshotId`、简报目录与小时阅读的缓存未命中、TrendForce 的弱 ETag，仍在请求里序列化。

`events.flush` 在 9150b42 里已经会跳过大于 8000 字节的帧，但 Web 用的 Runtime 服务没有交出 `listEventFrameHeads`。推送因此仍走 `listEvents`，把整行 `payload_json` 读进主线程。673ms 是这一下，不是已经改好的那条头查询。

## 请求路径

X 的关注和推荐：首页、已读头落到 12 条槽位；收藏且没有游标的第一页落到 50 条槽位。`limit` 不是 12 时，首页和已读头仍用 12 条那份。真实游标返回 `{"ok":true,"pending":true}`，不调用 `getExternalFeed`。`refresh=1` 仍查询，标签只包住调用返回前的同步段。对不上槽位的 X / 雪球请求各记一次 `[web] feed-slot-miss provider=… feed=… limit=… saved=… refresh=… before=… fields=…`。雪球的翻页、收藏和刷新仍查询。

快讯槽位是 `feed-list-flash`，Worker 用界面请求的 `limit=80` 写入 `{ok:true,items}`。任何合法 `limit` 都写出这份缓冲区；不是 80 时记一次未命中键。请求里不调用 `listFlash`，不序列化。

TrendForce 槽位是 `feed-list-trendforce`。弱 ETag 是缓冲区的 SHA1，不再对列表做 `JSON.stringify`。`refresh=1` 只排队原有采集任务，返回当前缓冲区，响应头带 `X-Job-Id`。

报价四个分类各有一份缓冲区，和总表一起由同一次 `list` 在 Worker 里拆开。`snapshotId` 返回 `pending: true`，不读列表、不序列化。系列明细仍是小响应。

简报：Worker 每分钟写入当前七日 `view=index`、七日 `information=1`、首页 48 小时 `view=index`，以及同样两段的小时阅读索引。Web 只写出缓冲区，`Cache-Control` 仍是 `no-store`。刊期、单小时阅读和其他窗口返回 `pending: true`。`pending` 的刊期响应不会被标成 `immutable`。

未命中的简报键记 `[web] report-slot-miss …`。焦点收藏翻过第一页之后是 `pending`，循环会停，这一轮先看到第一页的 50 条。

## events.flush

migration 66 给 `outbox_events` 加 `sse_data`。插入时如果当时的 JSON 不超过 8000 字节，就把这份文本写入该列；更长的写成 `{"truncated":true,"bytes":N}`。不回填旧行。推送只选择 `id`、`workspace_id`、`event_name`、`payload_bytes`、`sse_data`。`sse_data` 为空的旧行写截断占位，不读 `payload_json`。Runtime 服务把 `listEventFrameHeads` 和 `listEventFrames` 交出来，回放也走 `sse_data`。63 仍空着，64 和 65 不改。

`insertEvent` 仍在写入方序列化。这不在 Web 的读请求上。

## 本机

这台机器串 8 万字节大约 1–2ms，对不上线上的 910 / 1056 / 673ms。本机测到的是槽位写出和线程装入：

- 槽位写出：雪球首页 0.77ms，X 推荐 0.13ms，快讯 0.09ms，报价列表 0.49ms。同一次里 hit 5、pending 4，服务调用 0。
- 8 万字节快照在工作线程里压到 148 字节 gzip，装入 53ms，写出 0.17ms。
- 一条小事件加一条 2 万字节事件的推送没有调用 `listEvents`，也没有 `substr(payload_json)`。

## 重启

需要同时重启 Web 和 Worker。浏览器再加载一次。migration 66 只加 `sse_data`，不回填，不要重建数据库。
