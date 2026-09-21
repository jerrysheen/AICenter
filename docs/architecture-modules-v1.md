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
- `packages/domain` 拥有业务规则和端口，不依赖 Web、Harmony、SQLite 或具体平台。信息流发给模型前由 `packFeedAiBatches` 标注字数；翻译一次最多 30 条打成一组，条目模型输入仍可截到约 5000 字。全文留在 ContentItem。粗筛 Tag 复用同一批处理：`purpose=analyze`，默认 20 条 / 30k chars，输出只保留 item_id 与 tags。
- `packages/database` 按领域提供 Repository，实现存储端口；调用方不直接持有数据库连接。
- `packages/connectors` 只负责供应商协议和标准契约之间的转换。浏览器采集走 Connector 内部 `BrowserRuntime`（Provider：`bsk` / BrowserSkill），不是 Source、Domain 或 Agent Tool。旧 Chrome CDP 已移除。信息流翻译和粗筛 Tag 走 Gemini；翻译缺 Key 时回退 DeepL / Google。灵感任务包走本机 Cursor CLI Connector：投递当下先落 `goal.json` / `progress.json`；Worker 领取后补写提示词，再 `spawn agent -p --force --trust`，CLI 每步往 `steps.jsonl` 追加 UTF-8 JSON，做完退出。读账本时按行识别 UTF-8 / GBK，已落成的 `parent-trace` 若步骤摘要是替换字符则回读父目录。同一 Worker 默认同行 3 路任务包 CLI，不并行抢 Agent Runtime。详情可 continue 另开 session，提示词带上一轮 goal / progress / steps，不是只复述上一句对话。不把 Cursor 当带 API Key 的云端供应商，也不把收件箱对话当工人。需要弹进程时写 `runtime/restart.request`；启动器只重启 Web/Worker，进程自己退出也弹回。`POST /api/v1/runtime/restart` 与 `work-package.dispatch` 只允许本机 `desktop-host`；已配对公网设备可以创建工作包记录，不能派发 Cursor CLI。公网不另开管理端口。
- `packages/runtime` 只负责任务生命周期、能力注册、重试和事件投递。Job Runner 按 Job 类型限并发：`work-package.dispatch` 默认 3，其余默认 1。Worker 周期回收过期租约；完成/失败必须校验当前执行者。Host 作用 Job 必须带入队时的 `callerCapability`；不足则失败关闭，不能靠 HTTP 入参把权限写高。
- `packages/harness` 是生产 Agent 执行器适配层：冻结 `dsh-base` profile、本机 Tool Gateway 和 Domain Tool 插件。它不拥有业务数据，也不替代 Job Runner。资料搜索等专用能力以后在这层上加插件，不另建 Runtime。调用方能力由 Web 入队与 Worker 失败关闭共同强制：`device-operate` 只看到 Domain Tool；Host 工具与 dsh Permission 预设只留给 `desktop-host`。
- Harness 的 `dsh-base` 已经包含 Session persistence、checkpoint、projection、query、compaction 等官方基础插件；AI Center 不重复安装或复制这些实现。`dsh-session-query-sqlite` 是 Harness 内部 Session 检索能力，不是产品 Job 状态 API，当前 SDK 协议也不暴露它。AI Center 只消费官方 `session.event` / `session.status` 通知和 Tool Gateway 执行结果，把它们投影为 provider-neutral 的 `AgentRunProgressStep`。
- 运行中状态使用 AI Center 自己的只读投影：Worker 将脱敏后的 Agent 事件追加到 SQLite，并与 `runtime.agent-run.progressed.v1` Outbox 事件同事务写入；Web 的 `GET /api/v1/agent/runs/:id` 读取 Job 真源与该投影，SSE 只通知客户端状态已变化。Harness JSONL、Session Query SQLite、DSH Home 路径和原始事件都不通过页面 Contract 暴露。Harness Session 日志仍是模型执行历史真源；AI Center 投影只服务产品进度、重启恢复与跨进程查询。

