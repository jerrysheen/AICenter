# 小时报停用开关

`AI_CENTER_HOURLY_DISABLED=1` 时：

- `ensureHourlyDigestSchedule` 不写入调度，已有记录保持原样，不会被改成 `enabled:true`。
- 定时器不再把到期的小时调度入队。
- 信息准备之后的小时刷新、历史补编，以及手动 `requestHourlyDigest`，都不再创建 `report.hourly.extract`。
- 启动时取消已经排队或仍标为运行中的小时任务。若之后仍有任务被领到，处理函数直接返回跳过，不调用模型。
- Worker 启动打一行日志。

未设置或不是 `1` 时，小时报保持原来的调度。需要重启 Worker 后生效。
