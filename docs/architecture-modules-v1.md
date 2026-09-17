# 模块架构 V1

本文档冻结工作包 B 的依赖方向。目标不是把所有功能做成一个通用大模块，而是让信息、交易、知识和未来模块能够独立演进。

## 依赖方向

```text
apps/web ─────┐
apps/worker ──┼──> domain services ──> repository ports
apps/harmony ─┘            │                    │
                            │                    └──> packages/database
                            └──> domain events

packages/connectors ──> contracts + domain ports
packages/source ──────> contracts + connector protocols
packages/runtime ─────> contracts + registered handlers
packages/instance ────> Node path/fs（仅 Composition Root 使用）
```

- `apps/web` 只做 HTTP、授权、SSE 和页面资源，不保存供应商字段，不包含持仓计算或抓取规则。
- `apps/worker` 只调度显式注册的任务。HTTP 请求不能传入任意命令、脚本或模块路径。
- `packages/contracts` 是进程之间的数据唯一真源，提供 Zod 运行时校验和 TypeScript 类型视图。
- `packages/instance` 只解析当前单用户 Instance 的路径和环境优先级；Domain、Repository 和页面不得依赖它。Web / Worker 在 Composition Root 解析后把具体 Port 和路径注入下层。
- `packages/domain` 拥有业务规则和端口，不依赖 Web、Harmony、SQLite 或具体平台。信息流发给模型前由 `packFeedAiBatches` 标注字数；翻译一次最多 30 条打成一组信封，条目模型输入仍可截到约 5000 字。全文留在 ContentItem。粗筛 Tag 复用同一批处理：`purpose=analyze`，默认 20 条 / 30k chars，输出只保留 item_id 与 tags。
- `packages/database` 按领域提供 Repository，实现存储端口；调用方不直接持有数据库连接。
- `packages/connectors` 只负责供应商协议和标准契约之间的转换。浏览器采集走 Connector 内部 `BrowserRuntime`（Provider：`bsk` / BrowserSkill），不是 Source、Domain 或 Agent Tool。旧 Chrome CDP 已移除。豆包网页问答同样只存在于 Connector（`packages/connectors/src/doubao`），登录态留在用户 Chrome，不给 Agent 增加 Browser Tool。每个进程实例内部用一条 `DoubaoAskQueue`（一次一条，入队后回收回复）；Web / Worker / CLI **不**共用跨进程队列。该队列不是 Worker Job，也不是 Agent Tool。信息流批量翻译发一封 JSONL；JSON 齐了立刻回收。豆包挂起不自动重试。仅格式验收失败再回退一次 Gemini。
- `packages/runtime` 只负责任务生命周期、能力注册、重试和事件投递。Worker 周期回收过期租约；完成/失败必须校验当前执行者。

### 单 Agent Runtime

日常问答使用一个轻量 `AgentRuntime`，不是多 Agent 或规划系统：

```text
POST /api/v1/agent/runs → ai.agent.run Job → Worker → AgentRuntime → LLM / Tool Registry
```

