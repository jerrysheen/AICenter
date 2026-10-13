# 请求只写出已备好的缓冲区

日期：2026-10-13

## 线上

`e3084da` 已经在跑，事件循环 max 仍是 0.86–1.31 秒/分钟。`GET /api/v1/feed/xueqiu` p50/p95 303/1174ms，`GET /api/v1/hardware-prices` 11/948ms。访问日志里的服务端工作是毫秒，其余时间在等事件循环。长任务：`json.stringify` 最高 1093ms、40 次，`feed.xueqiu` 1087ms，`events.flush` 985ms，`home.bootstrap` 887ms。`runtime_snapshots` 里已经有快照，请求路径还是会堵住。

## 标签

事件循环探测每 50ms 看一次间隙。`leave()` 之后标签要等到下一拍才摘掉，所以大约 50ms 的空隙可能记到旁边的名字上。一秒左右的阻塞不是这扇窗口，是这个名字还挂着时主线程上的工作。

- `json.stringify` 来自 `prepareJsonBody` 和 `response.js` 的 `json()`。硬件、信息流和 bootstrap 的缓存未命中会在请求里序列化大对象。`prepareJsonText` 不打这个标签，它只做拷贝、SHA1 和 gzip；若发生在 `leave()` 之后、下一拍之前，仍会算进上一个名字。
- `feed.xueqiu` 只在快照被判定为不可用时进入，并且包住了整个 `await`。实时查询开头的同步读取，以及等待期间别的同步工作，都会记到这个名字上。快照键要求 `fields=list` 且 `limit=12`。解析器省略 `limit` 时是 50，焦点和刷新也发 50，所以首页以外的第一页对不上键。7x24（`livenews`）和精选的已读头以前没有键。工作区只写 `local`，但每次请求仍先把整段 `payload_json` 读进 Web 进程，生成时间一变就在请求里再哈希、再 gzip。
- `events.flush` 在调用它的那一拍里执行 `length(payload_json)`，大行再 `substr`。SQLite 读大 TEXT 会把整段带出来。250ms 的定时器还把这个标签多留一拍。
- `home.bootstrap` 在缓存没有当前小时键时于请求里组包。887ms 是其中一段同步读取（目录、某一个小时或简报），不是整次组包。

这台环境里没有线上的 access log 或 event-loop log，命中率对不上生产。上线后 Web 每分钟打一行 `[web] prepared-slots hit=… pending=… size=…`。

## 请求路径

报价列表（无 `category`、无 `snapshotId`）、X / 雪球的关注、精选、7x24 以及它们的已读头、总览 bootstrap，命中时只有一次内存查找、`writeHead` 和 `res.end(buffer)`。不读 SQLite，不 `JSON.stringify`，不重新组包，不 gzip。

缓冲区由 Web 进程里的 `worker_threads` 每 5 秒只读打开数据库，在线程里做 SHA1 和 gzip，再用可转移的 `ArrayBuffer` 交给主线程。已有的缓冲区一直留到线程换上更新的一份。还没有任何缓冲区时返回 `{"ok":true,"pending":true}`，这次请求不补算。

雪球和 X 的首页不再要求请求自己带 `limit=12`。关注、精选、7x24 以及对应已读头都落到 12 条的槽位，所以主页和 7x24 不会因为 `limit=50` 退回实时查询。带真实翻页游标、`saved=1` 或 `refresh=1` 的请求仍查询；`refresh=1` 的标签只包住调用返回前的同步段，不再盖住后面的等待。

总览由 Worker 每分钟跑 `home.bootstrap.snapshot`，把组好的 JSON 写入 `runtime_snapshots` 键 `home-bootstrap`。Web 请求不调用 `composeHomeBootstrap`。`refresh=1` 也只返回当前缓冲区。

`events.flush` 用 `setTimeout(0)` 把整段读取挪出调用它的那一拍。migration 65 给 `outbox_events` 加 `payload_bytes`，插入时记下已经在手里的 JSON 字节数，不在迁移里回填旧行。推送只选择 `payload_bytes`。长度未知或大于 8000 字节时写 `{"truncated":true,"bytes":…}`，不碰 `payload_json`。较短的新事件仍读出全文。63 仍不使用，64 不改。

## 仍会序列化的位置

这些不在上面的热路径上：

- `apps/web/src/http/response.js` 的 `json()`：校验错误、小响应，以及带 `category` 或 `snapshotId` 的报价列表。
- `apps/web/src/http/prepared-json.js` 的 `prepareJsonBody`：简报目录、刊期和小时阅读的 15 秒缓存未命中。
- 趋势列表的弱 ETag 仍对当次结果做一次 `JSON.stringify`。
- Worker 写快照和 `insertEvent` 仍序列化，发生在 Worker 或写入方，不在 Web 读请求上。

## 本机

槽位命中：信息流 0.7ms，报价 0.43ms；gzip 响应写出 0.11ms。8 万字节的快照在线程里压成 148 字节 gzip，装入约 47ms，不在请求上。400 条列表的实时查询仍是第一次 21.4ms、第二次 0.7ms，快照 5919 字节。这台机器不能当成线上 1093ms 的复现。

## 重启

需要同时重启 Web 和 Worker。浏览器再加载一次。Worker 写出第一份总览和列表之前，对应接口是 `pending: true`。migration 65 只加列，不回填，不要重建数据库。
