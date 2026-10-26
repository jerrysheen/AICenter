# X 推荐流同步不再被 recoverStale 抢先释放

X 的 for-you 经常超过单源 90 秒。`feed.subscription.sync` 的最长运行时间是单源时限再加 30 秒。`recoverStaleJobs` 按任务开始的墙钟计算，会在单源 `AbortController` 截止前后把任务记成 `WorkerRunTimeout`。浏览器随后中止，日志变成 interrupted。关注流仍能完成，不是 cookie 问题。

## 决定

- 单源默认预算从 90 秒改为 180 秒。`AI_CENTER_FEED_SYNC_SOURCE_TIMEOUT_MS` 仍可覆盖，范围仍是 15 秒到 3 分钟。
- `FEED_SYNC_RECOVER_BUFFER_MS` 为 120 秒。领取租约和 `maxRunningMsByType['feed.subscription.sync']` 都用「单源时限 + 这个常数」。recover 的墙钟晚于单源截止，不会先于 AbortController 释放任务。
- 一条都没写入时，单源截止或这次自己的中止记为 `status=deadline reason=deadline`，仍是 5 分钟后重试。任务信号中止记为 `status=interrupted reason=signal`。其它错误仍是 `failed`。已经写入的条目遇到截止，仍按订阅间隔完成，状态是 `deadline`。

## 改动

`packages/runtime/src/feed-automation-module.js`、`apps/worker/src/worker.js`、`packages/domain/src/feed-service.js`。不新增 migration。不改抓取展开和滚动。截止失败的快照仍抛错，但带上 `deadline`，同步任务才能把状态写成 deadline，而不是 failed。

## 验证

`node --test test/feed-automation.test.js`。默认 180 秒，仍夹在 15 秒到 3 分钟。最长运行和领取租约都是单源时限加 120 秒。added=0 的截止是 deadline，父信号中止是 interrupted，普通错误仍是 failed。有条目的截止仍是 deadline 并按间隔完成。

## 部署

不要重建数据库。当前 schema 仍是 96。下一号是 97。空号仍是 63、79、80、82。只需要重启 Worker。Web 不用为这项重启。临时的 `AI_CENTER_FEED_SYNC_SOURCE_TIMEOUT_MS=180000` 可以留着，也可以删掉；代码默认已经是 180 秒。
