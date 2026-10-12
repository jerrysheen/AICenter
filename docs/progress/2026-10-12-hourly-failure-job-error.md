# 2026-10-12 小时失败写入任务

`report.hourly.extract` 遇到可重试的分组失败时，仍抛出「小时浓缩临时失败；成功分类及检查点已保留」，重试次数和生成过程不变。job 的 `error` 同时记下脱敏后的 `kind`、`code`、`message`、分组名、模型名、`durationMs`、`httpStatus`。原文那句留在 `summary`。`message` 沿用浓缩失败日志的脱敏，截到 500 字，不写入密钥。

`report.daily.generate` 失败时用同一形状落库。日报生成、暂停和重试判断没有改。

诊断字段只挂在返回给任务的内存对象上，不写入刊期。

## 日志和 Worker 重启

`scripts/start-ai-center.ps1` 的 Web/Worker 标准输出和错误日志改为追加，文件名带当天日期，例如 `worker.error.2026-10-12.log`。早于最近 7 天的日期文件会删掉。Search、Browser、Tunnel 日志不动。原来的 `restart.request`、健康检查和失败后再启动一次仍然重启 Web 和 Worker。

只重启 Worker：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/restart-ai-center.ps1 -WorkerOnly
```

也可以在实例 `runtime/restart.worker.request` 放一个时间戳。正在运行的守护脚本只停 Worker，再拉起，并确认本机健康检查仍通过。Web 进程退出，或者同时存在 `restart.request`，仍按原来的方式一起重启。单独结束 Worker 进程也不会再把站点一起停掉。

不带 `-WorkerOnly` 时，`restart-ai-center.ps1` 和 `start-ai-center.ps1` 的参数与以前相同。

当前已经打开的启动窗口要重新打开一次，才会改用追加日志和只重启 Worker。这一次会同时拉起 Web 和 Worker。之后加载任务失败记录只需重启 Worker。

## Gemini 每日配额

每日配额的 429 冷却到下一次太平洋午夜，并处理夏令时。启动时会把已经超过这次重置的旧冷却截短；若一条很长的冷却明显来自上一配额日，则删掉。短时限速冷却保持原样。

`AI_CENTER_GEMINI_HOURLY_MODELS` 按顺序回退。例如 `gemini-3.1-flash-lite,gemini-3.5-flash-lite`：只有前一个模型在全部 key 上都冷却或没有剩余额度时，才用下一个。仓库里实际使用的模型 id 是 `gemini-3.1-flash-lite`。

选 key 时用当天已用次数最少、且不在冷却中的 key。某个 key 闲置超过 `AI_CENTER_GEMINI_KEY_IDLE_MS`（默认 30 分钟）时，下一次请求优先给它。每分钟的请求数和 token 上限仍按原来的方式拒绝超限 key。

冷却中的 key＋模型由 Worker 每分钟检查一次，真正发出请求的间隔是 `AI_CENTER_GEMINI_QUOTA_PROBE_MS`（默认 12 分钟）。每日配额冷却用 `AI_CENTER_GEMINI_QUOTA_PROBE_DAILY_MS`（默认 30 分钟），重置前也会探测。请求是 `generateContent`，`maxOutputTokens=1`。成功就解除冷却；失败保留原来的结束时间。同一进程同时只有一个探针。`AI_CENTER_GEMINI_QUOTA_PROBE=0` 关闭探针。探针计入配额预留，并写入用量，`stage=quota-probe`。用量列表里的 `applicationSessionId` 是 key 后缀，`jobId` 形如 `probe:429:kept` 或 `probe:200:lifted`。页面用量契约仍不返回模型和供应商。Worker 日志有一行：`gemini quota probe key=KEY model=... ok=0|1 status=... lifted=0|1`。

`budget-deferred` 和 429 的任务错误带上配额类型、key 后缀、模型、冷却结束时间和脱敏后的原文。

这些规则在 Worker 进程里。改完后重启 Worker。若启动窗口还是改日志之前打开的，需要先重新打开一次启动脚本。
