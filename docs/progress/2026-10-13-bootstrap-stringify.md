# 2026-10-13 首屏不再在请求里序列化

## 之前

线上 `GET /api/v1/home/bootstrap` 约 438KB 原文、107KB gzip。服务端 p50 2197ms、p95 2631ms，`loopMs` 约 2150。阻塞几乎都是请求路径上的同步 `JSON.stringify`，最长 2349ms；gzip 大约 45ms。事件循环 max 2.1–2.65 秒。点名任务里 `json.stringify` 0.5–2.3 秒，`feed.xueqiu` 2.0–2.6 秒，`events.flush` 2.0–2.25 秒。`GET /api/v1/feed/x` p50/p95 1150/1490ms，20 秒对象缓存挡不住，因为每次命中仍要再序列化。`GET /api/v1/feed/xueqiu` p50/p95 613/769ms。favicon 偶尔 700–800ms。

## 决定

- bootstrap 只留首屏。最近 8 个小时窗口；最新一小时最多 5 条命中，其余小时最多 2 条。行情去掉走势线。日报只留日期、概述和最多 5 句，并记下总条数。官方发布最多 8 条。不再附带 48 小时全文索引、整份小时快照、手工、X 和雪球。这些列表仍由原来的接口随后读取。
- 缓存填入时做一次 `JSON.stringify` 和 gzip，请求命中只写出这块缓冲区和 ETag。`If-None-Match` 仍是 304。
- X / 雪球列表同样缓存序列化后的缓冲区。列表查询不选正文大字段，也不为规范化文章再把正文读一遍。译文按条目 id 附在列表上；打开单条时仍按正文哈希核对。超过 8 条时让出一次事件循环。
- `events.flush` 每次最多 5 条，SSE 的 `data` 直接用 `payload_json`，不再解析后再序列化。没有订阅者时只把游标拨到最新 id。
- `/favicon.ico` 和 `/favicon.svg` 第一次读入内存后一直复用，`Cache-Control: public, max-age=604800`。不再为了图标去统计全部静态文件。

## 之后

同一套夹具里，撑大的旧结构 `JSON.stringify` 为 1781077 字节、4.42ms（这台机器空闲，不能当成线上 2349ms 的复现）。收成首屏后 20607 字节，gzip 1153 字节，组包加序列化 10.81ms。缓存命中不再序列化。线上 438KB / 最长 2349ms 的那次序列化不再出现在请求路径上。SSE 回放仍按最多 200 条取原始 `payload_json`，单次上限与 `listEvents` 一样是 1000；`events.flush` 每次只取 5 条。

## 重启

需要重启 Web。浏览器再加载一次。Worker 不用重启。没有 migration。
