# 架构

当前产品版本是 **0.2.0 基线候选**。当前问题与验收见 `docs/release-readiness.md`。
下文「第一版兼容层」是仍在运行的连接闭环，不是当前工作范围。

单 Agent / Worker 已经接入；不要再写成「AI Worker 后续接入」。不另建 Intent Router、多 Agent 或新的数据库体系。Ask Agent 冻结为 **Single Agent + Runtime Guardrails + Jev Quality Observer**，见 `docs/architecture-agent-v1.md`。Jev 给置信与质量信号，不指挥 Agent 想什么；Evidence Gate 可在检索结果进入 Context 前过滤，失败则放行。生产执行器是冻结的 DeepSeek Harness（`dsh-base` 0.1.6-alpha.2 / commit `ddefc45`）：Ask 与文章阅读都走 `dsh --profile sdk`，Domain Tool 仍经 Tool Gateway 执行。主模型只走 Harness LLM：`AI_CENTER_HARNESS_PROVIDER` 在 `deepseek-official` 与 `elucid-grok` 之间二选一。`$DSH_HOME/settings.yaml` 同时写入 `llm-deepseek` 与 `llm-pi-ai`。Ask、文章阅读、内置 web 和结构整理共用这一套，不再用 `AI_CENTER_AGENT_PROVIDER`。`elucid-grok` 时 `web_search` 走 Grok 原生搜索，`web_fetch` 仍是 HTTP。本地 `AgentRuntime` 只留给测试注入 fake LLM，或显式 `AI_CENTER_AGENT_RUNTIME=local`。公网已配对设备使用 Domain Tool 问答；改代码、Shell、工作包派发属于 Host 作用，只允许本机 `desktop-host`，见 `docs/public-access-security.md`。文章阅读是 **Article Analysis Skill**（Job `ai.article.analyze`）：同一套执行器上的明确调用，只换阅读框架和 Domain Tool 可见范围，见 `docs/search-agent-v1.md`。不进入普通问答 Job，也不另建 Tool Loop。资料搜索等专用能力以后做成 Harness 插件，当前不要另起执行器。

## Single-user Instance 边界

当前仍只保证一个人的 AI Center 完整可用，但 Core、个人 Instance 与机器级 Host Service 不再混放：

```text
AI Center Core                 AI Center Instance              Host Services
代码 / Domain / Contract      data / knowledge / config       BrowserSkill daemon
Runtime / Connector / UI      imports / runtime / .env        BrowserSkill / 可选 cloudflared
```

- Core 只定义能力、业务规则和数据契约，不包含某个人的持仓、账户 ID、观察池、Tag、Taxonomy、知识或浏览器登录态。
- Instance 是可替换的个人状态根。`packages/instance` 统一解析 Web、Worker 和脚本使用的路径；当前不建设 User、Tenant、Membership 或 Instance Manager。
- Host Service 是机器级可复用基础设施。BrowserSkill daemon 与可选的 `cloudflared` 公网隧道不归某个 Instance 所有，也不随单个 Instance 停止。`cloudflared` 只允许把精确 Hostname 转到 `http://127.0.0.1:8787`。本机已有 token 或 `config.yml` 时，启动器可以探活或拉起，但不写入 Instance PID，Ctrl+C 也不停止隧道。本机 SearXNG 脚本仍保留，但不再是 `search.web` 的默认 Provider。
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
              | HTTP（同一局域网）或可选 Cloudflare Tunnel HTTPS
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
后台 Worker（Node）
 ┌──────┴──────────────┐
 ▼                     ▼