- `AgentRuntime` 是薄循环：每轮把用户问题、会话历史、已解析的 `@ref`、当前时间和当前可见 Tool Table 交给模型；由模型自己决定直接回答、调用一个或多个 Tool。Runtime 负责 Tool visibility、权限、Schema、预算、并发、超时、`@ref` 确定性解析和 provenance validation。Runtime 不在模型首轮前执行 Intent Router，也不因「今天 / 最新 / 新闻 / 搜一下 / 社媒」裁剪 Tool。
- 当前注册只读检索 Tool（含 `tag.list`、`feed.tag.search`）、可选联网 Tool `web.search`，以及写入 Tool `memory.save`（经 Domain Service 落灵感/知识）。不开放任意脚本执行。`destructive` 仍禁止。
- `web.search` 通过 SourcePort 读取 `search.web`（当前 Provider 为本机 SearXNG Connector），返回标题、URL、摘要和 `publishedAt`；不把供应商原始字段、本机路径或 HTML 交给模型。`webMode` 只控制能力是否可用与用户倾向：`off` 不暴露该工具；`fallback` 与 `always` 都暴露，区别只在统一 Agent System Prompt。`always` 不是必须调用 Web。正常轮次 `toolChoice` 为 AUTO / 不传。Search Worker 不可用时 SourceSnapshot 为 `unavailable` 并携带 warning，问答继续。
- Runtime 每轮向模型注入权威当前时间（UTC + 用户时区 `Asia/Shanghai` 本地时间）和 Provider-neutral System Prompt。`budgetNote` 只含当前时间与 Tool budget。相对时间窗口由支持 `timeRange` 的 Tool 确定性计算。模型不得用训练知识推断“今天”。Final Guard 拒绝虚构的 `web.search` 使用，以及用户明确要求联网但整次 Run 没有调用 `web.search` 的终稿；不因为时效词强制 Web。
- `market.global.get` 是市场价格快照，不是新闻或央行决议工具。Global Board 的真实字段在 `watchlist` / `groups`（利率、美债、黄金、原油等），Agent projection 必须保留这些字段，而不是只投影 overview 用的 `sections`。
- `ToolRegistry` 是唯一工具入口。Tool 声明 `read`、`write` 或 `destructive` effect，并只能调用 Domain Service 或 Connector，不能直接 SQL。输入和结果在执行边界使用 Zod 校验，给模型的 JSON Schema 从同一输入 Schema 生成。
- Runtime 分别限制模型请求数、Tool 调用总数与并发数；默认总 Tool 调用上限为 12，模型请求上限仍为 7。每轮把 used / remaining / max 传给模型。单轮请求超过剩余次数时整批不执行（不部分执行），改为要求基于已有证据作答；工具预算耗尽不是 Run 失败。
- `ai.agent.run` 必须通过 `agent.runtime` capability manifest 注册；HTTP 只创建固定契约的 Job，不能指定 handler、脚本或 Provider。
- 模型是 Connector。`AI_CENTER_AGENT_API_KEY` 可替换测试阶段的 `GEMINI_API_KEY`，两者均不进入 API、事件或数据库输出。
- 成功回答写入 Knowledge 所拥有的 `AiSession` / `AiRun`，并以 `knowledge.ai-session.created.v1`、`knowledge.ai-run.completed.v1` 记录可复盘的会话、provider、model 与 Job 引用；实际读取的来源同时写入 `AiRunContextRef`，会话详情可以读回。
- 问答页轮询 `GET /api/v1/agent/runs/:id` 时附带 `progress`：从本地 JSONL trace 投影工具/思考步骤，不经 Worker 重启、不把 Tool data 回传页面。

## 数据所有权

| 领域 | 拥有的数据 | 不允许直接修改 |
|---|---|---|
| Feed | source accounts、subscriptions、captures、content items、user states、item translations | 持仓、知识正文 |
| Tagging | Instance `config/tags.json`（缺失时用 `config/tags.default.json` 模板）与 `resource_taggings`（对文本的粗筛标签，可挂 content-item / inspiration / knowledge） | Knowledge Taxonomy、Capture 正文 |
| Taxonomy | Instance `config/taxonomy.json` 的未来输入 Contract；V16 旧 seed 仅为冻结的 Legacy Bootstrap | Tag Catalog、Core 常量 |
| Trading | instruments、aliases、quotes、portfolios、transactions、positions；个人资产分析为工作簿只读投影 | 信息流正文、AI 输出 |
| Knowledge | inspirations、AI sessions、AI runs、documents、revisions、chunks | Capture、交易流水 |
| Runtime | jobs、attempts、provider health、outbox events | 各领域聚合状态 |
| Identity | workspaces、members、devices、collector nodes、credential refs | 领域业务记录 |

同一领域内部可以使用外键保证完整性。跨领域只允许：

1. 稳定 ID 引用，不把对方字段复制进自己的主表。
2. 独立关系表，例如 `knowledge_links`。
3. 带版本的领域事件，例如 `feed.content-item.saved.v1`。

