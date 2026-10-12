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
