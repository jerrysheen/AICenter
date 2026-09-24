# 数据契约 V1

可执行定义位于 `packages/contracts/src`。本文档解释不应只靠字段名猜测的语义。

## 通用约定

- ID：稳定字符串。内部新记录默认 UUID；`local` 等保留 ID 允许继续使用。
- 时间：数据库和进程契约统一使用 UTC 毫秒时间戳。
- 空值：未知使用 `null`；可填写但当前为空的文本使用空字符串。
- 金额、价格、数量和汇率：使用十进制定点字符串，例如 `"187.2301"`，禁止以 JSON number 作为权威值。
- 币种：大写代码，例如 `CNY`、`USD`、`USDT`。
- URL：只允许 `http` 和 `https`。
- 扩展字段：只有平台原始元数据可以进入 `metadata`；稳定业务字段必须进入正式 Contract。
- 分页：列表使用不透明 cursor；调用方不得解析 cursor 内容。

## Identity

- 当前没有 User / Tenant。设备授权是手机和远端浏览器进入业务 API 的唯一会话。
- `POST /api/v1/pair` 用一次性配对码换设备 token；`POST /api/v1/session/login` 用 Instance 共享账号换同一类设备 token。两者都写入 `devices`，服务端只存 token 哈希。长期 token 只经 HttpOnly Cookie 下发，不进入页面 JSON。
- 未配对的 `GET /api/v1/session` 返回 401，并带 `loginAvailable`。该字段只表示 Instance 是否配置了账号登录，不返回账号名。
- 账号密码只从 Instance 环境读取，不进入页面 Contract，也不写入 SQLite。

## Feed

```text
SourceAccount -> Subscription -> Capture -> ContentItem -> UserItemState
```

- `Capture` 是不可替代的来源证据，保存 provider、external ID、hash 和原始文件相对路径。`status=ignored` 的 Capture 不去建 ContentItem，只供去重与审计。
- `ContentItem` 是页面和下游 Agent 使用的标准内容。
- 信息流按 `Capture.capturedAt`（写入来源的先后）排列，不按推文 `publishedAt`。已读条目（`UserItemState.isRead`）仍保留在列表中，但排在未读之后；左滑删除只写 `isHidden`，不物理删除 Capture / ContentItem，再拉取同一条也不会回来。卡片仍显示发帖时间；相同内容去重时不刷新 `capturedAt`。同一批抓取里，时间线越靠前的条目 `capturedAt` 越大。
- `FeedIdentityFingerprint` 是作者 + 正文的稳定身份（SHA-256），与 tweet / 视频 ID 分开保存。正文可以按保留期清掉，fingerprint 继续留着：同一作者同一段文字再次投递时跳过，左滑删除后即使 Capture 已不在也不会再出现。无正文时退回 `external:{id}`，避免图文空帖互相撞车。表里只存 hash、externalId 和时间，不存推文正文。
- `FeedItemTranslation` 是信息流与抓取文本的中文投影，按条目 ID + 正文哈希落在 SQLite，不覆盖 Capture / ContentItem 原文。电脑和手机读同一份。英文或韩文在抓取入库后统一走 Gemini 批量翻译并轻度清洗（去界面残渣、不总结、不扩写）。一次最多 30 条；`id` 必须对齐。Gemini 失败或缺 Key 时回退 DeepL / Google。用户 view 只消费译文；原文继续保存在 Capture / ContentItem，经 `GET /api/v1/content-items/:id/original` 或 `GET /api/v1/feed/items/:id/original` 读取。页面 Contract 不暴露供应商。官方日程、官媒标题和预测市场问题复用同一张译文表，Source Snapshot 字段保持原文事实。
- 发给模型的信息流请求走 Domain `packFeedAiBatches`：先给每条标注字数。翻译一次最多 30 条打成一组（条目模型输入仍可截到约 5000 字）。Capture/ContentItem 仍保存全文；只有模型输入可以截断，并标记 `truncatedForModel`。粗筛 Tag 复用同一函数：`purpose=analyze`，默认每批最多 20 条 / 30k chars，单条最多 6000 字（超长取头 4500 + 尾 1500）。Tag 走 Gemini，输出仍按 `item_id` + `tags[]` 验收。
- Tag 是全局粗筛：输入一批文本，按 `item_id` 回收 `tags[]`。当前可挂 `content-item`（多标）、`inspiration`（单标）、`knowledge`（多标）。字典来自 Instance 的 `config/tags.json`，缺省模板为仓库的 `config/tags.default.json`，与 Knowledge Taxonomy 分离。结果写入 `resource_taggings`，不改 ContentItem 字段。未知 tag / 未知 item 丢弃；漏项重试；空数组是合法成功。