跨域删除不得依赖数据库级联。拥有数据的领域先产生事件，消费方自行清理引用或保留历史快照。

## 可插拔能力

每个 Connector 或 Agent 模块必须声明 manifest：

```json
{
  "id": "connector.bilibili",
  "version": "1.0.0",
  "capabilities": ["feed.capture"],
  "jobTypes": ["feed.bilibili.sync"]
}
```

模块 manifest 还可以声明 `sourceIds`，贡献项使用同一个 Module Registry 注册：

```js
{ manifest, sources: [sourceDefinition], jobHandlers: { ... } }
```

Source Definition 包含 manifest、input/output Schema、reader 和可选 AI Projection。Module Registry
拒绝未声明、缺失或重复的 Source；SourceHub 负责校验、缓存、并发合并和 Snapshot。不得再为来源另造
ConnectorRegistry / SourceRegistry / AdapterRegistry。Provider ID 是供应商稳定标识，Source ID 是读取能力
（例如 `market.global`）；两者不能混用。

Market 聚合、观察池与 Human/AI Projection 属于 `packages/source`，Yahoo/同花顺 Connector 只负责协议转换。
观察池内容来自 Instance `config/markets.json`；`config/markets.default.json` 只是新实例模板和兼容 fallback，Core JS 不保存个人观察分组。当前私有部署仓库可以版本化 `config/markets.json` 作为 Instance 快照，这不改变其 ownership。
FeedService 通过 SourcePort 读取外部内容，再写入原有 `SourceAccount -> Capture -> ContentItem` 生命周期。
联网搜索以 `search.web` 注册到同一 Module Registry；SearXNG 仍只负责协议转换，Source Definition
负责输入/输出契约、不可用状态与 AI Projection，`web.search` Tool 不直接持有 Connector。

运行时只接收 manifest 声明过的 handler。任务类型不能被两个模块重复注册。一个 capability 可以有多个实现，
由配置或领域服务选择，页面不得按模块名称分支。

模块配置、凭证和结果分开保存：

- 配置只保存非敏感参数。
- 凭证表只保存 `CredentialRef`，真实 Cookie、Token 留在本机安全存储或采集节点。
- 原始平台结果进入 `Capture` 和 `data/blobs`。
- 标准化结果进入领域表。
- 页面只读取标准契约。

## 稳定端口

第一批 Repository 端口：

- `FeedRepository`：来源账号、Capture、ContentItem。
- `TaggingRepository`：跨域 `resource_taggings`。
- `TradingRepository`：Instrument、Alias、Portfolio、Transaction。
- `KnowledgeRepository`：Document、Revision、全文检索。
- `FileKnowledgePort`：只读仓库 `knowledge/**/*.md`。`knowledge.search` / `knowledge.get` 经此投影，不把路径、`list_directory` 或任意 `read_file` 交给模型。第一版是文本搜索，不是 Vector DB。
- `JobRepository`：任务、执行尝试和健康状态。

新增平台时，应增加 Connector 和注册项；新增业务模块时，应增加自己的 contracts、domain 和 repository，
而不是向 `server.js` 或现有大表持续添加供应商特有字段。

## 兼容策略

- V1–V20 数据库迁移保持不可变；模块化底座从 V6 开始，V10 增加 `ai_run_context_refs`，V12–V14 完成会话归属与旧问答回填，V15 区分用户主动引用与 Tool 读取，V16 增加 Taxonomy 与结构化回填字段，V17 增加 `resource_taggings`，V18 增加灵感外部来源与采集入口字段，V19 增加离线同步幂等键与原始采集时间，V20 增加 `posts.hidden_at`。
- 旧 `posts`、`notes`、`knowledge_items` 接口继续工作，通过兼容层逐步转到领域服务。
- 新事件必须带 `.vN` 后缀；旧事件在兼容接口移除前继续保留。
- Contract 新增可选字段属于兼容变更；删除字段、修改语义或改变数值单位必须发布新版本。