旧 AI Skills Adapter   行情 Adapter
B站 / X / 字幕          雪球 / 同花顺 / Yahoo
```

关键变化：

- Web 只负责页面、API、配对和读取结果。
- 独立本地 Worker 负责定时抓取、重试、字幕和 AI 加工。
- `search.web` 的 DeepSeek Native Search Connector、Domain `web.search` 和豆包补充检索只留给显式 `AI_CENTER_AGENT_RUNTIME=local`。生产 Ask / 文章阅读的公开互联网是 Harness 内置 `web_search` / `web_fetch`。缺 Key 时本地回退把 `search.web` 标成 `available: false`，不回退 Bing / DDG / SearXNG。本机 SearXNG Connector 仍保留为 legacy，主链路不调用。
- `closedContext: true` 用于封闭材料任务（例如 Daily Brief）。这一轮 Domain Tool、Harness 原生网页工具和 Host 工具都不可执行。Ask 与文章阅读不使用这个模式。
- 旧仓库继续运行，通过配置路径或本机 HTTP 调用，不立即迁移代码。
- 只有 AI Center 的 Web 端口对手机开放；旧服务和浏览器调试端口只监听本机。
- 用正式 `schema_migrations` 替代单纯的 `CREATE TABLE IF NOT EXISTS`。
- Worker 写入 `jobs` 与 `outbox_events`。只回收租约已过期的 `running` 任务（启动一次 + 周期回收），不在启动时重置全部运行中任务。`complete` / `fail` 必须匹配当前 worker 与 attempt。SSE 按 `Last-Event-ID` 分页补发，超过窗口时 `ready.snapshotRequired`。
- 新业务数据带 `workspace_id`；P0 只有默认用户。

当前实现已经完成上述进程与数据骨架。B站链接抓取已注册 `feed.bilibili.sync`，通过 Connector 内部 `BrowserRuntime`（`bsk` / BrowserSkill）只取 AI 中文字幕并写入 Capture / ContentItem。Yahoo 行情（美股/亚洲/国际期货/汇率）走公开 HTTP。沪深股票、场内 ETF、B 股和港股通优先走雪球 `batch/quote.json`；国内国债与商品主连走新浪公开期货行情；同花顺 A 股/基金快照只作缺票回退。X 首页已登录时间线已通过同一 BrowserRuntime 接入。Web / Worker 的自动翻译和粗筛 Tag 都走 Gemini `generateContent`。翻译缺 Key 时回退 DeepL / Google。后续本地任务包交给 Cursor；每条先建 hashId 步骤目录，CLI 用 JSONL 记每一步。页面只消费 `lastPrice` / `previousClose` 和统一 FeedItem，不暴露供应商字段。雪球与同花顺都已有适配代码，真实延迟与覆盖见发布门槛，不要写成「尚未接入」。

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

`POST /api/v1/context` 提供受设备授权保护的上下文组装，供已实现的 Agent Worker 和问答界面使用；它本身不调用模型，也不伪造回答。`POST /api/v1/context/pack` 把同一组用户引用打成 Markdown 材料包，供导出或带去任务，不新增领域。V10 增加 `ai_run_context_refs`，用于在实际 AI Run 写入时固定本次读取的资源、知识版本和快照时间。V11 增加 `feed_item_translations`，信息流译文按条目 ID 与正文哈希持久化，电脑和手机读同一份。V12 增加 `ai_sessions`，以及 `ai_runs.session_id` / `input_text`，把问答和灵感加工收成可回溯、可继续的 AI 记录。V13 把灵感归档收口到 Knowledge Document，并回填缺失的 Revision / FTS，避免知识库页面看得到但 `knowledge.search` 搜不到。V14 把旧问答的提问从 Job 输入回填到 `ai_runs.input_text`。V15 为 `ai_run_context_refs` 增加 `origin` / `label`，用户主动引用由 Context Service `resolveReferences()` 在进入 Agent 前确定性读取，不占用 Tool Call。V16 在 Knowledge 域增加多维 Taxonomy 与 Structured Artifact 回填：`inspiration.from-run` / `knowledge.from-run` 由 Worker 编译后写入灵感或知识正文，并挂分类与来源。V17 增加跨域粗筛 `resource_taggings`：对文本打预定义 tag，信息流只是其中一个调用方。V18 为灵感增加外部来源 URL、来源标题、采集入口和来源应用字段。V19 增加离线同步幂等键和原始采集时间。V20 为旧发布内容增加 `posts.hidden_at`，支持保留记录同时从默认信息流隐藏。V21 为灵感增加 `work_packages`。V22 增加 `cursor_agent_id` / `cursor_run_id` / `dispatch_job_id`：`notify` 入队 Worker，拉起本机 `agent -p` CLI，做完退出；同一 Worker 默认同时最多 3 个任务包 CLI，问答 Agent 仍一次一条。需要弹进程时由 Worker 在 CLI 退出后写 Instance `runtime/restart.request`，启动器只重启 Web/Worker。Web/Worker 自己退出时同样弹回，不拆 Host 隧道。`POST /api/v1/runtime/restart` 与工作包派发只允许本机 `desktop-host`。公网 Hostname 仍只映射 Web 端口。V23 增加 `feed_identity_fingerprints`：按作者与正文生成稳定 hash，推文正文按保留期清掉后仍能去重和记住左滑删除。V24 为工作包增加 `parent_work_package_id`：详情里继续做时另开新 session，正文带上旧指令。V25 增加 `attachments` / `resource_attachments`：图片落在 `data/blobs/attachments/`，页面只看到 `/api/v1/attachments/:id/content`，Worker 把相对路径解析成本机绝对路径后交给 Cursor CLI `--image`。V26 增加个人资产账本：类型、账户、期间快照与分红导入行；工作簿只作导入。V27 去掉快照期间标签唯一约束，允许同月多次记录；投资类加总含券商现金，分红榜不再导入或展示。V28 增加 `agent_run_events`：把 Harness Session 通知与 Tool Gateway 结果写成脱敏、可跨进程查询的应用层进度投影，并通过 Outbox/SSE 通知页面。

领域表边界见 `docs/product-v2.md`。冻结后的模块规则见
`docs/architecture-modules-v1.md`，Ask Agent 职责见
`docs/architecture-agent-v1.md`，可执行契约见 `packages/contracts`。
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
    runtime/             任务领取、重试、Job；本地 AgentRuntime 仅测试/回退
    harness/             生产 Agent 执行器（dsh-base profile + Tool Gateway）
    connectors/          外部进程与本机 HTTP 适配器；BrowserRuntime 只放这里
  knowledge/             给 Agent 用的稳定 Markdown 认知（framework / concept），不是聊天记录
  data/
    ai-center.db
    blobs/captures/      原始 JSON、字幕
    blobs/attachments/   灵感/任务图片，数据库只存相对路径
    imports/             本地导入文件，例如个人资产工作簿
  docs/
```

