# 从小时报打开媒体原文不再停在读取中

## 目标

类目小时里点「原文」进入 `#article/media:…` 时，页面停在「正在读取文章… / 正在读取正文和译文。」，`data-load-state` 一直是 `loading`，没有失败，也没有重试。小时报本身能打开。控制台里的 `/api/v1/events/stream` `ERR_HTTP2_PROTOCOL_ERROR` 只当作可能干扰正文请求的旁路。

## 决定

正文接口其实已经返回时，阅读页仍把这篇文章当成没载入。`restoreSavedArticle` 把 `mediaAsItem` 放进 `restoredArticles`，但没有 `readerLoaded`。下一帧仍觉得要读，而这条请求还留在进行中集合里，于是直接返回。加载卡就不再往下走。

媒体正文改走单独的 `fetch`，不进页面那条最多 6 个的请求队列，避免实时流重连带起来的刷新把这篇读请求排在后面。每次最多 8 秒。网络失败或超时自动再试一次；4xx 不自动重试。两次都没有结果，或浏览器一直不结束这次请求，就换成「文章没有读出来」，可以重试，也可以返回信息流。成功时标成已读入，标题和正文按原来的媒体阅读页画出。

类目小时怎么生成、媒体要点用哪句中文，都不改。

## 改动

- `apps/web/public/app.js`：媒体原文读完后 `rememberReaderPost`；失败画出重试；进行中的读取结束就放锁。读请求不经过共享请求层。
- `test/article-read-restore.test.js`：成功后可阅读、网络失败重试一次、404 不重试、挂起后能重试。

## 验证

`node --check apps/web/public/app.js`

`node --test test/article-read-restore.test.js test/media-reader-session.test.js`

不新增 migration。当前 schema 仍是 97。下一号是 98。空号仍是 63、79、80、82。不要重建数据库。

## 部署

需要重启 Web，浏览器再加载一次。Worker 不用为这项重启。

## 遗留

实时流仍走原来的 `EventSource`。连接被 HTTP/2 重置时，正文请求会失败并自动再试一次；再失败就停在可重试的错误卡上，不再一直转圈。