### 单 Agent Runtime

Ask Agent 冻结职责见 `docs/architecture-agent-v1.md`：Agent 思考和探索，Runtime 执行，Jev 给置信与质量信号。下面只记实现边界。

日常问答与文章阅读共用冻结的 DeepSeek Harness，不是多 Agent 或规划系统：

```text
POST /api/v1/agent/runs → ai.agent.run Job → Worker → Harness（dsh）→ Tool Gateway → Domain Tool Registry
POST /api/v1/article-analysis/runs → ai.article.analyze → 同一套 Harness.run()
```

- 生产执行器是冻结的 DeepSeek Harness：`dsh --profile sdk` + `packages/harness/aicenter.cordis.yml`（`dsh-base` 0.1.6-alpha.2 / commit `ddefc45fbc7f8e46dd73185e68295696d1297887`）。产品接口仍是 `agentRuntime.run()`。主模型只看 `AI_CENTER_HARNESS_PROVIDER`：`elucid-grok`（`llm-pi-ai` / `openai-responses` / `ELUCID_GROK_API_KEY`）或默认 `deepseek-official`（`llm-deepseek` / `DEEPSEEK_API_KEY`）。`$DSH_HOME/settings.yaml` 始终写入这两段。结构整理在 Elucid 路由上复用同一 Key/模型。同一 Worker 在 provider / model / 可见 Tool 变化时不复用 dsh 子进程。不复制 Harness core，不替换 Web / Job / SQLite。Domain Tool 仍只经现有 ToolRegistry 执行；Harness 子进程通过本机 Tool Gateway 回调。公开互联网是 Harness 基建：overlay 打开 `@deepseek-ai/dsh-tool-web`（`web_search` + `web_fetch`），不把 Domain `web.search` 注册进 Gateway。`elucid-grok` 时 `DSH_WEB_SEARCH_PROVIDER=elucid-grok`，由 `web-search-elucid` 调 Elucid Responses 原生 `web_search`；DeepSeek 官方路由仍钉 `deepseek-official`。`web_fetch` 保持 HTTP，不加 `web_read`。未设置 `AI_CENTER_HARNESS_TOOL_IDS` 时，Domain 可见 Tool 与原先本地循环相同（含研究档位），但 `web.search` 不再作为 Domain Tool 暴露给 Harness。文章阅读走同一套执行器，只换 Article Analysis Skill 的阅读框架和 Domain `allowedToolIds`。本地 `packages/runtime` 循环只留给注入 fake LLM 的测试，或显式 `AI_CENTER_AGENT_RUNTIME=local`。同一 Worker 只在同一调用方能力剖面且可见 Tool 集合不变时复用 dsh 子进程。`device-operate` 的 profile patch 关闭 Shell、写盘、subagent 与 OTel；内置 web 对 Ask 保持打开。打开 Host 工具或切换 dsh Permission 预设不得复用到公网 Ask。Jev Prior / Reviewer 观察 Harness Session 与 Gateway 结果；Evidence Gate 只过滤 Gateway 检索，不拦截内置 web。资料搜索以后做成 Harness 插件，当前不要另起执行器。
- AI Center `AiSession.id` 是产品会话身份，不直接复用为 DSH 物理 Session ID。同一 Worker 生命周期内用内存映射复用一个随机 Harness Session；Worker 重启或 Tool/能力剖面变化后生成新的 Harness Session，并把 SQLite 中保存的 prior turns 注入首轮重建上下文。这样既避免与 DSH 已持久化 Session 撞名，也不让产品续问、重新执行依赖某个子进程永远存活。
- 产品 HTTP 不直连 Harness，也不把一次模型调用留在 Web 请求生命周期里：`POST /api/v1/agent/runs` 仍只创建 SQLite Job；Worker 通过 SDK `session/prompt` 执行；`GET /api/v1/agent/runs/:id` 与 `/api/v1/events/stream` 读取应用层状态投影。当前 SDK 只有 `initialize`、`session/prompt`、`shutdown` 和 Session/Subagent 通知，没有通用 Session GET/Query/Cancel API；不得读取 DSH 私有 JSONL 或派生数据库来伪造产品接口。
- `AgentRuntime` 是薄循环：每轮把用户问题、会话历史、已解析的 `@ref`、当前时间和当前可见 Tool Table 交给模型；由模型自己决定直接回答、调用一个或多个 Tool。Runtime 负责 Tool visibility、权限、Schema、预算、并发、超时、`@ref` 确定性解析和 provenance validation。Runtime 不在模型首轮前执行 Intent Router，也不因「今天 / 最新 / 新闻 / 搜一下 / 社媒」裁剪 Tool。可选 TypeSafe / Jev 质量层不是 Router：Prior 默认 `shadow` 只写 Trace，不删除 Tool、不替模型选 Tool。T0 Prior 只问 root-capable tool 在当前用户问题上是否 **required**，不问 helpful。明确依赖前一步输出的 follow-up（`official.source.get` ← `static.signals.list`，`knowledge.get` ← `knowledge.search`，`memory.save` ← `taxonomy.list`）不计入 T0 miss；`knowledge.search` / `taxonomy.list` / `holdings.rank` 仍是 root-capable。Evidence Gate 默认 `enforce`：在 `web.search` / `knowledge.search` / `feed.search` / `feed.tag.search` 的结果进入模型 Context 前，给每条结果打 Relevance / Evidence / Quality，再对留下的证据问 Sufficiency；低相关或无证据的条目不进 Context，也不进 Source Footer。它看到的是检索标题 / URL / 摘要，不是持仓或官方全文。失败、关闭或超过总时限时放行原结果；默认两阶段合计 15 秒，可用 `AI_CENTER_JEV_EVIDENCE_TIMEOUT_MS` 覆盖，避免质量层长时间阻塞 Tool Result。后验只评 Process Quality：只看 Audit Projection（success / outcome / resultUtility / 条数 / 耗时）和 Evidence Gate 汇总分，不看最终回答或 Tool 正文。`empty-valid` 是「查询成功、资源不存在」的有效证据，不是失败，也不是「存在内容」。`partial` 的 utility 是 usable，不能标成 strong。维度分由 Jev 给出，总分由代码加权。Key 缺失、关闭或 API 失败只记 `advisor.prior.failed` / `evidence.gate.failed` / `reviewer.failed`，不失败 Run。`AI_CENTER_JEV_DISABLED=1` 或 `AI_CENTER_JEV_PRIOR=off` 可关 Prior；`AI_CENTER_JEV_EVIDENCE_GATE=off` 可关 Evidence Gate。`advisory` 只允许追加 T0 necessity hint，仍交给完整 Tool Table。
- 当前注册只读检索 Tool（含 `tag.list`、`feed.tag.search`、`static.signals.list`、`official.source.get`），以及写入 Tool `memory.save`。生产 Ask 的公开互联网是 Harness 内置 `web_search` / `web_fetch`。Domain `web.search` 只留给本地循环测试或 `AI_CENTER_AGENT_RUNTIME=local`。不开放任意脚本执行。`destructive` 仍禁止。
- 生产路径不再经 SourcePort 的 `search.web` 给 Agent 搜网页。`search.web` + DeepSeek Native Search Connector 仍保留给本地回退循环。`webMode` 在 Harness 上只影响 Prompt 倾向，不再隐藏联网能力：`off` / `fallback` / `always` 都有完整 `web_search` + `web_fetch`。本地循环仍可按 `webMode=off` 隐藏 Domain `web.search`。Final Guard 拒绝虚构的联网声称，以及用户明确要求联网但整次 Run 没有 `web.search` / `web.fetch` 的终稿。豆包补充检索仍只挂在本地循环第一次 Domain `web.search` 上；Harness 主链路不走这条 sidecar。
- `researchMode` 是同一条问答 Job 上的档位，不是第二个 Agent。Route 解析后由 Runtime Service 写入 Job；Domain 解析 `AgentResearchProfile`。更高模型、研究方法关键词和额外工具都走这个 Profile，当前只留口，不注册新 Tool、不换默认模型。
- Runtime 每轮向模型注入权威当前时间（UTC + 用户时区 `Asia/Shanghai` 本地时间）和 Provider-neutral System Prompt。相对时间窗口由支持 `timeRange` 的 Tool 确定性计算。模型不得用训练知识推断“今天”。Final Guard 拒绝虚构的联网使用，以及用户明确要求联网但整次 Run 没有 `web.search` / `web.fetch` 的终稿；不因为时效词强制 Web。
- `market.global.get` 是市场价格快照，不是新闻或央行决议工具。Global Board 的真实字段在 `watchlist` / `groups`（利率、美债、黄金、原油等），Agent projection 必须保留这些字段，而不是只投影 overview 用的 `sections`。
- `ToolRegistry` 是唯一工具入口。Tool 声明 `read`、`write` 或 `destructive` effect，并只能调用 Domain Service 或 Connector，不能直接 SQL。输入和结果在执行边界使用 Zod 校验，给模型的 JSON Schema 从同一输入 Schema 生成。
- Harness 看到的 Domain Tool 参数不是这份 JSON Schema 原文。`packages/harness/src/tool-catalog.js` 的 `toDefineToolParameters` 是我们自己写的 DSH `defineTool` 投影，不是官方 schema。DSH 冻结子集只接受 `type` / `enum` / `const` / `items` / `properties` / `required` / `additionalProperties`，以及注解 `description` / `title` / `default` / `examples`；`pattern`、`minLength`、`maxLength`、`minimum`、`maximum` 传进去会拒工具。投影必须：有 `default` 的字段不标 `required`（Zod `toJSONSchema` 会把它们放进 `required`，模型会误以为必填）；不被 DSH 接受的约束写进 `description` / `examples`，不要为了“干净”丢掉。执行校验仍以 Contract Zod 为准。改参数语义改 Contract；改模型怎么看见参数改这一层，不要放宽 `knowledge.search` 去迁就坏投影。
- Runtime 分别限制模型请求数、Tool 调用总数与并发数；默认总 Tool 调用上限为 12，模型请求上限仍为 7。每轮把 used / remaining / max 传给模型。单轮请求超过剩余次数时整批不执行（不部分执行），改为要求基于已有证据作答；工具预算耗尽不是 Run 失败。
- `ai.agent.run` 必须通过 `agent.runtime` capability manifest 注册；HTTP 只创建固定契约的 Job，不能指定 handler、脚本或 Provider。
- 文章阅读是 Article Analysis Skill，不是第二条 Agent 架构：`POST /api/v1/article-analysis/runs` → `ai.article.analyze` → 读取 Source → 同一套 `agentRuntime.run({ taskInstruction, allowedToolIds, enableAuxiliarySearch: false })`（生产上是 Harness）。问答页用智能体选择「文章阅读」显式进入，不走普通 `ai.agent.run` Job。Domain 可见 Tool 是 `knowledge.search`、`knowledge.get`；公开互联网复用 Harness 内置 `web_search` / `web_fetch`。AI 自己在同一次 Run 里判断 Knowledge / News / Mixed，并按需检索；最终只写 Markdown `AiRun.outputText`，`taskType` 为 `article-analysis.reader.v1`，不创建 KnowledgeDocument，不保存 Artifact JSON。进度与问答共用 `agent-trace-log`。冻结设计见 `docs/search-agent-v1.md`。专用搜索插件尚未实现。
- 生产 Ask 的主模型是 dsh LLM 路由，不是 `AI_CENTER_AGENT_PROVIDER`。Gemini 只给翻译 / Tag。Key 不进入 API、事件或数据库输出。
- 成功回答写入 Knowledge 所拥有的 `AiSession` / `AiRun`，并以 `knowledge.ai-session.created.v1`、`knowledge.ai-run.completed.v1` 记录可复盘的会话、provider、model 与 Job 引用；实际读取的来源同时写入 `AiRunContextRef`，会话详情可以读回。
- 问答页轮询 `GET /api/v1/agent/runs/:id` 时附带 `progress`：从本地 JSONL trace 投影工具/思考步骤，不经 Worker 重启、不把 Tool data 回传页面。进行中的任务不绑定当前页生命周期：离开会话或切到其他一级入口后，Worker 继续跑；页面用 `GET /api/v1/agent/runs` 对齐队列，并在记录列表、会话详情和主导航显示 `queued` / `running`。同一会话可连续入队多问；Worker 仍一次一条。

