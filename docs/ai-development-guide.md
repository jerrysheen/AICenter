# AI Center 后续开发手册

本文档说明如何在**现有分层**上改代码。当前停止线是 0.2.0 发布门槛，不是继续做 B4 关注同步。开始改代码前阅读：

1. `AGENTS.md`
2. `docs/release-readiness.md`
3. `docs/architecture.md`
4. `docs/architecture-modules-v1.md`
5. `docs/contracts-v1.md`
6. `docs/public-access-security.md`
7. `docs/product-v2.md`

`docs/plan/stage-2.md` 是历史拆分，不驱动当前开发。领域边界和字段语义分别以 `architecture-modules-v1.md`、
`contracts-v1.md` 和 `packages/contracts/src` 为准。不要另加 Intent Router、多 Agent 或新的数据库体系。

## 一、当前架构基线

截至工作包 B3，系统已经形成以下调用链：

```text
Harmony / Browser
        │
        ▼
HTTP Route
        │  只处理协议、鉴权、状态码和 View DTO
        ▼
Domain Service
        │  处理用例、业务规则和端口选择
        ▼
Repository Port / Provider Port
        │
   ┌────┴───────────────┐
   ▼                    ▼
SQLite Repository    Connector Adapter
   │                    │
   ▼                    ▼
领域表 + Outbox       外部平台 / 旧仓能力
```

后台任务链路：

```text
API / Scheduler
      │
      ▼
AgentJob
      │
      ▼
Worker + Capability Registry
      │
      ▼
显式注册的 Handler
      │
      ▼
Connector → Domain Service → Repository → Outbox Event
```

`apps/web/src/server.js` 是 Composition Root：允许在这里创建具体 Store、Connector 和 Service，
但不允许在这里继续堆业务路由或领域判断。

## 二、目录职责

```text
apps/
  web/src/server.js          进程启动、依赖组装
  web/src/http/              Router、响应、SSE、静态文件等 HTTP 基础设施
  web/src/routes/            分域 API 路由
  web/public/                Web/Harmony 共用 UI
  worker/                    后台任务执行进程
  harmony/                   ArkWeb 薄壳和原生能力

scripts/
  setup-searxng.ps1          一次安装本机 Search Worker（clone + venv）
  start-searxng.ps1          启动 127.0.0.1:8888 上的 SearXNG
  searxng-process.ps1        识别/停止 Search 进程的共用函数
  start-ai-center.ps1        启动 Web、Worker 与可选 Search

config/
  searxng-settings.yml       SearXNG 极简配置模板；运行时副本在 `.ai-data/searxng/`

packages/
  instance/src/              Instance 路径与分层 .env 解析；只在 Composition Root 使用
  contracts/src/             Zod 运行时契约和 TypeScript 类型视图
  source/src/                SourceHub、Source Definition、读取聚合与双 Projection
  domain/src/                领域 Service、业务规则和端口
  database/src/migrations.js 只增不改的数据库迁移
  database/src/repositories/ 分域 SQLite Repository
  connectors/src/           外部平台协议适配
  runtime/src/              Job Runner、capability registry

knowledge/
  finance/frameworks/        给 Agent 用的投资判断框架 Markdown
  …                          一人一条知识点；front matter 含 id / type / domain / tags

Instance 配置后的个人目录为 `<instance>/{data,knowledge,config,imports,runtime}`。未配置时继续使用旧仓库内目录。新代码不得再自行 `path.join(repositoryRoot, 'data'|'knowledge'|'config')`；Web、Worker 和 CLI 统一从 `packages/instance` 取得路径。

docs/
  release-readiness.md       当前验收与停止线
  architecture*.md           稳定架构决定
  contracts-v1.md            数据语义
  plan/                      历史阶段计划，不驱动当前开发
  progress/                  当时交付记录，冲突时以稳定文档为准
```

### 当前领域 Service

| Service | 文件 | 责任 |
|---|---|---|
| Identity | `packages/domain/src/identity-service.js` | 配对、设备、行为指标 |
| Feed | `packages/domain/src/feed-service.js` | 手工信息、外部 Feed、订阅入口 |
| Trading | `packages/domain/src/trading-service.js` | 行情端口、证券、组合、流水、手工持仓账本和个人资产分析入口 |
| Knowledge | `packages/domain/src/knowledge-service.js` | 灵感、AI 记录/会话、知识文档、版本、SQLite 检索，以及 FileKnowledgePort 投影 |
| Context | `packages/domain/src/context-service.js` | 跨领域 AI 读取；`build()` 与用户 `resolveReferences()` |
| Tagging | `packages/domain/src/tagging-service.js` | Tag Catalog、落盘标签、Agent 只读解析与按 Tag 反查 |
| Runtime | `packages/domain/src/runtime-service.js` | Job、状态、事件读取 |

