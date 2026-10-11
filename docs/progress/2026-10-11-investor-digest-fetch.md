# 2026-10-11 股民讨论日摘采集修复

生产两次日摘都是 partial。26 个目标报「采集浏览器返回的不是 JSON」，另外两个解析成功但帖子和评论都是 0。一次性脚本用同一套雪球地址能拿到 JSON，说明登录和接口本身可用。

## 原因

- 日期窗口是 `{ startAt, endAt }`（北京时间当天 0 点到次日 0 点，毫秒）。采集只读 `since/until`，生产路径上这两个值是空的，`inWindow` 把带 `created_at` 的帖子全部丢掉。雪球 `created_at` 是毫秒；落在秒级范围（`1e9` 到 `1e12`）的值会换成毫秒。
- `browserRuntime.withSession` 原来没有锁。Worker 里的雪球、X 和其他浏览器任务会同时开 bsk 会话，共享页面时后一个任务会把正在抓讨论的页面导航走，`fetch` 就会拿到 HTML、验证页或截断文本。

## 修复

- 解析失败时记一条日志：status、url、文本长度、开头约 120 字。不记 cookie。覆盖率原因写成 HTML、验证页、空体或截断。
- 验证页抛出 `verification_required`，停止后续标的，不重试。日摘状态与未登录分开。
- 同一个 BrowserRuntime 上的 `withSession` 串行执行。日摘的 `collectAll` 占着会话时，其他任务不能导航这个页面。

需要重启 Worker。Web 只为了显示「雪球验证页」这个状态。没有新的 migration。
