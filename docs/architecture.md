# 架构

当前产品版本是 **0.2.0 基线候选**。当前问题与验收见 `docs/release-readiness.md`。
下文「第一版兼容层」是仍在运行的连接闭环，不是当前工作范围。

单 Agent / Worker 已经接入；不要再写成「AI Worker 后续接入」。不另建 Intent Router、多 Agent 或新的数据库体系。

## Single-user Instance 边界

当前仍只保证一个人的 AI Center 完整可用，但 Core、个人 Instance 与机器级 Host Service 不再混放：

```text
AI Center Core                 AI Center Instance              Host Services
代码 / Domain / Contract      data / knowledge / config       BrowserSkill daemon
Runtime / Connector / UI      imports / runtime / .env        SearXNG
```

- Core 只定义能力、业务规则和数据契约，不包含某个人的持仓、账户 ID、观察池、Tag、Taxonomy、知识或浏览器登录态。
- Instance 是可替换的个人状态根。`packages/instance` 统一解析 Web、Worker 和脚本使用的路径；当前不建设 User、Tenant、Membership 或 Instance Manager。
- Host Service 是机器级可复用基础设施。BrowserSkill daemon 与 SearXNG 不归某个 Instance 所有，也不随单个 Instance 停止。
- 未设置 `AI_CENTER_INSTANCE_DIR` 时保持旧单用户布局：`data/`、`knowledge/`、`config/`、`data/imports/`、`.ai-data/`。
- 设置后使用 `<instance>/{data,knowledge,config,imports,runtime}` 与 `<instance>/.env`。环境优先级是 Process Environment → Instance `.env` → Repository `.env` → 默认值；显式代码注入只用于测试和 Composition Root。
- `AI_CENTER_DATA_DIR`、`AI_CENTER_KNOWLEDGE_DIR`、`AI_CENTER_ASSET_WORKBOOK` 继续作为字段级兼容覆盖。`AI_CENTER_BROWSER_ID` 指定该 Instance 默认使用的浏览器，单次 session 显式值仍优先。端口优先级为显式 Launcher / Composition Root 参数 → Process Environment → Instance `.env` → Repository `.env` → `8787`。
- 不自动加载 `instance/extensions/` 下的任意 JS；扩展执行、安全和版本契约等第二个真实 Instance 出现后再设计。

持仓运行时事实只来自 SQLite 的 Portfolio / HoldingLot / Cash。外部 JSON、Excel、旧账本或未来券商 Adapter 必须先转成 `PortfolioImport`，再经 Trading Service 与 Repository 合并；进程启动不得再次灌入个人持仓。市场观察池、粗筛 Tag 与知识分类树分别归属 Instance `config/markets.json`、`config/tags.json`、`config/taxonomy.json`。Core 只提供中立的 `.default.json` 模板；当前私有部署仓库另外版本化现有单用户 Instance 快照，但这些文件仍属于 Instance，不得变回 Core 常量。

V16 已写入的个人 Taxonomy 不删除、不迁移，也不改写历史 migration。`packages/database/src/taxonomy-seed.js` 仅是冻结的 Legacy Bootstrap，不得继续增加个人节点；`TaxonomyCatalog` 与 `config/taxonomy.default.json` 已建立未来 Instance 输入边界，真正切换新数据库 bootstrap 必须通过后续显式设计或前向 migration 完成。

## 第一版兼容层

```text
HarmonyOS App / 手机浏览器
              |
              | HTTP（同一局域网）或可选公网 HTTPS Tunnel
              v
    AI Center Web Server
        |       |       |
        |       |       +-- SSE 实时事件（仅在线期间）
        |       +---------- /api/v1
        +------------------ 响应式网页
              |
              v
            SQLite（CREATE TABLE IF NOT EXISTS）
```

兼容接口仍在运行：

- `apps/web/src/server.js`：页面、API、配对和 SSE。
- `apps/web/public/`：无构建步骤的响应式网页。
- `packages/contracts/`：发布、配对、灵感和行为事件的请求校验。
- `packages/database/`：设备、帖子、灵感、知识库，以及向第二阶段 schema 的无损迁移。
- 对手机开放的只有 Web/API 端口。