### 当前 HTTP 路由

| 路由模块 | 责任 |
|---|---|
| `system-routes.js` | 健康检查 |
| `identity-routes.js` | 配对、Session、设备、行为指标 |
| `feed-routes.js` | 手工信息和外部信息流 |
| `trading-routes.js` | 行情、证券搜索和个人资产仪表盘 |
| `knowledge-routes.js` | 灵感、知识库、Taxonomy 与 from-run 整理任务 |
| `agent-routes.js` | 问答 Job、进行中的 Run 列表、AI 记录列表与会话详情 |
| `runtime-routes.js` | Worker 状态和 Job |
| `event-routes.js` | SSE 长连接入口 |

## 三、不可破坏的设计原则

### 1. 供应商不是领域

B站、X、Yahoo、雪球、同花顺、券商和 AI 模型都是可替换 Provider，不是页面或数据库的核心模型。

- 页面不得依赖 Yahoo spark、雪球 `xq_a_token`、同花顺 `thscode`、B站 Skill JSON、SearXNG 引擎名或 Nitter RSS 字段。
- Connector 必须先把结果转换为 Contract。
- 原始响应进入 `Capture` 或 `data/blobs`，不能直接成为 `ContentItem`、Position 或知识正文。
- 替换 Provider 时，Route 和页面契约应保持不变。

### 2. Route 不包含业务规则

Route 只允许：

- 匹配路径和方法。
- 执行访问控制。
- 使用 Contract 解析请求。
- 调用一个或少量明确的 Service 用例。
- 把结果转换成 HTTP 状态码和响应。

Route 不允许：

- import `packages/database` 或 `packages/connectors`。
- 直接执行 SQL。
- 计算持仓、收益、订阅调度或知识版本。
- 根据 Yahoo/B站/雪球/同花顺等 Provider 字段分支。

### 3. Domain 不知道基础设施

Domain Service 只依赖传入的 Port。禁止 import：

- `apps/*`
- `packages/database/*`
- `packages/connectors/*`

需要新能力时，为 Service 增加语义明确的 Port，而不是传入整个 HTTP request、数据库连接或供应商客户端。

### 4. Repository 按领域拥有数据

- Feed Repository 只拥有来源、订阅、Capture、ContentItem 和用户状态。
- Trading Repository 只拥有证券、别名、行情、组合、流水和持仓投影。
- Knowledge Repository 只拥有知识文档、版本、分块和检索。
- Runtime Repository 只拥有 Job、Attempt、事件和 Provider 健康状态。

跨领域工作通过 Service 编排、关系表或领域事件完成。禁止一个 Repository 直接更新另一个领域的表。

### 5. 数据事实和投影分开

- Capture 是抓取事实；ContentItem 是标准化投影。
- Transaction 是持仓事实；PositionSnapshot 是可重建投影。
- Inspiration 是用户原文；AiRun 和 KnowledgeRevision 是派生结果。
- Job 是期望工作；JobAttempt 是每次执行事实。

派生数据可以重建，原始事实不能被覆盖。

## 四、Contract 规则

`packages/contracts/src` 是可执行的唯一真源。文档示例不能代替运行时 Schema。

新增或修改数据类型时：

1. 在对应文件增加或修改 Zod Schema。
2. 在 `types.ts` 导出 TypeScript 类型。
3. 为合法值、非法值和边界值增加测试。
4. 判断兼容性：新增可选字段通常兼容；删除、改名、改变单位必须升级版本。
5. 不得用 `metadata` 逃避稳定字段建模。

### 全局数据约定

- 时间使用 UTC 毫秒时间戳。
- 金额、价格、数量、费率使用 Decimal 字符串。
- 未知值使用 `null`，不是空字符串或 `0`。
- 股票使用稳定 `canonicalKey`，Provider 代码进入 `InstrumentAlias`。
- 文件只保存仓库数据目录下的相对路径。
- API 列表最终使用不透明 cursor，不能让页面解释数据库 offset。

