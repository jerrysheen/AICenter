# Gemini 配额受限时回退 Grok

翻译和打标优先使用Gemini。遇到429 / RESOURCE_EXHAUSTED后，通过现有Elucid Responses适配调用Grok；移除DeepL和Google翻译调用及其配置样例。历史译文继续保留，不重算已完成内容。

## 配额识别与恢复

- 使用实际API返回的额度/限流信息，不以本地调用计数推断项目剩余额度。
- 解析QuotaFailure中的每日额度标识。每日耗尽等到America/Los_Angeles次日零点恢复，包含夏令时；每日标识优先于短RetryInfo。
- 其他限流按Retry-After或RetryInfo冷却，没有重试信息时使用60秒。冷却期间直接用Grok，恢复后再次尝试Gemini。
- 同一进程的翻译和Tag共享同Key指纹/API入口/模型的冷却。Web和Worker分别维护状态，重启后以首次真实响应重新确认。
- 鉴权、参数错误不误判为配额；Elucid失败或未配置Key时保留待处理，不回退已移除的供应商，也不把原文当译文。

## 实现边界

`packages/connectors/src/gemini-grok-task.js`共用单次任务请求与配额冷却。复用Elucid客户端的Responses传输与结果读取，不启用Agent、工具循环或新Runtime。翻译批量保留id与哈希缓存；标签继续经过现有Catalog白名单校验与Repository事务。

复用`ELUCID_GROK_API_KEY`、`AI_CENTER_ELUCID_GROK_API_ROOT`；独立的`AI_CENTER_FEED_GROK_MODEL`缺省grok-4.7，不跟随Ask的Harness模型切换。Key不出现在验收记录或页面。

## 验收

- `npm run check`：664项全部通过。
- 新增覆盖：批量配额回退、冷却期间跨翻译/Tag共享、冷却到期、每日重置/DST、Retry-After/RetryInfo、Key/模型隔离、缺Grok Key、鉴权错误、Grok失败、批量id缺失与缓存。
- 受控注入一次Gemini每日配额429，随后真实调用当前Instance的Elucid API：两条译文与两条标签写入独立验收SQLite，engine/model均为elucid-grok；数字与年份保持，复跑译文使用缓存。只发生一次Gemini调用、两次Grok调用。
- 配额响应是验收注入，不代表真实Gemini账号当时已经耗尽；Elucid响应是真实请求。合成测试文章不写入用户生产信息流。

供应商依据：[Gemini官方配额文档](https://ai.google.dev/gemini-api/docs/rate-limits)。实际限制按项目而不是单个Key，日请求配额在太平洋时间零点重置。