第一版 API 和页面没有被删除，第二阶段通过兼容层继续提供这些能力。

## 第二阶段（V3-lite 当前运行骨架）

```text
鸿蒙薄壳 / Web
        │
        ▼
AI Center API + SSE
        │
 ┌──────┼───────────┐
 ▼      ▼           ▼
信息域  交易域      知识域
        │
        ▼
SQLite + 原始文件 + 任务/事件表
        ▲
        │
后台 Worker（Node）        Search Worker（本机 Python / SearXNG）
 ┌──────┴──────────────┐     仅 127.0.0.1:8888
 ▼                     ▼
旧 AI Skills Adapter   旧 AI-Hub 行情 Adapter
B站 / X / 字幕          同花顺 / Yahoo（本机 HTTP）
```

关键变化：

- Web 只负责页面、API、配对和读取结果。
- 独立本地 Worker 负责定时抓取、重试、字幕和 AI 加工。
- 可选 Search Worker 是本机 SearXNG（Python venv），只监听回环地址，供 Agent `web.search` 调用；不是公共搜索站。源码和 venv 放在 `.ai-data/searxng/`，不进 Git。未安装或启动失败时 Web / Worker 仍可用。
- 旧仓库继续运行，通过配置路径或本机 HTTP 调用，不立即迁移代码。
- 只有 AI Center 的 Web 端口对手机开放；旧服务和浏览器调试端口只监听本机。
- 用正式 `schema_migrations` 替代单纯的 `CREATE TABLE IF NOT EXISTS`。
- Worker 写入 `jobs` 与 `outbox_events`。只回收租约已过期的 `running` 任务（启动一次 + 周期回收），不在启动时重置全部运行中任务。`complete` / `fail` 必须匹配当前 worker 与 attempt。SSE 按 `Last-Event-ID` 分页补发，超过窗口时 `ready.snapshotRequired`。
- 新业务数据带 `workspace_id`；P0 只有默认用户。

当前实现已经完成上述进程与数据骨架。B站链接抓取已注册 `feed.bilibili.sync`，通过 Connector 内部 `BrowserRuntime`（`bsk` / BrowserSkill）只取 AI 中文字幕并写入 Capture / ContentItem。Yahoo 行情（美股/亚洲/全球资产/港股通）与同花顺 A 股快照、场内 ETF 快照、以及 X 首页已登录时间线已通过同一 BrowserRuntime 接入。豆包网页聊天是同一 BrowserRuntime 上的 Connector：用户在扩展所连 Chrome 里登录，脚本只负责发一条 JSONL 信封并回收固定 JSON，不是 Agent Browser Tool，也不走 Chrome CDP。信息流翻译优先这条信封；合法 JSON 一出现就结束等待。发给豆包的消息在**当前进程实例内**串行、一次一条；Web、Worker、CLI 并不共用一条跨进程队列。豆包挂起则立刻失败，等用户再点翻译。只有格式验收失败才回退一次 Gemini。页面只消费 `lastPrice` / `previousClose` 和统一 FeedItem，不暴露供应商字段。同花顺已有适配代码，真实依赖与延迟见发布门槛，不要写成「尚未接入」。

未来 1～2 年保持轻量边界：Feed、Trading、Knowledge、Runtime、Identity 继续作为稳定领域；Context Service 是跨领域的 AI 读取入口，而不是新的 Decision、Policy、Strategy 或 Thesis 领域。当前不建设 OMS、自动交易、复杂 AI Memory、Vector DB 或完整资产负债表。

```text
用户问题
   ↓
Context Service
   ├── Knowledge（仅当前 Revision）
   ├── Feed（按问题需要的近期信息）
   └── Trading（按问题需要的持仓与行情快照）
   ↓
单 Agent Runtime / Worker（已实现）
   ↓
AiRun + AiRunContextRef
```