## 五、数据库迁移规则

数据库当前最新版本为 V20。V7 是手工持仓批次，V8 是公网配对安全字段，V9 是持仓批次开仓日 `opened_at`，V10 是 `ai_run_context_refs`，V11 是信息流译文 `feed_item_translations`，V12 是 `ai_sessions` 与 `ai_runs` 的会话归属，V13 回填归档后缺失的 Knowledge Revision / FTS，V14 从 Job / 灵感原文回填旧问答的提问，V15 为 context refs 增加 `origin` / `label`，并为灵感增加内部来源字段，V16 增加 `taxonomy_nodes` / `resource_taxonomy` / `taxonomy_proposals`，以及 `notes.title` / `inspiration_type` 与 `knowledge_items.knowledge_type`，V17 增加跨域粗筛 `resource_taggings`，V18 增加灵感的 `source_url` / `source_title` / `capture_channel` / `source_app`，V19 增加离线同步的 `client_mutation_id` / `captured_at` 与 workspace 内非空幂等索引，V20 增加 `posts.hidden_at`。

- V1–V20 一旦发布即不可修改、重排或删除。
- 下一次结构变化必须新增 V21。
- 不允许删除并重建用户数据库。
- 新列必须考虑旧行的默认值和回填。
- 需要替换字段类型时，先增加新权威列，完成双读/迁移后再决定是否淘汰旧列。
- 业务写入和对应 Outbox Event 必须在同一个事务内。
- 新迁移必须同时测试空数据库创建和旧数据库升级。

V6 中 Trading 的旧 REAL 列只用于兼容；`*_decimal` 才是新代码的权威列。

## 六、事件和后台任务规则

### 事件

新事件使用：

```text
<domain>.<aggregate>.<action>.vN
```

例如：

```text
feed.capture.saved.v1
feed.content-item.saved.v1
trading.transaction.appended.v1
knowledge.document.revised.v1
```

- Event payload 只包含消费方需要的稳定字段。
- 大正文和原始平台结果不能塞入 Outbox。
- 跨模块自动化应消费事件，不应轮询或直读其他模块私有表。
- 修改 payload 含义时发布 `.v2`，不能静默改变 `.v1`。

### Job

- Job type 必须显式注册。
- HTTP 不接受任意命令、文件路径或脚本名称。
- Handler 必须由 Capability Manifest 声明。
- 两个模块不能注册同一个 Job type。
- 每次执行都写入 JobAttempt；失败重试不能覆盖之前的错误记录。
- Handler 应具备幂等性，重复执行不能产生重复 Capture、交易或知识版本。
- `completeJob` / `failJob` 必须带当前 `workerId` 与 `attemptCount`；拒绝过期执行者的迟到结果。
- Worker 只回收租约已过期的 `running` 任务，启动时回收一次，运行期间周期回收；不要启动即重置全部运行中任务。
- SSE 按 `Last-Event-ID` 分页补发；超过窗口时 `ready.snapshotRequired`，前端拉 REST 快照。

## 七、如何增加不同类型的功能

### 增加一个本机 Search Provider

联网检索不是领域。SearXNG 只是 `search.web` 的 Adapter：

1. 运行时源码与 venv 在 `.ai-data/searxng/`，仓库只保存 `scripts/setup-searxng.ps1`、`scripts/start-searxng.ps1` 和 `config/searxng-settings.yml`。
2. Connector 在 `packages/connectors/src/searxng.js`，只允许回环 HTTP，输出稳定的 `{ query, results, observedAt }`。
3. `packages/source/src/search/definitions.js` 把 Connector 注册为 `search.web`，负责输入/输出校验、`unavailable` Snapshot、warnings 与 AI Projection。
4. Tool `web.search` 在 `packages/runtime/src/local-tools.js` 注册，只通过 SourcePort 读取 `search.web`，并按 `webMode` 暴露；失败时 warning，不失败整次 Run。`webMode` 只控制是否暴露工具与 Prompt 倾向，Runtime 不在首轮强制 `toolChoice=required`。Final Guard 仍拒绝虚构的联网声称，以及用户明确要求联网但未调用 `web.search` 的终稿。
5. 替换为其他搜索引擎时不改 Agent Runtime 循环或页面 Contract。Connector 负责把引擎日期标准化为 `publishedAt`，没有日期则为 `null`。

### 读取官方信源详情

官方列表与正文分开读取：

