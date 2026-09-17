# 单 Agent Runtime P0 实施计划

状态：历史实施计划。当前实现与正确性边界以 `docs/architecture-modules-v1.md`、`packages/contracts/src/agent.js` 和 `docs/progress/2026-09-16-agent-correctness-work-package-a.md` 为准。

## 目标

在已有 Web / Worker / Domain / SQLite 边界内，交付一个单 Agent。它可以决定并调用已注册的**只读**工具，以本地知识、信息流和资产数据回答问题；不引入多 Agent、Planner State、自动交易或任意脚本执行。

## 已有基础与当前缺口

已有：`POST /api/v1/agent/runs`、`ai.agent.run` Job、Gemini Connector、问答页面、`ContextService`、`AiRun` 和 `ai_run_context_refs` 表。

当时缺口（已解决）：Runtime 尚未实际调用 Tool，Registry 为空，Gemini 只接收纯文本，因此不能读取知识库、持仓或资产。本段保留为立项历史，不描述当前状态。

## P0 冻结范围

### Runtime 与安全

- 单一 `AgentRuntime` 循环：模型请求工具 → Runtime 调 Registry → 返回标准 ToolResult → 模型给最终回答。
- 单次 Run 最多 6 次 Tool Call；只允许 manifest / Registry 明确注册的 Tool。
- Agent、Tool 和 Connector 均不得直接 SQL；Tool 仅调用 Domain Service 或 Connector Port。
- Tool 统一返回 `{ data, refs, observedAt, warnings }`；不返回 API Key、Cookie、机器路径或供应商原始敏感字段。
- 本 P0 仅 `read` effect。`write` / `destructive` 的确认策略只留接口与测试，实际灵感编辑放 P1。

### P0 只读工具

1. `context.build`：已有 ContextService 的基础上下文。
2. `market.overview.get`、`market.global.get`：标准化市场看板。
3. `holdings.get`、`holdings.rank`：当前持仓与涨跌排序。
4. `assets.get`：个人资产只读投影。
5. `knowledge.search`、`knowledge.get`、`user.method.get`：当前知识版本与投资方法。
6. `feed.search`：对落盘 ContentItem 的只读有界检索，返回时间与来源；数据规模增长后再升级为 SQLite FTS。

### Run 记录与页面

- `AiRun` 同时记录模型、最终回答、工具调用摘要、warnings 和 ContextRefs；不存模型思维过程。
- Job / Outbox 增加 `agent.run.*` 和 `agent.tool.*` 事件，页面展示“读取持仓 / 检索知识 / 正在回答”等真实状态。
- 页面显示答案及来源引用；没有证据时明确说明而不是编造。

## 明确不在 P0

- 原 P0 不实现联网搜索；后续已以本机 SearXNG、`search.web` Source 和兼容 Tool `web.search` 落地，仍不开放任意网络工具。
- `inspiration.create/update/archive`、知识修订和永久删除：P1，先落地写操作确认机制。
- 多 Agent、长期研究任务、自动交易、隐式记忆和通用 Planner。

## 实施顺序与验收

1. **Tool Contract + Registry + Gemini Function Calling**：已完成。固定 ToolResult 与 Tool 定义，完成最多 6 次的受控循环；Fake LLM 测试验证只执行注册工具。
2. **本地只读 Tools**：已完成。Context、Feed、Knowledge、Trading、Assets、Market 已接入，均使用 Domain Service 并返回稳定 ref；真实 Gemini 和 Elucid Grok 工具调用冒烟测试通过。
3. **Feed FTS**：当前 `feed.search` 已按近期 ContentItem 有界检索；后续以新 SQLite migration 增加 FTS，验证新库创建、旧库升级和查询过滤。
4. **AiRun 可复盘**：AiRun / ContextRefs / 完成事件已同事务写入；Agent 专用 SSE 工具状态与页面来源卡片仍是后续体验工作。
5. **端到端验证**：用 Gemini 测试“能访问哪些本地数据”“我的持仓今天表现如何”等问题；`npm run check` 必须通过。

每阶段完成后更新 `docs/progress/`，不以 UI 文案或空 Registry 作为“接入完成”。