`POST /api/v1/context` 提供受设备授权保护的上下文组装，供已实现的 Agent Worker 和问答界面使用；它本身不调用模型，也不伪造回答。V10 增加 `ai_run_context_refs`，用于在实际 AI Run 写入时固定本次读取的资源、知识版本和快照时间。V11 增加 `feed_item_translations`，信息流译文按条目 ID 与正文哈希持久化，电脑和手机读同一份。V12 增加 `ai_sessions`，以及 `ai_runs.session_id` / `input_text`，把问答和灵感加工收成可回溯、可继续的 AI 记录。V13 把灵感归档收口到 Knowledge Document，并回填缺失的 Revision / FTS，避免知识库页面看得到但 `knowledge.search` 搜不到。V14 把旧问答的提问从 Job 输入回填到 `ai_runs.input_text`。V15 为 `ai_run_context_refs` 增加 `origin` / `label`，用户主动引用由 Context Service `resolveReferences()` 在进入 Agent 前确定性读取，不占用 Tool Call。V16 在 Knowledge 域增加多维 Taxonomy 与 Structured Artifact 回填：`inspiration.from-run` / `knowledge.from-run` 由 Worker 编译后写入灵感或知识正文，并挂分类与来源。V17 增加跨域粗筛 `resource_taggings`：对文本打预定义 tag，信息流只是其中一个调用方。V18 为灵感增加外部来源 URL、来源标题、采集入口和来源应用字段。V19 增加离线同步幂等键和原始采集时间。V20 为旧发布内容增加 `posts.hidden_at`，支持保留记录同时从默认信息流隐藏。

领域表边界见 `docs/product-v2.md`。冻结后的模块规则见
`docs/architecture-modules-v1.md`，可执行契约见 `packages/contracts`。
`docs/plan/stage-2.md` 只保留为历史拆分，不驱动当前开发。

## 推荐目录

```text
AI-Center/
  apps/
    web/                 网页、API、配对和 SSE
    worker/              抓取、行情刷新、AI 后台任务
    harmony/             ArkTS Stage + ArkWeb 薄壳
packages/
  instance/            Instance 路径与 .env 解析；不保存个人数据
  contracts/           请求、响应和事件契约
  source/              外部读取能力、SourceHub 与 Human/AI Projection
  domain/              领域服务和端口；不依赖 Web、Worker 或 Connector
    database/            SQLite schema、版本化迁移和分域 Repository
    runtime/             任务领取、重试和生命周期
    connectors/          外部进程与本机 HTTP 适配器；BrowserRuntime 只放这里
  knowledge/             给 Agent 用的稳定 Markdown 认知（framework / concept），不是聊天记录
  data/
    ai-center.db
    blobs/captures/      原始 JSON、字幕
    imports/             本地导入文件，例如个人资产工作簿
  docs/
```

## 运行边界

- 对手机开放的只有 Web/API 端口；公网模式只通过精确 Hostname 的出站 Tunnel 开放该端口。
- SQLite 文件不通过网络共享。
- Codex Bridge、Chrome 调试端口、转写服务、采集 Worker、Search Worker、旧 AI-Hub 仅监听回环地址。
- 鸿蒙应用不复制服务端业务数据库；只保存服务器地址、ArkWeb 设备授权，以及有界的本地灵感 Outbox/投影。服务端 SQLite 仍是同步后的权威数据源。
- API Key、Cookie 和本机路径不得返回给手机。
- 公网代理请求不得根据 Origin TCP 回环地址获得桌面管理员权限。

公网模式、一次性高熵配对和 Cloudflare Access 规则见 `docs/public-access-security.md`。

## 任务与事件

- `jobs` 是 SQLite 持久任务队列。Worker 使用 `BEGIN IMMEDIATE` 原子领取任务。
- 任务只允许执行 `packages/connectors` 显式注册的 handler。
- 外部进程使用 `spawn(..., shell: false)`，并要求 stdout 为单个 JSON 对象。
- 业务变更与 `outbox_events` 同事务写入。
- Web 每 250ms 转发新事件，SSE 帧携带递增 ID；客户端用 `Last-Event-ID` 分页补回断线期间的事件。超过补发窗口时 `ready` 携带 `snapshotRequired`，页面再拉 REST 快照并对齐水位。
- `provider_health` 保存 Worker、浏览器采集和未来连接器的最近成功、失败及检查时间。