## 数据所有权

| 领域 | 拥有的数据 | 不允许直接修改 |
|---|---|---|
| Feed | source accounts、subscriptions、captures、content items、user states、item translations、identity fingerprints | 持仓、知识正文 |
| Tagging | Instance `config/tags.json`（缺失时用 `config/tags.default.json` 模板）与 `resource_taggings`（对文本的粗筛标签，可挂 content-item / inspiration / knowledge） | Knowledge Taxonomy、Capture 正文 |
| Taxonomy | Instance `config/taxonomy.json` 的未来输入 Contract；V16 旧 seed 仅为冻结的 Legacy Bootstrap | Tag Catalog、Core 常量 |
| Trading | instruments、aliases、quotes、portfolios、transactions、positions；个人资产类型 / 账户 / 期间快照；工作簿只作导入 | 信息流正文、AI 输出 |
| Knowledge | inspirations、work packages、AI sessions、AI runs、documents、revisions、chunks | Capture、交易流水 |
| Runtime | jobs、attempts、provider health、outbox events | 各领域聚合状态 |
| Identity | workspaces、members、devices、collector nodes、credential refs；可选 Instance 共享账号（环境变量，不建 User 表） | 领域业务记录 |

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

Market 聚合、观察池与 Human/AI Projection 属于 `packages/source`，Yahoo / 雪球 / 同花顺 Connector 只负责协议转换。
观察池内容来自 Instance `config/markets.json`；`config/markets.default.json` 只是新实例模板和兼容 fallback，Core JS 不保存个人观察分组。当前私有部署仓库可以版本化 `config/markets.json` 作为 Instance 快照，这不改变其 ownership。
`market.cn` 是独立 A 股看板，不覆盖亚洲 KR/JP/TW 观察池；同一 `symbol` 允许挂多个 `group`。`market.us` 只收美股上市代码（含 ADR），`market.asia` 只收 KR/JP/TW 本地代码；同一公司可以两边各挂自己的上市代码，不得把韩交所代码放进美股观察池。`market.overview` 按 `Asia/Shanghai` 工作日 17:00 切换单一 section：白天 A 股与港股观察（上证50 / 创业板50 / 科创50 / 恒生 / 港科），之后及周末美股观察。
雪球信息流 `content.xueqiu.home` 与行情 `xueqiu-quotes` 不是同一个 Connector：前者用 BrowserSkill 打已登录页的关注 / 精选 / 7x24 JSON，后者只做公开批量报价。
FeedService 通过 SourcePort 读取外部内容，再写入原有 `SourceAccount -> Capture -> ContentItem` 生命周期。Feed Filter 在 Source Snapshot 与 ContentItem 之间，确定性规则与 Jev 语义判断都放在 `packages/domain/src/feed-filter.js`，与 Agent Quality 分文件。
联网搜索不再作为生产 Source。DeepSeek Search Connector / `search.web` / Domain `web.search` 只在显式本地循环回退时注册；Source Definition 仍负责输入/输出契约、不可用状态与 AI Projection。SearXNG Connector 仍保留为 legacy，主链路不调用。
中美宏观日程、央行日程和官方政策发布同样注册在 Module Registry：Connector 只处理官方
HTML / ICS / RSS / JSON 协议，Source Definition 输出统一 `calendar` / `official-release` 视图。
当前 Snapshot 仍是只读缓存，不新增持久化表；规则生成日程必须保留 `official-rule + tentative` 来源标记。
`packages/source/src/static/board.js` 是 Source 层内的薄聚合器：并发读取公开静态 Source，确定性
合并、去重、排序并应用 `focus-events.json` 的首页关注投影，返回日程、最新发布和来源健康状态。
它不创建新 Domain、不写数据库、不调用 AI；完整低层日历仍可从各 Source 单独读取。
SCIO 英文站当前 HTTPS 证书与域名不匹配；经产品所有者明确接受后，`calendar.cn.scio` 仅对其
官方 Notices URL 使用 HTTP。该例外不关闭全局 TLS 校验，也不扩展到其他 Source 或任意跳转目标。
官方列表与正文读取分层：公开的 `calendar` / `official-release` Source 只负责发现记录；内部
`policy.official-detail` Source 按记录的 `sourceUrl` 读取官网标题、官方摘要和限长正文。详情读取只允许
登记过的官方域名，SCIO HTTP 例外仍严格限定为 `english.scio.gov.cn`，并校验最终跳转地址。
Agent 通过 `static.signals.list` 获取记录，再按需调用 `official.source.get`；全文不进入首页 Board、
不落数据库，也不经过 AI 总结或解释。内部 Source 不通过通用 `/api/v1/sources/:id` 暴露。
市场原生数据沿用同一 SourceHub，但使用独立 `prediction-market`、`crypto-derivatives`、
`stablecoin-liquidity` viewKind：Polymarket 与 Kalshi 报价不跨场所合并，Hyperliquid Funding / OI / Volume
保留原单位，DefiLlama 只投影稳定币供给与确定性时间差额。它们不写 Trading QuoteSnapshot，
也不进入官方事实 Board；当前仍是有 TTL 的只读 Snapshot。

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
- `TradingRepository`：Instrument、Alias、Portfolio、Transaction、PersonalAsset Type / Account / Snapshot。
- `KnowledgeRepository`：Document、Revision、全文检索。
- `FileKnowledgePort`：只读仓库 `knowledge/**/*.md`。`knowledge.search` / `knowledge.get` 经此投影，不把路径、`list_directory` 或任意 `read_file` 交给模型。第一版是文本搜索，不是 Vector DB。
- `JobRepository`：任务、执行尝试和健康状态。

