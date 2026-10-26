# 小时报重新读到已有阅读稿，补跑不再被 8 分钟和重启租约掐死

2026-10-26 小时报全天空着。经典 `hourly_information_snapshots` 和 `GET /api/v1/reports/hourly` 当天 00–21 点都是 `not-started`，库里没有当天行；上一份成功的经典小时稿大约停在 2026-10-06 19:00。同一天阅读小时 00–18 点是 `ready`。tree-v3 多数小时已有 `partial` 或 `ready` 刊期，02/19/20 点失败且没有刊期；摘选任务常见 `timeout-budget` 或 `WorkerLeaseExpired`。

## 用户看到的是哪一条

生产 `AI_CENTER_INFORMATION_PIPELINE=tree-v3` 时，首页「小时报」和简报页「小时报」读的是树刊期（`edition` 或 `attempt`）加上阅读小时。它们不读 `hourly_information_snapshots`。

`/api/v1/reports/hourly` 是切换前的经典摘选。tree-v3 的 Worker 把 `informationService` 换成浓缩树，不再写这张表。索引把缺行填成 `not-started` 是这条旧接口的预期。这次不改它的响应形状，也不把树内容填回去。

没有树头的小时不会出现在小时列表里，即使阅读小时已经 `ready`。阅读稿里没有命中，或命中都超过时效，首页仍显示这一小时没有条目；简报页把过期命中收在「旧闻补录」。这次不改命中门槛。

## 决定

- 非当前小时不再用固定 8 分钟。预算至少等于当前小时的 `totalMs`（默认 20 分钟），并且至少够一次排队等待加一次执行再加 30 秒。默认排队等待仍是 390 秒。不中止已经在跑的调用。
- `recoverStaleJobs` 对 `report.hourly.extract` 和翻译一样：租约中断保留已用次数，并给 `max_attempts` 加一。运行超过 `AI_CENTER_HOURLY_MAX_RUNNING_MS`（默认 45 分钟）仍记 `WorkerRunTimeout`，不补次数。
- 10 分钟一次的失败补跑仍先排已到重试时间的失败小时，每轮最多 2 条。名额有剩时，再排最近 24 个已结束小时里没有刊期头的小时。已发布的小时不重排。当前小时仍只使用剩下的名额。
- 首页和简报页「小时报」把阅读小时索引里已有稿、树上没有头的小时补进同一份列表。树上的刊期优先。

## 改动

`packages/domain/src/information-tree-policy.js`、`packages/domain/src/information-tree-service.js`、`packages/database/src/index.js`、`packages/runtime/src/information-tree-module.js`、`apps/web/public/home-timeline.js`、`apps/web/public/information-tree.js`、`apps/web/public/app.js`。`docs/information-tree-v3.md` 里历史小时的预算说明改成与这次一致。不新增 migration。不改日报和股民讨论。

## 验证

`node --test test/hourly-failure-catchup.test.js test/information-tree-next.test.js test/home-timeline.test.js test/report-reliability.test.js`。

默认补跑预算是 20 分钟。把总预算降到 1 分钟时，结果是 390 秒排队加 180 秒执行再加 30 秒。失败小时仍先占满 2 条名额。没有头的小时使用剩下的名额，已发布的小时不进队列。小时摘选被租约打断两次后仍回到队列，并且 `max_attempts` 增加；运行超时不增加。阅读索引里多出来的小时会出现在首页小时列表，已有树刊期的同一小时不重复。

## 部署

不要重建数据库。当前 schema 仍是 96。下一号是 97。空号仍是 63、79、80、82。需要同时重启 Web 和 Worker，浏览器再加载一次。没有新的环境变量。已经失败且没有刊期头的小时，会在 Worker 起来之后的补跑里重新排队，不是启动时立刻全部重算。