本地运行使用 `start-ai-center.bat`（Web + Worker + 可选 Search）。双击后进入独立 PowerShell 窗口；`Ctrl+C` 停止全部进程后按 Enter 即可在同一目录再拉起，不必再点 bat。也可以两个终端：`npm start` 和 `npm run start:worker`。Search 第一次需执行 `scripts/setup-searxng.ps1`；启动器按命令行识别 `.ai-data\searxng` + `searx.webapp`，不按 `python.exe` 批量结束进程。

启动器只停止当前 Instance `runtime/processes.json`（旧布局为 `.ai-data/processes.json`）中记录且入口与启动时间都匹配的 Web / Worker PID。它不会扫描或终止其他 AI Center Instance；端口被占用时只报告冲突。未显式传 `-Port` 时读取当前 Instance `.env`。BrowserSkill 与 SearXNG 使用 Host 级 `.ai-data`，可由启动器探活或拉起，但不写入 Instance PID 状态，也不随 Instance 退出。非旧 local 布局的设备 Cookie 使用可读 instanceId 加 instanceId / canonical instanceRoot 短哈希，避免不同端口实例共享 Cookie key。

## 鸿蒙端策略

Stage + ArkWeb 薄壳已经位于 `apps/harmony`：加载同一套网页，Preferences 保存服务器地址，ArkWeb 保存 HttpOnly 授权 Cookie，并提供 Scan Kit 原生扫码、启动时对 `/api/v1/health` 短超时探活、失败后保留已保存地址、失效地址仅在用户主动退出时清除，以及网页返回栈。不重写信息流 UI。

系统文本/链接分享使用 `ShareExtensionAbility` 的原生详情页：`systemShare.getSharedData()` 读取 `SharedRecord.content`，用户确认后先写入有界的本地灵感 RDB Outbox。主应用也提供原生本地灵感页，未配对或离线时仍可直接输入、查看和删除。ShareExtension 与主应用每次进入都重新查询同一 RDB，不使用不支持多进程一致性的 XML Preferences 保存业务记录。ArkWeb 恢复已授权连接后，通过 `AICenterShell` 桥接读取待办项并调用现有 `POST /api/v1/notes`；原生层不读取或复制 HttpOnly Cookie。同步是手机到服务端的单向投递：服务端用 `clientMutationId` 幂等去重，手机删除不调用服务端 DELETE，服务端列表也不回写本地。详细字段和真机验收见 `docs/harmony-share-to-inspiration.md`。

配对 API 同时产生 HTTP 二维码和 `aicenter://pair` App 深链二维码。当前电脑页面展示的 HTTP 码是通用码：鸿蒙 App 内扫码和手机系统相机都可识别；App 只接受带短期配对参数的 AI Center 地址，不打开任意二维码。

DevEco Studio、签名和真机安装是用户执行步骤。

## 旧能力接入方式

```text
旧平台实现 -> Adapter -> AI Center 契约 -> SQLite / blobs
```

页面和数据库不依赖旧字段。替换 Adapter 时，前端契约保持不变。

## Source 读取层

外部读取统一经过 `SourceHub.read(sourceId, input)`。Module Registry 同时接收 `sources` 与
`jobHandlers`，因此新增来源只增加 Adapter、Source Definition 和一次模块注册，不再修改
Domain / Route / Tool Registry。Source Definition 必须声明自己的 input/output Zod Schema；
SourceHub 在 reader 前后分别校验，并产生带 `sourceId`、`providerId`、`observedAt`、status 和 warnings
的 `SourceSnapshot`。

当前迁入 `market.*`、`content.x.home`、`content.bilibili.import` 与 `search.web`。旧 `/api/v1/markets`、
`/api/v1/feed/*` 仍是兼容接口；统一读取接口是 `GET /api/v1/sources` 与
`GET /api/v1/sources/:id`。`SourceAccount` 仍只属于 Feed 的账号/频道持久化生命周期，不能用来保存行情来源。
SearXNG Connector 通过 `search.web` Source Definition 接入；Agent Tool `web.search` 只消费 SourcePort，
继续保留原 Tool ID、结果投影、网页证据校验与不可用降级行为。

模块通过 capability manifest、显式 job handler 和领域端口接入。跨领域协作使用带版本事件或独立关系表，
禁止由一个模块直接修改另一个模块拥有的数据表。
