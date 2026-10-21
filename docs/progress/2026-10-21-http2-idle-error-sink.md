# HTTP/2 空闲超时不再把 Worker 打退出

## 原因

今天 Worker 在 13:21、14:44、14:53、15:56、16:37 自己退出。日志是 undici HTTP/2 的 `socket idle timeout`。它从 `ClientHttp2Stream` 的 `'error'` 事件抛出，不是 `unhandledRejection`，所以拒绝计数接不住。

Google 和 Yahoo 的 undici Agent 默认会协商 HTTP/2。空闲会话到期时，undici 用 `InformationalError('socket idle timeout')` 拆掉套接字。Node 再把这个错误转给会话还记着的流。undici 按函数身份摘掉自己的监听，有时只留一次的空监听，第二次 `'error'` 就让进程退出。

## 决定

在 `http2.connect` 返回会话时给会话挂上 `'error'` 监听，并在每次 `session.request` 时给流挂上同一个监听。undici 只会摘掉它自己的函数，这个监听留着。空闲拆连接不再变成没人接的 `'error'`。HTTP/2 仍开着。

Google 建连、Yahoo 建连，以及 Worker 创建时都会装上。启动之后 `http2StreamErrorSinkInstalled` 为真。被接住的错误不把堆栈打出来，用 `console.debug` 记一行，带上这次进程里的累计次数。不新增 migration。当前 schema 仍是 96。下一号是 97。空号仍是 63、79、80、82。不要重建数据库。需要重启 Worker。页面没有改，Web 不用为这项重启。
