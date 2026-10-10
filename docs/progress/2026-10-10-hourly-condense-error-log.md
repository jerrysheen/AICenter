# 2026-10-10 小时浓缩失败日志

## 路径

小时任务 `report.hourly.extract` 调用 `generateHourlyDigests` → `generateHour` → `condense('hourly')`。每个阅读分类一组，经封闭任务 `hourly-brief` 调用现有 Harness。模型由 `AI_CENTER_HARNESS_HOURLY_PROVIDER` 决定：`google` 时走 Gemini 小时模型（默认 `gemini-3.1-flash-lite`，输出上限 4096）；否则走 Elucid Grok（输出上限 8192）。小时执行配置的 `retryPolicy` 是 `none`，这一轮调用内部不重试上游。

送进模型的是小时 Skill 加上 JSON：`{inputs, tagId, tagName}`。`inputs` 只含 `{id, title, text, tagId}`，按 12000 字节分批。信息层 `text` 最长 2000 字，单条正常不会撑破这一批。单次调用超时 180 秒，排队 120 秒，本小时总预算 20 分钟；补旧小时是 8 分钟。格式不对时最多再修一次 JSON。

分组失败在 `condense` 的 catch 里收成 `groupFailures`。`treeFailure` 只留原因码（超时、非法输出、可重试模型错误等）。上游 4xx/5xx、空回答，以及「单条输入超过预算」，以前都会落成 `retryable-model-error`。原文只进分析阶段表，最长 500 字，不进 Worker 日志。任务层看见可重试的分组失败后，另抛「小时浓缩临时失败；成功分类及检查点已保留」，`groupFailures` 不再出现在这条错误里。

## 日志

不改这句对外错误，也不改刊期字段。Worker 多两行 `console.error`：

分组 catch 一行以 `[worker] 浓缩失败` 开头。字段：`layer`、`task`、`kind`、`name`、`code`、`upstream`、`status`、`provider`、`model`、`tag`、`windowStart`、`inputs`、`inputBytes`、`skillBytes`、`calls`、`queueMs`、`executionMs`、`elapsedMs`、`cached`、`message`。

`kind`：`model-4xx`、`model-5xx`、`model-empty`、`model-error`、`parse`、`input-too-long`、`timeout-queue`、`timeout-execution`、`timeout-budget`。冷却期内再次进入同一分组时 `cached=1`，`message` 用上一轮已经记下的错误，不再只有原因码。

任务抛出固定文案之前另记一行：`groups`、`retryable`，以及每组的 `tag`、`reason`、`queueMs`、`executionMs`。

`message` 先去掉 `AIza…`、`sk-…`、`api key`、`authorization` / `bearer`，再截到 500 字。不记密钥、完整提示词或输入正文。`provider` / `model` 只取路由上的名字；看起来像密钥的值写成 `-`。

Harness 轮次错误额外带上 `upstreamCode` 和 `upstreamStatus`（能看成 400–599 时）。错误文案和失败原因码不变。

## 判断

代码里看不到「输入必然超过模型上下文」或「180 秒必然不够」。分批和超时都已经在。公网这几轮更像是上游错误、空回答、JSON 不合法或排队/执行超时被收成同一句。所以没有改截断、分批、超时或重试。下一轮失败看 `kind` 和 `status` 才能决定要不要加长超时或再切输入。

## 验证

`npm run syntax` 与 `npm test`。失败数不超过基线 10；本机 zstd 缺失不计入。