- 重新生成字幕、摘要或结构化结果时，不能覆盖原始 Capture。
- 平台登录、Cookie 和抓取脚本内部字段不得进入 ContentItem。

## Source

- `ProviderId` 是格式受限的稳定供应商字符串，例如 `yahoo`、`xueqiu`、`hithink`、`x`。
- `SourceId` 是点分读取能力，例如 `market.global`、`content.x.home`；不得拿 Feed 的 `SourceProvider` 枚举表示行情供应商。
- Source Manifest 公开 `category`、`viewKind`、capabilities、TTL 与 guide refs；页面按 `viewKind` 选择 Renderer，不按 Provider 分支。
- Source Definition 的 input/output 都必须运行时校验。统一输出 `SourceSnapshot`，包含来源、供应商、观测时间、状态、数据和 warnings。
- Snapshot 持久化本轮只留引用边界，不新增 `source_snapshots` 表；日报真正保存行情快照时再做新迁移。
- `calendar` 视图只输出 `ScheduledEvent`：国家、发布机构、事件类型、标题、计划时间/结束时间、参考期、状态、日程依据、时间精度、官方链接与观测时间。`scheduleBasis=official-calendar` 表示官网逐项列出；`official-rule` 表示按官方固定规则生成，此时必须使用 `status=tentative`，并保留“遇节假日顺延”等原始限定。
- `official-release` 视图只输出 `OfficialRelease`：国家、机构、文件类型、标题、发布时间、时间精度、生效时间、文号、官方链接与观测时间。
- `official-detail` 是仅供内部 AI Tool 使用的按需详情视图，输出 `OfficialSourceDetail`：是否可用、最终官方链接、官网标题、官方摘要、清洗后的限长正文、发布时间、观测时间、是否截断和客观读取说明。它不包含生成式摘要、影响判断、重要性或多空含义。
- `official.source.get` 只接受 `static.signals.list` 等可信记录携带的 HTTP(S) 官方链接；Connector 必须执行官方域名白名单、SCIO HTTP 单点例外、跳转后域名复核、原始页面与 Tool 结果大小上限。Federal Register 优先使用官方 JSON API 与 raw text，避免把访问拦截页当正文。
- `StaticSignalBoard` 只组合 `upcoming: ScheduledEvent[]`、`releases: OfficialRelease[]` 与 `sourceHealth[]`；
  `sourceHealth` 只含 Source ID、标题、类别、Snapshot 状态、观测时间和客观读取说明。首页关注范围由静态目录投影，
  不向事件添加 `importance` 字段。
