# V3-lite Context Service

## 目标

按“信息积累、市场观察、投资方法形成”的当前阶段收缩架构：不新增策略或决策领域，先让 Feed、Trading、Knowledge 的已有数据通过统一入口进入后续 AI 问答。

## 改动

- 新增 `packages/domain/src/context-service.js`；它只编排领域公开用例，不依赖 Web、SQLite 或具体 Connector。
- 新增受授权的 `POST /api/v1/context`，返回知识当前版本、可选近期信息、可选持仓行情和稳定引用。
- Knowledge FTS 检索限定为 `knowledge_items.current_revision`，历史 Revision 只由显式历史接口读取。
- 新增不可变 V10 migration：`ai_run_context_refs`。后续模型任务创建 `AiRun` 时必须同时写入这些引用，保存资源类型、ID、Revision 和快照时间。
- 更新 V3-lite 架构和产品边界说明；未增加 Policy、Strategy、Decision、Thesis 或自动交易。

## 验收

- Context API 不接触 Connector 或 SQLite，调用链保持 Route → Domain Service → 已有领域 Service。
- 新迁移不修改 V1–V9，已有数据库原地升级。
- Context 默认只读取知识当前 Revision。

## 后续

将实际 AI 问答实现为显式 Worker handler：创建 `AiRun` 与 `AiRunContextRef` 同事务写入，再调用可替换模型 Connector；网页只创建问题并读取结果。
