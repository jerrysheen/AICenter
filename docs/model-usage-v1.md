# 模型用量账本

2026-10-06 用户授权的旁路统计范围。只新增本地模型用量索引和查询，不改变 Ask、文章阅读、简报、翻译、打标的业务决策、执行预算或重试策略。

## 原生能力与验证

本地发布包 `@deepseek-ai/dsh-token-meter`、SDK、LLM、Session physical codec 与 JSONL backend 均为 `0.1.6-alpha.2`；冻结源码 commit 为 `ddefc45fbc7f8e46dd73185e68295696d1297887`。直接使用包导出，没有升级 Harness、修改 node_modules 或复制统计 fold。MIT 许可证保存于 `packages/harness/LICENSE.deepseek-harness`。

`test/harness-token-native.test.js` 验证实际安装包：正常轮次、带 usage 的失败尝试、同 step 重试、最终样本替换、缺失 usage、缺生命周期与矛盾总量。`deriveTurnTokenUsage` 的返回值是**整轮汇总**，不含逐请求明细。必须输入一个从 `turn/start` 到 `turn/end` 的完整 turn；多个 turn 分开调用。原生 `tokenUsage` 投影会替换同一尝试的样本，并在 `llm/retry-started` 后累计新尝试；它对缺失缓存桶使用零，不能据此向用户证明全部消费已知。

## 采集与归因

Runtime 下的账本 Service/Repository 负责应用查询索引。原生 Session 日志仍由 Harness 持有。

- 在 `harness-agent-runtime.js` 的原始 `onNotification` 处观察，先于进度过滤；`result.events` 补齐当前调用和 Final Guard 纠正调用。按真实 session、turn、step、attempt 生成稳定请求身份；同 seq 回放更新同一行，不新增费用。
- 单次尝试索引从真实 step/retry 生命周期定位，直接保留 settlement 的 provider usage。未收到响应的尝试仍有缺失记录；失败、有 usage 的重试也保留。step 开始不证明 HTTP 已到达供应商，缺 usage 的记录不能视为已知账单。
- 整轮汇总直接调用官方 `deriveTurnTokenUsage`，与请求桶独立展示，不再将整轮总量加入请求消费合计。对完整请求索引的input/output/total逐桶与原生汇总交叉校验，不一致时标记不完整。函数返回 undefined 时保留已确认请求及缺失请求；缺少尝试生命周期但有settlement时保留带未知attempt的partial索引，不能据此精确计价。
- 不完整记录在执行退出前，通过官方 `JsonlSessionPersistence.open(id, 'read')` 补读现有 `session.v3.jsonl` / `.zstd`。不取得写租约、不迁移或改写日志。只补当前调用已观察到的 turn，不把同 session 的旧轮次归给新 Job。缺文件、不支持/损坏日志、超过32MiB的物理日志保持不完整。压缩帧与断尾恢复由官方 backend 负责。
- JobRunner 使用 AsyncLocalStorage 关联 workspace、Job、Worker attempt；Harness 入队时捕获提交方上下文，避免队列下一项继承前项。阶段额外区分小时提炼、小时编辑与日报 payload stage。业务 session、Harness session、turn、step、attempt 分别保存。
- migration 41 仅新增 SQLite `model_usage_index` 及按任务/时间查询的索引。只存严格校验的归因、计数、状态与供应商路由；不复制 Prompt、答案、原始通知、Tool 参数、异常消息、URL、请求头、Key 或 Host 路径。更新与小型 Outbox 通知同事务。
- migration 62 给同一张表增加可空的 `http_status`。账本里的 `httpStatus` 只保存 100–599 的整数，用来区分 429 和 503；没有收到响应时保持 null。旧行没有这个字段时读取为 null。页面明细可以显示这个状态码，仍然不返回 provider、model 或会话日志路径。
- 账本校验、数据库写入、历史读取和通知失败均不得改变模型请求的成功/失败。异步旁路通知有1.5秒等待上限。进程异常退出留下的 pending 记录保留；查询结合既有 Job 状态/attempt 投影中断，不写回 Job。