- 静态信号契约不接受 `importance`、`forecast`、`consensus`、`surprise`、`impact`、`bullish` 或 `bearish`。这些属于市场预期或解释层，不得塞入来源 metadata 绕过建模。
- `prediction-market` 只保存场所原始报价事实：venue、问题、outcome、mid / bid / ask / spread、成交量、流动性、OI、到期时间和观测时间。Polymarket 与 Kalshi 的行保持分离，不生成跨场所加权或“真实概率”。
- `crypto-derivatives` 当前只投影 Hyperliquid 的 BTC / ETH mark、mid、oracle、funding、OI、24h notional volume 与昨价。`openInterestUnit=base-asset`，不得在没有价格与时间口径说明时冒充美元 OI。
- `stablecoin-liquidity` 保存美元锚定稳定币的总供给、USDT / USDC 与选定链分布；1d / 7d / 30d 字段是当前供给减去对应历史供给的 Decimal 字符串，不是涨跌判断。
- `MarketNativeBoard` 与 `StaticSignalBoard` 分开：前者聚合市场原生 Snapshot，后者只聚合官方日程和发布。任一 market-native 来源不可用时只返回对应 source health，不回填第三方推测值。

## Trading

```text
Instrument -> InstrumentAlias -> QuoteSnapshot
Portfolio -> Transaction -> PositionSnapshot
```

- `canonicalKey` 使用 `市场:交易所:代码`，例如 `US:XNAS:AAPL`、`CN:XSHG:600519`。
- Yahoo、雪球、同花顺、券商代码进入 `InstrumentAlias`。
- 目标模型：`Transaction` 是持仓变化的事实来源，`PositionSnapshot` 是可重建的投影。**当前实现仍是 `HoldingLot` 手工批次账本**，不宣称完整流水会计；不要把目标模型写成已经交付。
- `HoldingLot` 批次按 `a_share` / `hk_connect` / `b_sh` / `b_sz` 记账，`openedAt` 为空表示导入仓（开仓日未知）。港股通 `costPrice` 是券商人民币成本单价，市值才用港币现价 × `HKDCNY`；不得把人民币成本再乘一遍汇率。持仓页汇总三行：A 股（含港股通+人民币现金）、B 股沪市（美元股票+美元现金）、B 股深市（港币股票+港币现金）。页面大字是 CNY，外币只作小字；汇率不单独展示。沪深股票、场内 ETF/LOF、B 股和港股通现价优先走雪球批量行情（Yahoo 符号 `.SS` → `SH600519`，`.SZ` → `SZ300750`，港股补齐 5 位如 `0981.HK` → `00981`）。同花顺 A 股/基金快照仅作缺票回退；Yahoo 约 15 分钟延迟只作再回退。汇率仍走 Yahoo。页面 Contract 不暴露雪球或同花顺字段。`market.quotes` 的 Source TTL 为 3 秒。`moveGroups` 把波动按 A 股 / B 股拆开；首页各组「今日」等于该组持仓行 `dayPnlCny` 之和（现价对昨收，再折人民币），对齐券商「当日」；点进子页后，周 / 月仍按原持仓市值波动（含汇率）。`moves` 仍是全账户日周年对照，其中「今日」同样改走报价当日盈亏。`addedPnlCny` 是期间新开仓从开仓价到期末的波动。现金目前仍是余额快照，只计入汇兑，不把转入本金算成收益。转入本金的完整拆分要等 `Transaction` / 现金流水。`GET /api/v1/holdings?refresh=1` 跳过行情缓存并改拉更密的报价，用于核对是否实时。
- `PortfolioImport` 是外部持仓的统一输入契约。账户、持仓批次和现金必须携带稳定的数据侧 ID；金额、数量和成本继续使用 Decimal 字符串。Provider symbol 只能放入 aliases，不能替代 `canonicalKey`。重复导入按稳定 ID 合并，不删除未出现在本次输入中的现有数据。
- SQLite 中的 Portfolio / HoldingLot / Cash 是运行时唯一真源。Web / Worker 启动不读取或灌入个人 JS 持仓；旧格式只能通过显式 Legacy Importer 转换成 `PortfolioImport`。
- 新增持仓必须显式指定 `portfolioId` 并验证其属于当前 workspace；Core 只知道 board 的市场、交易所和计价币种，不知道某个 board 属于哪个个人账户。
- `PersonalAssetDashboard` 是个人资产分析页投影。运行时真源是 Trading 账本：`PersonalAssetType`（银行卡 / 现金 / 投资 / 基金 / 加密 / 公积金 / 额外资金）、`PersonalAssetAccount`（银行卡1 + 备注，不是机构名当类型）和期间 `PersonalAssetSnapshot`。`source=ledger` 表示账本；工作簿 Adapter 只产出 `PersonalAssetImport`，不再当日常真源。金额仍用十进制定点字符串；`increaseRate` 与 `cumulativeGrowthRate` 是比率，例如 `"0.1"` 表示 10%。历史点只保留导入或「记本期」的静态记录，曲线不追加「现在」。`latest` 的总资产和投资用当前值：投资类 `source=holdings` 只读，随持仓页 A 股 + B 股股票市值 + 券商现金同步；其他账户保持手改或导入的静态余额。分红榜不导入、不展示，`dividend` 保持空列表以兼容契约。页面不得依赖 Excel 列号或工作表名称。`latest.equity` / `latest.housingFund` 仍是投资类与公积金的合计别名，供大屏沿用。
- `buy`、`sell`、`split` 必须引用 Instrument。
- `cashAmount` 使用带符号十进制字符串：资金流入为正，流出为负。

