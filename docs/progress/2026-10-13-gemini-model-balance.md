# 2026-10-13 Gemini 小时模型负载均衡

## 之前

小时准入把模型顺序写成 `ordered`。`resolveGoogleHourlyAdmissionModels` 把 `gemini-3.1-flash-lite` 放在前面，`reserve` 只要 3.1 还有配额就选定它。信息树浓缩的模型循环也从这份列表的第一项开始。文章模型池的轮换游标只在进程内存里，重启后又从 3.1 开始。用量账本的失败行只有 `failed`，看不出 429 还是 503。

同一天里 tree-hourly 是 3.1 496 成功 / 30 失败、3.5 144 / 0；阅读分类是 3.1 160 / 14、3.5 84 / 0。五把 3.1 key 都在冷却，3.5 还有余量。

## 决定

- 小时准入改为 `least-used`。模型池按（模型，key）当天预留次数从少到多尝试，次数相同再看该模型的合计、空闲、最近一次和原来的顺序。冷却、分钟、日额和租约仍由原来的配额仓库拒绝，不缩短冷却。
- 信息树浓缩先问这次准入会选哪个模型，从那个模型开始，失败后再换列表里的另一个。读不出合法顺序时仍用原来的列表。阅读分类不传 `googleModel`，直接走这套挑选。
- 文章模型池继续轮换。游标写入 `gemini_model_cursors`，键是模型列表。列表变了就从 0 重新计。显式 `googleModel` 仍固定该模型。
- `model_usage_index` 增加可空 `http_status`。直连 HTTP、Harness 终态错误和配额探针把 100–599 写进账本。旧 JSON 没有该字段时读成 null。

## 改动

- `packages/runtime/src/gemini-article-admission.js`、`packages/database/src/repositories/model-quota-repository.js`
- `packages/domain/src/information-tree-service.js`、`apps/worker/src/worker.js`、`packages/harness/src/llm-route.js`
- `packages/contracts/src/model-usage.js`、`packages/database/src/repositories/model-usage-repository.js`
- `packages/harness/src/model-usage-observer.js`、`packages/harness/src/harness-agent-runtime.js`、`packages/connectors/src/model-usage-fetch.js`
- `apps/web/public/model-usage.js`
- migration 60 `gemini_model_pool_cursor`，migration 61 `model_usage_http_status`

## 验证

- 两模型两把 key 的前四次预留交替模型，而不是先打满 3.1。3.1 次数更多时，下一次池预留和 `rankModels` 都从 3.5 开始；3.5 日冷却后回到 3.1。
- 文章池新建一个准入对象后，下一单是池里的下一个模型。
- 信息树在给定的均衡顺序上先打 3.5，503 后再打 3.1。非法顺序被忽略。
- 429 与 503 分别写入 `http_status`。没有该字段的旧行读成 null。页面视图仍不含 provider / model。

## 重启

需要同时重启 Web 和 Worker。先启动的进程执行 migration 60 和 61。不要重建数据库。只重启其中一个时，另一个进程仍按旧的「3.1 优先」或旧账本字段工作。