1. `static.signals.list` 通过 SourcePort 聚合公开的 `calendar` / `official-release` Source，向 Agent 返回时间、标题、机构和官方 `sourceUrl`。
2. 需要理解某一条发布时，Agent 再调用 `official.source.get`；它只通过内部 `policy.official-detail` Source 获取官网摘要和限长正文。
3. Connector 必须限制官方域名、复核跳转后的最终域名并限制页面与 Tool 结果大小。SCIO 的 HTTP 例外只能用于 `english.scio.gov.cn`。
4. 详情原文不进入首页 Board、不落数据库、不生成“意味着什么”的判断。模型作出的推断必须与工具返回的官方事实明确区分。

### 增加一条可复用 Knowledge 文件

判断结构（How to think）写入 `knowledge/`，不是聊天记录，也不是当前财报数字：

1. 一个 framework / concept 一个 Markdown 文件，YAML front matter 含稳定 `id`（如 `finance.framework.tech_growth`）、`type`、`domain`、`tags`。
2. 正文只保留 Goal、Analysis Chain、Metrics、Decision Rules、Warning Signals。
3. Connector `packages/connectors/src/local-knowledge-files.js` 只在该目录内 search/read；Domain 经 FileKnowledgePort 合并进现有 `knowledge.search` / `knowledge.get`。
4. 不要给 Agent 注册 `list_directory` / `read_file`。不要为此引入 RAG、Vector DB、Intent Router 或 Knowledge Agent。
5. 人看的解释稿以后放 `notes/`，不要写进 `knowledge/`。

### 增加一个新 Connector

若 Connector 提供外部读取能力，实施顺序是：

1. Connector 只完成供应商协议到稳定数据的转换。
2. 在 `packages/source/src/<category>/` 增加带 input/output Schema 的 Source Definition。
3. 在 Module Registry 的贡献项中同时声明并注册 `sourceIds` / `sources`；需要后台同步时再注册 job handler。
4. 已有 `viewKind` 与已有高层 Tool 能覆盖时，不改 Route、Domain、Agent Runtime 或 UI Renderer。
5. 用 `/api/v1/sources` 验证目录，用 `/api/v1/sources/:id` 验证 Human Snapshot，并测试 AI Projection 的大小边界。

`Source` 是读取能力；Feed 的 `SourceAccount` 是账号/频道持久化实体，两者不可合并。SearXNG Search
使用 `search.web` Source；Agent 兼容入口仍是 `web.search` Tool。

以 B站为例：

1. 在 `packages/contracts/src/feed.js` 确认输入和标准输出已经覆盖需求。
2. 在 `packages/connectors/src/bilibili/` 实现平台调用与原始结果转换。
3. 声明 manifest：模块 ID、版本、capability、job type。
4. 注册 `feed.bilibili.sync` handler。
5. Handler 调用 Feed Service，而不是直接执行 SQL。
6. Feed Service 通过 Repository 写入 Capture 和 ContentItem。
7. 同事务产生版本事件。
8. 页面继续读取统一 Feed DTO，不增加 B站专用卡片数据结构。

### 增加领域内功能

例如“收藏信息”：

1. 确认属于 Feed 的 UserItemState。
2. 增加 Contract command/result。
3. 增加 Feed Repository 方法。
4. 在 Feed Service 中实现用例和规则。
5. 增加 Route。
6. 增加 Repository、Service、HTTP 三层测试。

### 增加个人配置或导入来源

1. 先判断它是平台能力、Instance 数据还是 Host 服务。
2. JSON / Excel / 券商导出只负责转换为稳定 Contract；不得由 Connector 直接写数据库。
3. 个人持仓走 `PortfolioImport → Trading Service → Trading Repository`，不得重新引入启动 seed。
4. 观察池、Tag、Taxonomy、Knowledge 使用 InstanceConfig 解析出的目录；Core 默认文件只能是无个人状态的模板。私有部署仓库中的个人文件属于版本化 Instance 快照，不得被代码 import 成 Core 常量。
5. `taxonomy-seed.js` 是 V16 Legacy Bootstrap，不得添加新个人节点；新分类先进入 `TaxonomyCatalog` / Instance `taxonomy.json`。
6. Browser Connector 不各自读取 browserId；由 BrowserRuntime 自动应用 Instance 默认值。

### 增加一个全新领域

例如未来增加“任务管理”：

