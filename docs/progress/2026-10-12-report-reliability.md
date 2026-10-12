# 2026-10-12 小时报和日报失败恢复

最近两天小时报失败多于成功。`gemini-3.1-flash-lite` 返回 500/503，模型还会给出未知或重复的输入归属。失败小时在冷却后被下一轮再次选中，同一小时会一直重打。`report.information.prepare` 的并发默认是 1；任务在 `running` 里如果进程还在续租，原租约回收看不到它，队列就停在这条任务上。

日报 08:45 的四次失败都是「日报浓缩树生成失败」。浓缩树每个标签一次调用，硬超时是 180 秒。任何一个标签超时或校验失败，整期状态就是 `failed`，任务不会发布。定时一天只有一轮，最多两次尝试，当天没有后续补跑。

## 小时报

500 和 503 先在当前模型上按 1 秒、2 秒、4 秒退避，默认再试 3 次，封顶 8 秒。仍然失败就换 `AI_CENTER_GEMINI_HOURLY_MODELS` 里的下一个模型。额度不足时也换下一个，不增加付费回退。

未知或重复归属先按原纠正再请求一次。还不对就丢掉未知和重复的 id，把没被点名的输入挂到最后一个模块，不改模块原文。这样修不好，或者 JSON 本身无效，再换下一个模型。

同一组输入连续失败默认 4 次后写成终态，分组不再自动重试。新的信息节点出现后，这一小时可以再试。显式 `mode=resume` 仍可立即重试尚未终态的临时错误。

## 卡住的任务

心跳续租不再挡住超时。`report.information.prepare` 默认 30 分钟、小时报 45 分钟、日报 90 分钟。超过就标失败并释放，同队列可以继续领任务。进程已经退出、租约过期的任务仍按原来的次数重试。Worker 启动时做同一轮回收。

## 日报

单次模型超时默认改为 6 分钟，整天预算默认 60 分钟。有的标签成功、有的失败时，刊期记为 partial 并发布，不再整期失败。全部标签都失败时仍失败。

主定时点之后，如果当天日报没有发布，每 120 分钟再入队一次，直到发布或第二天。已有刊期会跳过。

补某一天：

```text
node --env-file=.env scripts/backfill-daily-report.mjs --date 2026-10-12
```

命令只把 `report.daily.generate` 放进队列。Worker 必须已经加载这次修复，并且正在运行。

## 环境变量

都有默认值。不改也能按上面的数字工作。改完需要重启 Worker。

- `AI_CENTER_HOURLY_UPSTREAM_RETRIES`：500/503 额外重试次数，默认 3。
- `AI_CENTER_HOURLY_MAX_ATTEMPTS`：同一小时终态前的失败次数，默认 4。
- `AI_CENTER_GEMINI_HOURLY_MODELS`：小时模型回退顺序。要换模型时才需要设。
- `AI_CENTER_DAILY_MODEL_TIMEOUT_MS`：日报单次模型超时，默认 360000。
- `AI_CENTER_DAILY_TOTAL_MS`：日报整次预算，默认 3600000。
- `AI_CENTER_DAILY_CATCHUP_MINUTES`：缺日报时的补跑间隔，默认 120。
- `AI_CENTER_PREPARE_MAX_RUNNING_MS`：信息准备最长运行，默认 1800000。
- `AI_CENTER_HOURLY_MAX_RUNNING_MS`：小时任务最长运行，默认 2700000。
- `AI_CENTER_DAILY_MAX_RUNNING_MS`：日报任务最长运行，默认 5400000。
- `AI_CENTER_JOB_MAX_RUNNING_MS`：其他任务最长运行，默认 2700000。
