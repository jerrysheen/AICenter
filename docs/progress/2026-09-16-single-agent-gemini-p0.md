# 单 Agent 问答 P0（历史阶段记录）

本文记录初次接入时的阶段状态；后续正确性修复见 `2026-09-16-agent-correctness-work-package-a.md`。

## 目标

建立不含多 Agent、复杂规划或写工具的最小 Agent 问答闭环，验证 Worker 可使用可替换的模型 Connector，并让模型按需读取本地数据。

## 已完成：第 1 阶段 Runtime 循环

- 新增受设备授权的 `POST /api/v1/agent/runs` 和查询 Job 状态的 `GET /api/v1/agent/runs/:id`。
- 请求只接受 `message` 和 `webMode`；当前 `webMode` 先保存为意图，不触发联网。HTTP 只创建固定 `ai.agent.run` Job。
- `agent.runtime` manifest 注册唯一 Worker handler；`AgentRuntime` 现在执行受限循环：模型请求 Tool → Registry 只执行已注册的 read Tool → ToolResult 返回模型 → 最终回答。单 Run 上限为 6 次 Tool Call。
- ToolDefinition 固定 provider 函数名、输入参数与 `effect`；ToolResult 固定为 `data`、`refs`、`observedAt`、`warnings`。空 Registry 不再被视为功能完成。
- Gemini 问答 Connector 使用 `AI_CENTER_AGENT_API_KEY`；未配置时仅回退读取已有 `GEMINI_API_KEY`，不复制或暴露真实密钥。Web 与独立 Worker 都读取本地 `.env`。
- 新增 Elucid Grok Responses Connector，默认模型为本机 Codex Grok 同样使用的 `grok-4.6` 及 `https://hk.getelucid.com/v1`。存在 `ELUCID_GROK_API_KEY` 时 Worker 自动选择它；可通过 `AI_CENTER_AGENT_PROVIDER=gemini` 显式切回 Gemini。
- Elucid 的当前账号不支持 `previous_response_id` 续接，因此 Connector 显式提交上一轮 function call 和本地 ToolResult；它仍只走受限的单 Agent 工具循环，不引入 harness、路由器或预取。
- Elucid Adapter 使用非流式 Responses：默认等待 90 秒（可用 `AI_CENTER_ELUCID_GROK_TIMEOUT_MS` 配置，最大 180 秒），避免复杂工具问题在模型完整返回前被 45 秒本地超时取消。
- 每次成功问答写入已有 `AiRun` 和 `knowledge.ai-run.completed.v1` 事件，不保存 API Key。
- Worker 额外写入追加式本地过程日志：`data/logs/agent-runs/YYYY-MM-DD.jsonl`。每条记录含 runId、开始、每轮模型请求/响应耗时、实际 ToolResult 与耗时、来源、完成或失败；不记录模型思维过程，且对 key、token、cookie、authorization、password、secret 等字段递归脱敏。
- 问答页输入框、推荐问题与发送按钮已接入该 API：页面展示提交、排队、生成、完成或失败状态，并直接显示回答；不再保留“结构占位”的假交互。

## 已完成：第 2 阶段本地只读 Tools

- Worker 将 ToolRegistry 注入到 Context、Feed、Knowledge 和 Trading 的公开 Domain Service；Tool 代码不导入 Repository、SQLite 或供应商 Connector。
- 已注册 `context.build`、`feed.search`、`knowledge.search`、`knowledge.get`、`user.method.get`、`market.overview.get`、`market.global.get`、`holdings.get`、`holdings.rank` 和 `assets.get`。
- `feed.search` 只在本地落库的 ContentItem 中做有界匹配，返回内容来源和时间；不会联网、刷新信息流或把整库预先塞给模型。
- `knowledge.get` 与 `user.method.get` 只读取同一 workspace 的当前 Revision；持仓、行情和资产 Tools 都返回稳定引用与快照时间。
- 用真实 Gemini 完成一次 `assets.get` 冒烟测试：模型请求 Tool，Runtime 执行后生成最终回答；没有打印密钥或个人资产内容。
- 用真实 Elucid Grok 完成一次 `assets.get` 工具循环：模型请求 Tool，Runtime 返回本地结果后模型完成回答；没有打印密钥或真实个人数据。

## 当时尚未完成：第 3 至 4 阶段

- 当时 SQLite FTS 索引、AiRun ContextRefs 同事务写入、Agent 专用 SSE 工具状态和页面来源引用仍待实现。其中 ContextRefs 已在后续正确性工作包接通；SSE 工具状态和页面来源引用仍待实现。

## 验证

- Agent Runtime 的假模型测试覆盖：模型函数调用只执行已注册 read Tool，并把 ToolResult refs 返回最终 Run。
- Agent Worker 的假模型集成测试覆盖：注册 handler、任务完成、回答输出和 `AiRun` 事件。
- HTTP 测试覆盖：设备授权、创建任务及状态读取。
- Elucid Responses adapter 的单测覆盖 function call 与显式 function output 的续接；`npm run check` 已通过 92 项测试。
- Agent Trace Log 测试覆盖本地 JSONL 落盘与敏感字段脱敏；Agent Worker 回归测试通过。

## 后续

下一步先把已验证的 `feed.search` 按数据规模升级为 SQLite FTS，再做 AiRun 来源持久化与页面展示。工具结果统一含 data、refs、observedAt、warnings；写工具和实时 Web Search 不属于本 P0。