## 绕过主模型适配器的请求

`web-search-elucid.js` 的每次实际 `POST /responses` 独立记录；400 去除 include 再请求属于第二次尝试。搜索子进程经原有回环 Gateway 的私有 token 投递脱敏用量，不直接打开 SQLite。Gateway 在请求开始时冻结归因，晚到 settlement 不得借用下一项任务身份；没有开始记录的孤立 settlement 不猜归因。

`gemini-grok-task.js` 覆盖现有翻译和打标的 Gemini 请求，`elucid-grok-agent.js` 覆盖其 Grok 回退及现有直连结构整理，`gemini-agent.js` 覆盖显式本地测试/回退适配器。Worker 请求归属当前 Job；Web 现有翻译入口归于 translation，未关联 Job 时明确空值。缓存复用/本地 passthrough 不创建模型请求记录。读取响应副本，原响应由业务继续消费。

这是 settlement usage 的账本，不是账户对账：网络中断或供应商不报告 usage 时无法证明精确消费，也不能从 token 估算供应商实际扣款。接入前的日志没有可信业务归因，本轮不自动全量导入。Harness 其他插件若不产生可观察的 turn/settlement usage，也不能据此宣称已覆盖所有账户请求。

## 费用与查询

入口：本机「任务」页的「模型用量账本（本机）」。接口：`GET /api/v1/runtime/model-usage?limit=50&offset=0&jobId=...`，沿用 desktop 权限，公网/配对身份不能读取。分页最多200行。页面 Contract 不返回 provider/model、原始 SessionEvent 或 Host 文件路径；执行身份用中立 `executionId` 表示。

供应商金额与估算分开。当前适配器没有可确认的供应商扣款金额/币种，保持 null。费率不默认猜测；通过 Instance 环境变量 `AI_CENTER_MODEL_USAGE_RATES_JSON` 输入数组，每项严格包含 provider、model、version、currency，以及每百万 token 的 inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens 价格。路由来自实际请求，不按模型名猜供应商。

例如下面只说明格式，数值是**合成测试费率**，不是当前 Elucid 报价：

```json
[{"provider":"elucid-grok","model":"grok-4.7","version":"fixture-only","currency":"USD","inputTokens":1,"outputTokens":2,"cacheReadTokens":0.5,"cacheWriteTokens":1}]
```

未配置、无匹配版本、计数不完整或缓存分布不能确认时，估算为 null。原生 pi-ai 映射省略零缓存桶：若精确 total 减去已确认的 input/output/cache 桶后残差确为零，非负桶约束可证明遗漏缓存桶为零，仅在计价时使用该证明；账本中的原始缺失字段仍保持 null。无法证明时不补零。不估算失败的未知尝试，不将 reasoning（output 子集）再次收费，不对整轮重复估算。

不安装社区 Web 面板，不轮询余额，不启用遥测。原统计实现只提供页面/API；2026-10-07用户明确要求接入问答工具后，新增只读`model.usage.get`（Harness函数名`model_usage_get`）。通过既有ToolRegistry→Gateway→Domain Service→Repository读取本工作区汇总，可按本地今天/昨天/近24或48小时、Job、阶段筛选。只累加request，失败尝试保留，turn不重复计算；每桶分别返回reported与unknownRequests，供应商缓存读取和应用缓存命中不能混同。状态投影保留已结束Job的中断请求。无供应商/模型/会话日志/任务内容/密钥，不查询账户余额，也不调用额外模型来算Token。

已有desktop限定的明细API权限不变；聚合工具作为同Instance问答的业务只读能力向已授权Ask开放。输入不能指定另一个workspace，执行时核对Service工作区与可信Run上下文。封闭树任务继续隐藏全部工具。原测试结论仅描述首次统计实现；新增工具的实际生产验收单独记录，不用fixture冒充真实问答。