V6 保留旧 REAL 列用于兼容，新增 `*_decimal` 列作为新代码的权威数据。新 Repository 只读写 Decimal 字段。

## Inspiration 与 Knowledge

- `TaxonomyCatalog` 是 Instance 分类树的配置契约：`version=1`，节点包含稳定 `key`、显示名、可选父节点、说明和排序；重复 key、缺失父节点或跨 dimension 父子关系必须拒绝。仓库的 `config/taxonomy.default.json` 只提供中立模板。V16 已写入的旧分类树属于兼容数据，不由该契约自动删除或替换。
- Inspiration 的原文与来源分开保存：`sourceType/sourceId` 表示可追溯业务来源；`sourceUrl/sourceTitle` 表示外部网页；`captureChannel` 表示 `web`、`harmony-share`、`harmony-local`、`feed`、`agent` 或 `import` 等进入入口；`sourceApp` 仅在可靠取得时保存，未知使用空字符串。
- 图片是 Knowledge 附件，不是问答 `@ref`，也不进入 `notes.body`。`POST /api/v1/attachments` 接收 base64，服务端按魔数识别 JPEG / PNG / WebP / GIF，单张不超过 8MB，最多 4 张。字节写入 `data/blobs/attachments/<id>.<ext>`，`attachments` 表只存相对路径；`resource_attachments` 把同一附件挂到 `inspiration` 或 `work-package`。页面 Contract 只有 `id / mime / originalName / byteSize / createdAt / url`，`url` 为 `/api/v1/attachments/:id/content`，不含本机盘符。创建灵感或工作包时带 `attachmentIds`；继续做若省略该字段则继承上一任务附图，显式传数组（含空数组）则按新列表。Worker 派发时把相对路径写成 prompt 提示，并把绝对路径交给 `agent -p --image`。信息不流抓图、鸿蒙分享收图仍未做。
- HarmonyOS 系统分享使用 `sourceType=external-share`、`captureChannel=harmony-share`。网页链接只允许 `http` / `https`，不得把链接、应用名或 UTD 拼进 `body` 逃避字段建模。
- 离线创建携带稳定 `clientMutationId`；服务端按 workspace + clientMutationId 幂等返回同一条 Inspiration。同步前，鸿蒙客户端还会对完整 `body + sourceUrl` 做精确匹配：服务端已存在同内容时直接关联，不再次创建。该匹配不做模糊文本推断。`capturedAt` 是用户在手机记下内容的原始时间，`createdAt` 是服务端首次落库时间。同步重试不得生成新 mutation ID，也不得用服务端时间覆盖 capturedAt。
- 鸿蒙本地灵感是设备侧单向投递箱，不是服务端镜像。手机只重放 create Outbox；本地删除不调用服务端 DELETE。同步前可读取 `GET /api/v1/notes?status=all` 做完整 `body + sourceUrl` 精确查重，但不得把快照写回本地列表。
- Agent `knowledge.search` / `knowledge.get` 同时覆盖 SQLite 知识文档与仓库 `knowledge/**/*.md` 文件框架。文件知识使用稳定语义 ID（例如 `finance.framework.tech_growth`），正文是判断结构（How to think），不写易过期事实。模型只按 id search/get，不得看到本地路径。`knowledge.search` 的 `query` / `taxonomy` / `limit` 都有 default，可以只传检索词；`taxonomy` 项必须是点分 Taxonomy key（`industry.semiconductor.memory`），不是单词或 `domain:finance`。执行边界按 Zod 拒非法入参。Harness 侧如何把这些约束告诉模型，见 `docs/architecture-modules-v1.md` 的 `toDefineToolParameters` 规则，不要为迁就模型而放宽本契约。
- Inspiration 永久保留用户原文。归档进入 Knowledge 时必须走 `KnowledgeDocument` 创建路径：同时写入 `knowledge_revisions`、`knowledge_fts` 和 `knowledge_links.derived_from`，不得只插 `knowledge_items`。
- 工作包是 Knowledge 拥有的执行状态，一对一挂 Inspiration。页面上它出现在灵感下的任务窗（`#inspire/tasks`），不进入随记列表。`POST /api/v1/work-packages` 供已配对设备（含公网）创建记录；投递当下先在 Instance `logs/work-packages/<hashId>/` 落下 `goal.json`（目标）和 `progress.json`（进展）。`POST /notify` 入队 `work-package.dispatch` 只允许本机 `desktop-host`，已配对公网设备不能派发 Cursor CLI。Worker 领取后用 `sha256(id)` 前 12 位作 `hashId`（派生字段），补写 `prompt.txt` / `meta.json`，并追加第一行 `steps.jsonl`。提示词要求 CLI 每一步再追加一行 JSON，不改已有行；追加必须 UTF-8 无 BOM，Windows 禁止 `Add-Content` / `Out-File` / `>>`。读 `steps.jsonl` 时按行先 UTF-8，无效则按 GBK，避免系统码页把步骤拆解写成乱码。`parentTrace` 若摘要含替换字符，回读父目录原文件，不改已有行。`GET /api/v1/work-packages/:id/trace` 反查 goal / progress / 步骤，并投影 `timeline`（`AgentRunProgressStep[]`，与问答进度同形）。详情页打开且状态为 open/claimed 时，按 `progress.updatedAt` 与步骤轮询该接口刷新，不另发明细 SSE。执行记录用与问答相同的步骤列表：历史折叠、当前展开。投递框和「继续做」输入保存在页面 localStorage，刷新或重绘不得清空。一级任务列表只显示状态、主题和两句摘要；点进 `#inspire/tasks/:id` 再看正文、状态与拆解。`POST /api/v1/work-packages/:id/continue` 用新指令另建一条工作包（`parentWorkPackageId`，V24）作为新 session；是否入队派发同样只允许 `desktop-host`。Cursor CLI 是一次性进程，不能 resume 上一轮；正文按「上一任务 / 上一目标 / 上一进展 / 上一步骤 / 上一结果 / 继续指令」带上上一轮全过程，并在新目录落下 `parent-trace.json`。`GET /trace` 的 `parentTrace` 是这份快照。列表主题和详情目标只取最后一段继续指令，不把嵌套上一任务整段当标题。`setView` 当时把路由 hash 写入 `ai-center.last-location`，刷新或鸿蒙重开可回到问答会话或任务详情。Worker 拉起本机 Cursor CLI：`agent -p --force --trust --workspace <仓库> --model cursor-grok-4.6-high-fast`，Windows 弹出可见 PowerShell，做完上报后进程退出。同一 Worker 默认同行最多 3 个 `work-package.dispatch`（各开一个 Cursor CLI），可用 `AI_CENTER_WORKER_WORK_PACKAGE_CONCURRENCY` 覆盖，范围 1–8。问答 `ai.agent.run` 仍一次一条。可用 `AI_CENTER_CURSOR_MODEL` 覆盖。不把 Cursor 当带 API Key 的云端供应商。收件箱对话不实现。`claim` / `complete` / `fail` 只对本机桌面开放。`complete` 根据 `changedPaths` 判定 `restartRequired`；CLI 退出后，若需要则写 Instance `runtime/restart.request`，由启动器弹 Web/Worker，不拆隧道。`apps/web/public`、文档和测试不弹进程。`POST /api/v1/runtime/restart` 只允许本机 `desktop-host` 手动请求同一次弹进程。CLI 退出后的 `runtime/restart.request` 仍由本机启动器执行。不另开公网管理端口。Host 作用与调用方能力见 `docs/public-access-security.md`。
- `open` 只表示已投递或已派发等待，不得显示成 CLI 正在思考；只有 `claimed` 才显示运行中的动态行。历史 `steps.jsonl` 始终可回看。`POST /api/v1/work-packages/:id/retry` 不改写原任务，而是创建带 `parentWorkPackageId` 和 `parentTrace` 的新工作包并重新派发，因此失败、完成与重做记录都保留。
- 知识组织是多维 Taxonomy，不是目录树。稳定 key 形如 `industry.semiconductor.memory`；`AI` 不是单一节点。`knowledge_type` / `inspiration_type` 是内容类型，不进入分类表。
- `memory.save` 是问答里的写入工具：用户用自然语言下令后，模型整理 Structured Artifact，工具经 Domain Service 落库；禁止模型传入 `sourceRefs`，来源记当前 `ai-session`。
- AI 不得直接新建 taxonomy 节点。找不到时归最近父节点，并把 proposal 写入 `taxonomy_proposals`。
- `POST /api/v1/notes/from-run` 与 `POST /api/v1/knowledge/from-run` 入队 `inspiration.from-run` / `knowledge.from-run`，返回 `{ jobId }`，不在 HTTP 进程里等模型。
- AI 处理写入独立 `AiRun`，并归入 `AiSession`；不覆盖原文。同一会话内的多次问答按时间追加，便于回溯和继续。
- 问答进行中的页面进度来自本地 Agent trace 的压缩投影 `AgentRunProgressStep`（label / 最多 100 字的 detail），不把 Tool 原始 data 回给页面。未完成的 `ai.agent.run` 作为 `ActiveAgentRun` 出现在 `GET /api/v1/agent/runs`、会话列表的 `pendingRuns` 和会话详情 exchanges（`queued` / `running`）。Worker 一次只执行一条 Agent Job，后到的提问排队，不并行抢同一个 Runtime。
- 文章阅读使用独立输入 Contract `CreateArticleAnalysisInput`，不要复用 `CreateAgentRunInput.message`。`AiSession.kind` 为 `article-analysis`。`AiRun.taskType` 统一为 `article-analysis.reader.v1`；`output` 只保存 Markdown `outputText`（上限 40,000），不保存结构化 Artifact。News 核验若发生，必须来自真实联网 Tool Result。这是 Article Analysis Skill，不是第二个 Agent。设计见 `docs/search-agent-v1.md`。
- 用户主动引用是协议，不是独立领域：`resourceType + resourceId + revision`。当前 P0 支持 `content-item`、`post`、`inspiration`、`knowledge-revision`、`ai-run`。页面 ID（例如 `x:externalId`）不能当作 Resource ID；信息流 DTO 使用 `resourceId` 指向 `content_items.id`。同一组 refs 不只给问答：`POST /api/v1/context/pack` 把当前落库内容打成 Markdown 材料包（日期、来源链接、已有译文），页面可导出、放入任务框或继续带去问答。不新增 Pack / Bundle 领域，也不经隧道外发。
- `CreateAgentRunInput.references` 进入 Job 后，由 Context Service `resolveReferences()` 确定性读取并写入模型上下文，不走 Tool Registry。写入 `ai_run_context_refs.origin = selected`；Tool 产生的引用为 `origin = tool`。问答会话详情把这些 refs 投影为 `sourceFooter`（去重、分组、最多 24 条），页面在回答文末展示并可跳转；不解析模型正文。信息流条目优先用已落盘译文作为正文。
- `GET /api/v1/knowledge/mentions` 给问答输入框 `@` 补全：返回本地 Knowledge 文件（分析框架等）和 SQLite 知识文档，形状是 `knowledge-revision` 引用，不含文件路径。不是独立 MCP Skill 领域。
- `webMode` 在生产 Harness 上只表示 Prompt 倾向，不再隐藏联网工具：`off` / `fallback` / `always` 都有完整 `web_search` + `web_fetch`。本地循环回退仍可用 `webMode=off` 隐藏 Domain `web.search`。Domain `web.search` 经 SourcePort 读 `search.web`，只留给测试或 `AI_CENTER_AGENT_RUNTIME=local`。News 核验若发生，必须来自真实联网 Tool（Harness `web_search` / `web_fetch`，或本地 `web.search`）。
- `researchMode` 是问答的专业研究开关：`standard`（默认）走普通档；`research` 由 Domain `resolveResearchProfile` 解析为 `AgentResearchProfile`（`modelProfile` / `thinking` / `methodKeywords` / `extraToolIds`），写入 `ai.agent.run` Job input，不新增表。页面 Contract 不暴露供应商或具体模型名。`modelProfile=research` 只表示更高模型档位；Harness 映射 `AI_CENTER_HARNESS_RESEARCH_MODEL`，未配置时仍用 `AI_CENTER_HARNESS_MODEL`。`methodKeywords` 与 `extraToolIds` 是预留口，当前默认空数组；`researchOnly` 工具只有出现在 `extraToolIds` 时才暴露。不要用 `metadata` 塞研究方法。
- Agent 只读 Tag 工具：`tag.list` 读取 Catalog；`feed.tag.search` 按已落盘 Tag 查 ContentItem。`tag` 同时接受稳定 id、中文名和关键词，由 TaggingService 解析。`timeRange` 为 `all | today | yesterday | last-24h | last-48h`，由 Runtime 当前本地时区确定性计算，优先 `publishedAt`，缺失时 fallback `createdAt`。
- `POST /api/v1/notes/from-run`、`POST /api/v1/knowledge/from-run` 把 AI 回答编译为 Inspiration / Knowledge Document，来源记在 `sourceType` / `sourceId` 或 `knowledge_links.derived_from`，不把来源塞进正文。手工创建仍用 `POST /api/v1/knowledge`。
- `AiSession.kind` 区分 `question-answer` 与 `inspiration`（以及后续其他 AI 处理记录）。页面第一层列出记录，第二层打开会话。
- KnowledgeDocument 保存当前规范版本；KnowledgeRevision 保存完整历史。
- 检索结果必须返回 knowledge ID 和 revision，确保问答可以追溯来源。
- 中文全文检索使用 SQLite FTS5 trigram tokenizer。

