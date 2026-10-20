# 空小时不再当成读取失败

## 现象

小时报翻到没有已发布快照的小时时，`GET /api/v1/reports/reading-hour?scope=hour` 返回 404。页面里的 `api()` 把没有 `error` 字段的响应抛成 `请求失败 (404)`。请求层用 `finally()` 清进行中的请求，这个派生 Promise 被丢掉，控制台再多一条没人接住的「请求失败 (404)」。有内容的小时、左右滑动和相邻预加载本身还能用。

## 决定

窗口合法但没有快照时，这个接口返回 200：`empty: true`，`snapshot: null`，`message` 为「这一小时没有内容」。小时报页把它画成原来的「这一小时没有条目」，不弹提示。旧的 404 仍按空态收掉，并且不再上报成首页客户端错误。未知刊期、按 id 读取未知快照，仍是 404。

请求层清进行中请求时接住 `finally()` 派生的拒绝，避免同一次失败在调用方已经处理之后还出现在控制台。

## 改动

- `packages/contracts/src/information-tree.js`：空小时正文。
- `apps/web/src/http/offthread-json-worker.js`：没有快照时返回这份正文。
- `apps/web/public/information-tree.js`：空正文和 404 都进入空态。
- `apps/web/public/home-timeline.js`、`apps/web/public/app.js`：首页把空小时记成缺失，不记成读取失败。
- `apps/web/public/client-request.js`：进行中请求的清理不再制造未处理拒绝。

没有新的前端文件，不用改静态白名单。不新增 migration。

## 验证

`node --test test/reading-hour.test.js test/client-request.test.js test/home-timeline.test.js test/hourly-unread.test.js test/hour-scroll.test.js test/offthread-miss.test.js`

## 遗留

不新增 migration，schema 版本不变。不要重建数据库。需要重启 Web，浏览器再加载一次。Worker 不用为这项重启。