## 运行边界

- 对手机开放的只有 Web/API 端口；公网模式只通过精确 Hostname 的出站 Tunnel 开放该端口。
- SQLite 文件不通过网络共享。
- Codex Bridge、Chrome 调试端口、转写服务、采集 Worker、旧 AI-Hub，以及仍在运行的本机 SearXNG，仅监听回环地址。
- 鸿蒙应用不复制服务端业务数据库；只保存服务器地址、ArkWeb 设备授权，以及有界的本地灵感 Outbox/投影。服务端 SQLite 仍是同步后的权威数据源。
- API Key、Cookie 和本机路径不得返回给手机。
- 公网代理请求不得根据 Origin TCP 回环地址获得桌面管理员权限。
- 已配对只表示可以使用这个 Instance。改仓库、Shell、写盘、subagent、派发工作包和手动重启进程属于 Host 作用，只允许本机 `desktop-host`。公网 Ask 不得复用带这些工具的 Harness Session。

公网模式、一次性高熵配对、Cloudflare Access，以及 Agent / Host 能力平面见 `docs/public-access-security.md`。

## 任务与事件

- `jobs` 是 SQLite 持久任务队列。Worker 使用 `BEGIN IMMEDIATE` 原子领取任务。
- `job_schedules` 是 Runtime 上的薄调度层，只决定何时创建已经注册的 Job。第一版支持 `daily` 与 `interval`，不解析 Cron 表达式。到期入队和推进 `next_run_at` 在同一个 SQLite 事务里完成；停机后的补跑只保留最近一次（latest-only）。Scheduler 与 JobRunner 并列，Scheduler 不执行 Handler。`strategy.cn-dividend.snapshot` 在上海时间 15:30 生成中证红利策略快照；08:00 日报只读取此前已经落库的快照。
- 任务只允许执行 Worker 显式注册的 handler。调度不能指定 shell、文件路径或任意 handler。
- 手工重跑日报只创建固定的 `report.daily.generate`，并且只在本机桌面开放。
- 外部进程使用 `spawn(..., shell: false)`，并要求 stdout 为单个 JSON 对象。
- 业务变更与 `outbox_events` 同事务写入。
- Web 每 250ms 转发新事件，SSE 帧携带递增 ID；客户端用 `Last-Event-ID` 分页补回断线期间的事件。超过补发窗口时 `ready` 携带 `snapshotRequired`，页面再拉 REST 快照并对齐水位。
- `provider_health` 保存 Worker、浏览器采集和未来连接器的最近成功、失败及检查时间。

