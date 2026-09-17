# Agent 正确性工作包 A

## 目标

核对外部审计提出的 P0 候选问题，只修复当前代码中可以复现的确定性缺陷，不更换应用框架、不增加多 Agent、Planner、向量库或写工具。

## 已确认并修复

- Elucid Grok Adapter 现在按顺序发送完整 user / assistant 历史、当前问题、provider 原始输出项和 `function_call_output`；续问不再退回第一条用户消息，同名并行调用按 `callId` 对应。
- ToolRegistry 使用 Zod 在 executor 前校验输入、在返回后校验 ToolResult；JSON Schema 从同一输入 Schema 生成。未知字段、非法枚举和越界整数不会进入 Domain，并检测归一化后的 providerName 冲突。
- Runtime 分开限制模型请求数、Tool 调用总数和并发数。总调用预算在执行批次前扣除；可选 Tool 失败不会丢掉同批成功证据，结果和错误均保留 `callId`。
- 新增共享 Tool Projection。`context.build`、`holdings.get`、`holdings.rank` 使用同一持仓字段投影，返回 `returnedCount`、`totalCount`、`truncated`；结果预算按 UTF-8 JSON 字节检查，不截断 JSON。
- 手工持仓账本改为 Composition Root 显式初始化。`getHoldingsBoard` 不再根据“现金为 0”推断未初始化，也不会在 read 中写 HoldingLot / Cash；不支持的 workspace 明确拒绝。
- Runtime 的 refs 现在与 AiRun 和 `knowledge.ai-run.completed.v1` 事件同事务写入已有 `ai_run_context_refs`，会话详情可读回；同一成功 Job 重试返回已有 AiRun，不重复生成答案记录。

## 验证

- 针对性测试覆盖真实 Adapter body、续问、provider 状态、同名并行 callId、非法参数零执行、providerName 冲突、总 Tool 预算、并发上限、可选失败保留成功证据、大 Context 投影、零现金不重灌、跨 workspace 拒绝、refs 读回与成功重试幂等。
- `npm run check` 全部通过：语法、Contract TypeScript、架构边界、Harmony 结构和 119 项测试均通过。
- 未调用真实 Provider；Adapter 测试使用固定 fake fetch。
- 未新增或修改数据库迁移；复用 V10 `ai_run_context_refs`。

## 保留到后续工作包

- 当前持仓看板查询仍会读取行情并取三个月历史；本轮只消除“查询隐式写账本”的副作用，未声称已经成为 snapshot-only 查询。
- 历史查询的 SQL LIMIT/token 预算、跨进程行情快照、总 deadline、取消传播、Agent SSE 阶段和页面来源卡片不在本工作包。
