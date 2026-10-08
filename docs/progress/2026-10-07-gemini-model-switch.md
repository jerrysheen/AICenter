# 2026-10-07 Google 模型切换接口

用户暂停五账号预算扩容与并发上线，转为先预留同一个 Google API Key 按请求切换模型的接口。此前扩容代码保留在未提交工作区，未执行安全重载脚本；正式 Worker PID 和运行配置保持原状，未应用 migration45 或提高正式预算。

新增 Host 内部 `runtime.run({closedContext:true,closedTask:"article-normalize",googleModel,googleKeyEnv,...})` 参数。模型受 `AI_CENTER_GEMINI_ARTICLE_MODELS` 本地白名单约束，默认模型始终允许；Key 只能选当前已配置账号池的环境变量名。选定模型同时用于 Harness engine/settings、持久化配额和原有用量归因；选定 Key 通过 admission，不能绕过限流。账号/项目＋模型的冷却独立，既有全局小时/间隔预算保留。不增加 HTTP 参数或页面供应商字段，不自动轮换 Google 模型，不发送真实请求验证未知模型。

两个新增确定性测试覆盖模型白名单、非 Google 任务拒绝、同一个 Key 连续经 Harness 适配器选择两个模型、实际模型设置、一个模型冷却不影响另一个、未配置模型与 Key 在请求前拒绝。专题说明见 `../gemini-article-normalize.md`。正式 `.env` 未修改，正式 Worker 未重启。

最终 npm run check：890/890 通过。前一轮出现既有 scheduler 并行测试清理临时 SQLite 文件的 Windows EBUSY；未改动该测试或调度业务，最终全仓复跑通过。生产仅只读核验，Worker 仍为原 PID、三 Key 池、60次/滚动小时、并发模式未开启。