本地运行使用 `start-ai-center.bat`（Web + Worker + 可选 Search / 公网隧道）。双击后进入独立 PowerShell 窗口；`Ctrl+C` 停止 Web / Worker 后按 Enter 即可在同一目录再拉起，不必再点 bat。Search、Browser 与公网隧道作为 Host 继续运行。也可以两个终端：`npm start` 和 `npm run start:worker`。Search 第一次需执行 `scripts/setup-searxng.ps1`；启动器按命令行识别 `.ai-data\searxng` + `searx.webapp`，不按 `python.exe` 批量结束进程。

启动器只停止当前 Instance `runtime/processes.json`（旧布局为 `.ai-data/processes.json`）中记录且入口与启动时间都匹配的 Web / Worker PID。它不会扫描或终止其他 AI Center Instance；端口被占用时只报告冲突。未显式传 `-Port` 时读取当前 Instance `.env`。BrowserSkill 与可选 `cloudflared` 使用 Host 级 `.ai-data`，可由启动器探活或拉起，但不写入 Instance PID 状态，也不随 Instance 退出。`cloudflared` 运行时目录为 `.ai-data/cloudflare/`。本机 SearXNG 仍可由启动器探活，但不参与 `search.web`。非旧 local 布局的设备 Cookie 使用可读 instanceId 加 instanceId / canonical instanceRoot 短哈希，避免不同端口实例共享 Cookie key。

## 鸿蒙端策略

Stage + ArkWeb 薄壳已经位于 `apps/harmony`：加载同一套网页，Preferences 保存服务器地址，ArkWeb 保存 HttpOnly 授权 Cookie，并提供 Scan Kit 原生扫码、启动时对 `/api/v1/health` 短超时探活、失败后保留已保存地址、失效地址仅在用户主动退出时清除，以及网页返回栈。不重写信息流 UI。健康检查带当前 `uiRevision`；薄壳把该指纹写进页面 URL，避免 ArkWeb 继续吃旧的 JS/CSS。`GET /api/v1/ui/revision` 对未配对设备公开，只返回指纹，不含主机名。每次打开页面先跑不缓存的 `ui-boot.js` 核对指纹；不一致时先等指纹连续几次相同，再整页换成新 HTML/CSS/JS，避免一次改多个 public 文件连刷三四次。SSE `ready`、初始化与刷新按钮共用同一条「稳定后再重载」路径；长按仍立即强制重载。本机重启后客户端重连即可热更新。