## Runtime 与事件

- Job 保存期望执行的工作和最终状态。
- JobAttempt 保存每次 Worker 执行、worker ID、开始/结束时间和错误。
- Agent Run 的实时进度是应用层只读投影，不是第二套 Agent Session。Worker 消费 Harness `session.event` / `session.status` 与 Tool Gateway 结果后，追加脱敏事件并投影为 `AgentRunProgressStep`；每步只允许 `label`、限长 `detail`、`status`、provider-neutral `toolId` 与轮次，不保存 Tool 原文、Prompt、供应商字段或 DSH 文件路径。
- 已完成 AiRun 通过其 `sourceId=jobId` 找回同一份进度投影，问答详情可以折叠回看完整运行记录。`POST /api/v1/agent/runs/:id/retry` 复制原 Job 的产品输入并创建新 Job；原 Run、AiRun 与进度不改写。带 Tool Call 的中间 Assistant 文本不进入进度详情，避免把模型内部推理当作 CLI 输出。
- `GET /api/v1/agent/runs/:id` 组合 SQLite Job 状态与进度投影。Job 的 `queued/running/completed/failed/cancelled` 仍是生命周期真源；Harness 的 `running/idle` 只决定当前执行阶段。进度更新发出 `runtime.agent-run.progressed.v1`，供 SSE 触发客户端刷新；断线补发仍以 Outbox ID 为准。
- Harness 的持久 Session、Session Query 和 projection cache 属于执行器内部格式。页面 Contract 不返回原始 SessionEvent、Harness Session 文件、Query SQLite 路径、Cordis plugin id 或 Provider 配置。
- 新事件名称格式为 `<domain>.<aggregate>.<action>.vN`。
- `JobSchedule` 只描述何时创建 Job：`daily`（时区、小时、分钟）或 `interval`（分钟）。`nextRunAt` / `lastEnqueuedAt` 持久化。停机补跑采用 latest-only，不回补每一档。
- `DailyWindow` 是左闭右开的 `[startAt, endAt)`。`reportDate` 对应该日 cutoff 的结束时刻，起点是前一日同一 cutoff。默认时区 `Asia/Shanghai`、cutoff `08:00`，由 `AI_CENTER_DAILY_TIMEZONE` 与 `AI_CENTER_DAILY_CUTOFF` 配置。新闻归入窗口使用 `publishedAt ?? createdAt`，不用 `capturedAt`。
- `DailyReport` 是确定性快照，不含评分、情绪或买卖结论。同一 `workspaceId + reportDate` 重复生成只更新一行。行情快照记录生成时能取到的最新状态。
- `DailyBrief` 是从当天 `DailyReport` 派生的注意力筛选，不是新的事实层。候选池由程序从日报生成；模型只返回 `candidateId` 和说明。`type`、`occurredAt`、`sourceRefs` 都从候选池回填。模型输出里不存在的 `candidateId` 整份拒绝。`daily_report_briefs` 按 `workspaceId + reportId` 唯一，并保存当时的候选快照和 `sourceReportUpdatedAt`。日报手工重跑后 `updatedAt` 变化，对应 Brief 需要重新生成。Brief 不改写 DailyReport。
- `StockFactorSnapshot` / `StockStatistics` 是纯统计事实。百分位是 `0~1` 的历史位置，不是好坏分。`peTtm <= 0` 时保留原值，但估值百分位为 null。价格收益优先使用复权序列；没有复权因子时回退原始收盘价并带 `priceSeriesAdjusted=false`。计算必须带 `asOf`，不能使用之后的数据。
- `BasketStatistics` 是指数成分的聚合事实。市盈率按正盈利成分的盈利收益率加权后再取倒数，市净率按净资产收益率同样处理，股息率按权重直接加权。`StrategySnapshot` 保存 `cn.dividend.value` 的派生状态，只记录价值、回撤和数据质量，不包含分数或买卖结论。
- `schemaVersion` 描述 payload 版本；事件名后缀与其保持一致。
- `correlationId` 串联一次用户动作产生的多个任务，`causationId` 指向直接上游事件或任务。

## 模块能力

模块使用 `CapabilityManifest` 声明：

- 稳定模块 ID 和语义版本。
- 提供的 capability。
- 可以执行的 job type。

未声明任务、重复任务 handler 和不符合命名规则的模块会在注册阶段被拒绝。