1. 先写领域边界、拥有的数据和禁止依赖。
2. 新增独立 Contract 文件。
3. 新增独立 Domain Service 和 Port。
4. 新增独立 Repository 和迁移表。
5. 新增独立 Route 文件。
6. 跨域关系使用事件或关系表，不向 Feed/Knowledge 大表不断追加字段。

### 增加跨领域功能

例如日报汇总 Feed、Trading、Knowledge：

- Daily Report 拥有自己的聚合结果。
- 它通过各领域公开的查询 Port 或事件读取信息。
- 它不能直接 JOIN 所有领域私有表并把该 SQL 放在 Route 中。
- 日报保存来源引用，以便回到具体 ContentItem、PositionSnapshot 或 KnowledgeRevision。

## 八、测试与完成标准

每轮完成前必须运行：

```powershell
npm run check
```

它至少覆盖：

- JavaScript 语法。
- Contract TypeScript 类型检查。
- 架构依赖方向。
- Harmony 工程结构。
- 数据库迁移和业务测试。

功能按风险增加以下测试：

| 改动 | 最低测试 |
|---|---|
| Contract | 正常、非法、边界值 |
| Repository | 持久化、唯一约束、事务事件 |
| Service | 使用 Fake Port 验证业务规则，不连接外部网络 |
| Route | 状态码、鉴权、请求解析、响应形状 |
| Connector | 固定 Fixture 解析、超时、失败归一化 |
| Migration | 新库创建、旧版本升级、数据不丢失 |
| Worker | 幂等、重试、JobAttempt、未知 handler 拒绝 |

完成一项重要开发后，必须更新 `docs/progress/`。如果改变稳定架构，同时更新设计文档，不能只留在聊天记录里。

## 九、明确禁止的捷径

- 不把新功能继续全部写入 `server.js`。
- 不让 Route 直接调用 SQLite 或 Connector。
- 不让 Worker 执行 HTTP 传入的任意命令。
- 不把所有业务塞进 `posts`、`notes` 或一个通用 JSON 表。
- 不用 Provider Symbol 作为全局证券 ID。
- 不用浮点数作为交易账本的权威金额。
- 不覆盖灵感原文、原始 Capture 或历史知识版本。
- 不修改已执行的 migration。
- 不因只有一个本地用户就省略 `workspaceId`。
- 不把 Cookie、API Key、Token 或机器绝对路径返回手机端。
- 不为 Harmony 重写第二套业务 UI。

## 十、当前停止点

当前先完成 `docs/release-readiness.md` 的隐私、安全和稳定性验收，不继续扩大功能。关注 UP 列表同步不是本轮下一步。

已具备（不要再写成「尚未开始」）：

- Web/Harmony 连接、配对、快速发布和 SSE。
- 工作包 B 的模块边界、Contract、migration、Domain Service、分域路由与 Worker。
- 单 Agent Runtime（无前置 Intent Router）。
- B站贴链接抓 AI 中文字幕；雪球优先、同花顺回退的行情适配；Yahoo / X 等信息源。

豆包网页聊天入口是 `node scripts/ask-doubao.mjs "问题"`，JSONL 信封是 `node scripts/ask-doubao-jsonl-envelope.mjs`。每个进程实例内部用 `createDoubaoAskQueue` 一次一条；**Web / Worker / CLI 不共用一条跨进程队列**。信息流 `translateMany` 一次只发一封 `translate_feed_items`；英文抓取入库后自动走这一层，并允许轻度清洗。JSON 齐了立刻结束。Tag 走 `task=tag_texts`，Worker Job `tagging.analyze`。豆包挂起则返回，由刷新或补翻译再试。仅格式验收失败才走一次 Gemini。实现在 `packages/connectors/src/doubao` 与 `translate`，只复用 BrowserRuntime。不接入 Agent Tool，不回退 Chrome CDP。用户 view 不展示原文；原文接口为 `GET /api/v1/content-items/:id/original`。

B站贴链接链路（已接入，本轮不扩展为关注同步）：

```text
粘贴 B 站链接
→ POST /api/v1/feed/bilibili
→ Feed Service
→ Bilibili Connector → BrowserRuntime（bsk）
→ Capture
→ ContentItem
→ feed.*.v1 Event
→ 信息页「B站」筛选
```

成功标准仍是：重启后卡片仍在；没有 AI 中文字幕时返回「没有」，不回退普通字幕；页面仍读统一 FeedItem。
