# 2026-10-07 原文翻译五账号并发

用户授权将原文翻译从单 Key/单任务改为五账号并发，每账号最小 10 秒发起间隔，移除本地每日请求上限。每账号理论约 6 次/分钟，五账号约 30 次/分钟，不把这个数解释为长文完成率或供应商保证。

Gemma Connector 新增多 Key 环境引用池，缺失或相同凭据去重，已知同项目账号共用节流；旧单 Key 配置保留兼容，多 Key 配置优先。31B/26B 的请求发起节奏按账号跨模型共享，并在现有 ModelQuotaRepository 单个事务内校验和写入，重启不能绕过。移除本地日/小时请求数硬上限；保留输入 TPM 预算、活动租约、供应商 429 冷却、5xx/流内错误退避、完整响应校验和无其他模型回退。

内部 WorkerJobConcurrency Contract 新增 translationLimit（1—5、默认 1），Worker composition root 默认启用 5，只对 feed.translation.run 生效。复用现有 Connector/Service/Repository/注册 handler，不引入新 Agent、数据库迁移或公开凭据字段。

确定性验证覆盖五 Key 同时发起、账号跨模型 10 秒节流及重启持久性、相同凭据去重、已知同项目节流、供应商冷却、超过旧 14400 日请求数仍可继续、五个 Worker 翻译执行位，以及旧译文缓存、完整落库、截断和错误流拒绝等回归。真实生产重载和运行观测完成后补记。

`npm run check` 最终 921/921 通过。一次全仓运行中旧 `model-admission` 的短执行时限测试在负载下超时；该文件独立 5/5 通过，未修改其时限或生产代码，重跑全套通过。Host 已配置五 Key 引用池与翻译并发 5；不打印或提交凭据。

在线备份后通过原启动器安全重载完成，Worker PID 更新，629 条暂缓任务全部恢复，HTTP 健康 200。上线约 58 秒观测：五个账号都已有 Gemma 请求预留，按账号跨模型的最小发起间隔分别为 10012/10003/10009/10000/10002ms；翻译 running=5，已完成 15、最终失败 1、queued=600。供应商错误仍存在，不能据此宣称 31B 稳定或承诺持续 30 条完成/分钟。Host 证据为 `.ai-data/gemma-five-accounts-live-verification.json`，重载备份和恢复状态在 `.ai-data/gemma-five-accounts-reload-1791380605987/`。