新增平台时，应增加 Connector 和注册项；新增业务模块时，应增加自己的 contracts、domain 和 repository，
而不是向 `server.js` 或现有大表持续添加供应商特有字段。

## 兼容策略

- V1–V28 数据库迁移保持不可变；模块化底座从 V6 开始，V10 增加 `ai_run_context_refs`，V12–V14 完成会话归属与旧问答回填，V15 区分用户主动引用与 Tool 读取，V16 增加 Taxonomy 与结构化回填字段，V17 增加 `resource_taggings`，V18 增加灵感外部来源与采集入口字段，V19 增加离线同步幂等键与原始采集时间，V20 增加 `posts.hidden_at`，V21 增加灵感工作包 `work_packages`，V22 增加独立 Cursor session 字段，V23 增加 `feed_identity_fingerprints`，V24 增加工作包 `parent_work_package_id`，V25 增加 `attachments` / `resource_attachments`，V26 增加个人资产账本 `personal_asset_types` / `accounts` / `snapshots` / `dividends`，V27 允许同一期间标签多次快照，V28 增加 Harness Agent Run 的脱敏事件投影 `agent_run_events`。
- 旧 `posts`、`notes`、`knowledge_items` 接口继续工作，通过兼容层逐步转到领域服务。
- 新事件必须带 `.vN` 后缀；旧事件在兼容接口移除前继续保留。
- Contract 新增可选字段属于兼容变更；删除字段、修改语义或改变数值单位必须发布新版本。