系统文本/链接分享使用 `ShareExtensionAbility` 的原生详情页：`systemShare.getSharedData()` 读取 `SharedRecord.content`，用户确认后先写入有界的本地灵感 RDB Outbox。主应用也提供原生本地灵感页，未配对或离线时仍可直接输入、查看和删除。ShareExtension 与主应用每次进入都重新查询同一 RDB，不使用不支持多进程一致性的 XML Preferences 保存业务记录。ArkWeb 恢复已授权连接后，通过 `AICenterShell` 桥接读取待办项并调用现有 `POST /api/v1/notes`；原生层不读取或复制 HttpOnly Cookie。同步是手机到服务端的单向投递：服务端用 `clientMutationId` 幂等去重，手机删除不调用服务端 DELETE，服务端列表也不回写本地。详细字段和真机验收见 `docs/harmony-share-to-inspiration.md`。

配对 API 同时产生 HTTP 二维码和 `aicenter://pair` App 深链二维码。当前电脑页面展示的 HTTP 码是通用码：鸿蒙 App 内扫码和手机系统相机都可识别；App 只接受带短期配对参数的 AI Center 地址，不打开任意二维码。Instance 也可配置共享账号密码，作为未配对页面的第二入口；登录后只签发设备授权，不创建 User，也不能获得桌面管理员身份。

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

当前迁入 `market.*`、`content.x.home`、`content.xueqiu.home`、`content.bilibili.import`、`content.trendforce.public`，以及只读的
`calendar.*` / `policy.*` 静态信号源。`search.web` 只在本地循环回退时注册。后两类统一投影为 `ScheduledEvent` / `OfficialRelease`：
只记录官方已公开的时间、文件和事件，不包含 importance、forecast、consensus、impact 或多空判断。
按公开固定规则生成而非逐日列在官网日历上的条目必须标记 `scheduleBasis=official-rule` 与
`status=tentative`，不能伪装成已确认日程。旧 `/api/v1/markets`、
`/api/v1/feed/*` 仍是兼容接口；统一读取接口是 `GET /api/v1/sources` 与
`GET /api/v1/sources/:id`。总览通过 `packages/source/src/static/board.js` 并发读取这些低层 Source，
确定性完成 merge、dedupe、sort 和静态关注目录投影，输出 `StaticSignalBoard`；该层不调用 AI、
不新增 Domain，也不持久化 Snapshot。FOMC 专门日程优先于 Fed 综合日历；政策发布先按同 URL，
再按同机构、同标题、同发布日去重，不合并 White House 公告与后续 Federal Register 正式刊登。
对应只读接口是 `GET /api/v1/static-signals/board`。`SourceAccount` 仍只属于 Feed 的账号/频道持久化生命周期，不能用来保存行情来源。
K 线是慢数据：`market_history_cache` 按标的、区间和周期留下最近一次成功的 OHLCV，六小时内再次打开直接读这份记录，不按定时器去打上游。用户显式刷新才绕过。最新价仍走原来的短缓存，不放进这份表。
DeepSeek Search Connector 通过 `search.web` Source Definition 接入，只留给本地循环回退；生产 Ask 不注册该 Source。本地 Agent Tool `web.search` 只消费 SourcePort。Connector 只映射结构化 `web_search_result`（title / url / snippet / publishedAt），不把 DeepSeek 生成的答案交给模型。

静态 Signal Layer 的另一半是 `market-native.*` 只读来源，当前注册 Polymarket、Kalshi、Hyperliquid
与 DefiLlama。它们分别输出独立场所的事件报价、BTC/ETH 永续原始状态和稳定币供给；不把不同场所
合成为“真实概率”，也不推导开盘方向。事件报价保留 venue，Hyperliquid OI 明确以 base asset 为单位，
稳定币只做当前供给及 1d/7d/30d 的确定性差额。Market-native Board 与官方 Calendar / Release Board
使用不同 Contract 和 API，单源失败只降级自己的 health，不影响原有官方事实。

模块通过 capability manifest、显式 job handler 和领域端口接入。跨领域协作使用带版本事件或独立关系表，
禁止由一个模块直接修改另一个模块拥有的数据表。
