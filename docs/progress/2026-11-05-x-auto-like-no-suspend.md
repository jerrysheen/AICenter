# 自动点赞失败不再挂起

## 目标

符合条件就点赞。未确认、暂时点不到、任务失败只留下可查的记录，不再把页面开关打成 suspended。

## 决定

- `unconfirmed`、`unavailable`、`failed` 继续累计次数，最多记到 9。`liked` 或 `already-liked` 把三组计数清零。页面开关和 suspended 保持原样。
- 登录失效（`login-required`）和页面被拦截或出现验证（`blocked`）仍然关掉页面开关。这两类要人重新登录或处理验证，自动重试没有意义。
- 不感兴趣使用同一条规则。`done` 或 `already` 清零计数。登录失效和验证仍会停。
- 每次这类失败写一行 Worker 日志，带上状态、原因和当前计数。点赞任务抛错时，原因来自任务错误信息。浏览器没有把异常原文写进结果，因为原文可能含命令、浏览器标识或地址；日志只写固定类别。
- 配额不动。已经是 suspended 的快照不会被这次改动自动打开，需要再拨一次页面开关。

## 未确认通常从哪里来

点赞在采集浏览器里打开 `https://x.com/i/web/status/<id>`，只点这一条帖自己的心。点下去之后最多再看大约 8 秒（16 次，每次 500 毫秒）。下面几种情况都记成 `unconfirmed`，日志里的 `kind` 不同：

- `confirm-timeout`：点过之后，心没有变成已点赞。常见是页面还没画完，或按钮选择器对不上。
- `verify-miss`：心先变成已点赞，重新打开原帖后没有保持。X 会先乐观更新，所以要以重开后的状态为准。
- `account-changed`：确认过程中侧栏账号和点之前不是同一个。
- `timeout`：导航或页面脚本超过时限。导航 45 秒，读按钮 10 秒。
- `browser-error` 或其他固定类别：浏览器命令失败。日志不写异常原文。

点之前就失败、还没点下去，记成 `unavailable`，同样不挂起。

## 改动

`packages/domain/src/x-focus.js`、`packages/domain/src/x-auto-like.js`、`packages/connectors/src/x/like-browser.js`。不新增 migration。

## 验证

`node --test test/x-focus.test.js test/x-not-interested.test.js test/feed-interaction.test.js`

连续未确认、连续三次点不到、连续两次任务失败都保持页面开关打开，并继续派发下一条。登录失效和验证仍停止。成功点赞清零计数，但不会自动解开已经挂起的登录停止。

## 部署

不需要 `npm ci`，不要重建数据库。需要同时重启 Web 和 Worker。页面脚本没有改。若开关仍是挂起，再拨一次页面开关。
