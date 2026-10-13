# X、快讯和简报目录改走预备缓冲区

日期：2026-10-13

## 线上（9150b42）

已经赢的：`feed/xueqiu` 7/16ms，bootstrap 2/17ms，`prepared-slots` hit 84、pending 0。

还在堵的：`feed/x` 313/1084ms，`feed/flash` 753/792ms，`hardware-prices` 7/714ms（服务端工作 1ms，在等事件循环），事件循环 max 0.82–1.10 秒/分钟。长任务：`feed.x` 最高 1056ms，`json.stringify` 最高 910ms，`events.flush` 最高 673ms。

`feed.x` 只在请求没有对上槽位、走进实时查询时才会标上。界面实际会要的、当时没有槽位的是：推荐（`for-you`，省略 `feed` 时解析器也落到这里）、收藏第一页（`saved=1`、`limit=50`）、真实翻页游标，以及 `refresh=1` 的抓取。快讯每次 `listFlash` 再 `JSON.stringify`。报价分类和 `snapshotId`、简报目录与小时阅读的缓存未命中、TrendForce 的弱 ETag，仍在请求里序列化。

`events.flush` 在 9150b42 里已经会跳过大于 8000 字节的帧，但 Web 用的 Runtime 服务没有交出 `listEventFrameHeads`。推送因此仍走 `listEvents`，把整行 `payload_json` 读进主线程。673ms 是这一下，不是已经改好的那条头查询。

## 请求路径

X 的关注和推荐：首页、已读头落到 12 条槽位；收藏且没有游标的第一页落到 50 条槽位。`limit` 不是 12 时，首页和已读头仍用 12 条那份。这些槽还没有第一份 Worker 快照时才返回 `{"ok":true,"pending":true}`。真实游标、以及雪球的翻页和收藏，记一次 `[web] feed-slot-miss provider=… feed=… limit=… saved=… refresh=… before=… fields=…`，然后在 Web 的 `worker_threads` 里读库、`JSON.stringify`、gzip。请求等待这块缓冲区，再 `res.end`。成功结果在内存里留 15 秒。`refresh=1` 仍在请求里抓取，标签只包住调用返回前的同步段。

快讯槽位是 `feed-list-flash`，Worker 用界面请求的 `limit=80` 写入 `{ok:true,items}`。任何合法 `limit` 都写出这份缓冲区；不是 80 时记一次未命中键。请求里不调用 `listFlash`，不序列化。

TrendForce 槽位是 `feed-list-trendforce`。弱 ETag 是缓冲区的 SHA1，不再对列表做 `JSON.stringify`。`refresh=1` 只排队原有采集任务，返回当前缓冲区，响应头带 `X-Job-Id`。

报价四个分类各有一份缓冲区，和总表一起由同一次 `list` 在 Worker 里拆开。还没有缓冲区时 `pending: true`。`snapshotId` 在同一条工作线程里按快照过滤并序列化。系列明细仍是小响应。

简报：Worker 每分钟写入当前七日 `view=index`、七日 `information=1`、首页 48 小时 `view=index`，以及同样两段的小时阅读索引。Web 只写出缓冲区，`Cache-Control` 仍是 `no-store`。还没有第一份时这些槽是 `pending`，并且不会被标成 `immutable`。刊期、单小时阅读和其他窗口走工作线程：有内容就返回，未知刊期或没有快照的小时是 404。

未命中的简报键记 `[web] report-slot-miss …`。焦点收藏翻过第一页之后由工作线程返回下一页，不再停在 `pending`。浏览器若仍收到 `pending`，从 250ms 起退避重试，最多约 10 秒，并且不把这份响应写入请求缓存或页面缓存。

## events.flush

migration 66 给 `outbox_events` 加 `sse_data`。插入时如果当时的 JSON 不超过 8000 字节，就把这份文本写入该列；更长的写成 `{"truncated":true,"bytes":N}`。不回填旧行。推送只选择 `id`、`workspace_id`、`event_name`、`payload_bytes`、`sse_data`。`sse_data` 为空的旧行写截断占位，不读 `payload_json`。Runtime 服务把 `listEventFrameHeads` 和 `listEventFrames` 交出来，回放也走 `sse_data`。63 仍空着，64 和 65 不改。

`insertEvent` 仍在写入方序列化。这不在 Web 的读请求上。

## 本机

这台机器串 8 万字节大约 1–2ms，对不上线上的 910 / 1056 / 673ms。本机测到的是槽位写出和线程装入：

- 槽位写出：雪球首页 0.77ms，X 推荐 0.13ms，快讯 0.08ms，报价列表 0.46ms。同一次里 hit 5、pending 2，服务调用 0。pending 只剩还没写入的预备槽。
- 8 万字节快照在工作线程里压到 148 字节 gzip，装入 52ms，写出 0.08ms。
- 工作线程在 `listen` 时已经打开数据库。之后 X 第二页 10.81ms、返回 8 条；更早一小时的阅读 3.2ms；该小时刊期 3.04ms；`snapshotId` 报价 6.65ms。查询、序列化和 gzip 都在这条线程里，请求线程只 `res.end`。
- 一条小事件加一条 2 万字节事件的推送没有调用 `listEvents`，也没有 `substr(payload_json)`。

## 重启

需要同时重启 Web 和 Worker。浏览器再加载一次。工作线程在 Web 进程里，快照仍由 Worker 进程写入。migration 66 只加 `sse_data`，不回填，不要重建数据库。不新增 migration。
