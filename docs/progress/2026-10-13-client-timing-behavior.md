# 2026-10-13 页面计时和展开 / 原文事件

## 目标

`#71` 部署之后，`data/logs/client-timing.*.log` 几乎没有新行：当天只看到 3 条，最后一条在 11:45。行为日志里一直没有 `source.original` 和 `item.expand`。其他行为事件有记录，说明 `/api/v1/behavior` 的发送是通的。

## 决定

- 页面计时不再按 20% 抽样。每次文档加载都记一条。没有 Navigation Timing 时，七个阶段记 0，仍然发送。`load` 已经结束、8 秒内 `load` 还没来，以及从往返缓存恢复，都会发。
- 页面还开着时用 `fetch`，`keepalive: true`，`Content-Type` 正好是 `text/plain`。`fetch` 抛错时才用 `sendBeacon`，Blob 类型也是 `text/plain`，不带 `charset`。`?v=` 仍由静态文件按内容改写。脚本改成 `type="module"`，白名单不变。
- 隧道把 Host 改成 `127.0.0.1` / `localhost` / `::1`，并且带 `cf-ray` 或 `cf-connecting-ip` 时，本站计时仍写入日志。`Sec-Fetch-Site` 为 `cross-site` 或 `same-site` 继续丢掉。服务端抽样默认仍是 1，每分钟最多 300 条。
- `原文`、`打开原文`、`打开原站`、`前往原站`、`阅读站内原文` 标 `data-behavior="source.original"`。点击这些控件就记 `source.original`。
- 阅读折页标 `data-behavior="item.expand"`。用户点标题展开、点「展开」，或打开「中文正文」「展开相邻上下文」「展开本期其余」，记 `item.expand`。已经展开的折页在重绘时设 `expandQuiet`，这一下不算用户展开。

## 重启

需要重启 Web，浏览器再加载一次页面。Worker 不用重启。没有 migration。
