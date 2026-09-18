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

## Feed

```text
SourceAccount -> Subscription -> Capture -> ContentItem -> UserItemState
```

- `Capture` 是不可替代的来源证据，保存 provider、external ID、hash 和原始文件相对路径。
- `ContentItem` 是页面和下游 Agent 使用的标准内容。
- 信息流按 `Capture.capturedAt`（写入来源的先后）排列，不按推文 `publishedAt`。已读条目（`UserItemState.isRead`）仍保留在列表中，但排在未读之后；左滑删除只写 `isHidden`，不物理删除 Capture / ContentItem，再拉取同一条也不会回来。卡片仍显示发帖时间；相同内容去重时不刷新 `capturedAt`。同一批抓取里，时间线越靠前的条目 `capturedAt` 越大。
- `FeedItemTranslation` 是信息流与抓取文本的中文投影，按条目 ID + 正文哈希落在 SQLite，不覆盖 Capture / ContentItem 原文。电脑和手机读同一份。英文或韩文在抓取入库后统一走豆包网页 JSONL（`task=translate_feed_items`）翻译并轻度清洗（去界面残渣、不总结、不扩写）。批量一次只发一封；输出必须是 `feed_translate_output.v0.1` 且 `id` 对齐。发给豆包网页的消息走 Connector 内进程队列，一次一条。JSON 齐了立刻结束等待；豆包挂起或超时则立刻返回，由后续刷新或补翻译再试，不在同一次请求里自动重试或串 Gemini / DeepL / Google。仅当豆包已返回但格式不合格时，才回退一次 Gemini。用户 view 只消费译文；原文继续保存在 Capture / ContentItem，经 `GET /api/v1/content-items/:id/original` 或 `GET /api/v1/feed/items/:id/original` 读取。页面 Contract 不暴露供应商。官方日程、官媒标题和预测市场问题复用同一张译文表，Source Snapshot 字段保持原文事实。
- 发给模型的信息流请求走 Domain `packFeedAiBatches`：先给每条标注字数。翻译一次最多 30 条、打成一组信封（条目模型输入仍可截到约 5000 字）；不再按 5000 字拆成多次豆包会话。Capture/ContentItem 仍保存全文；只有模型输入可以截断，并标记 `truncatedForModel`。粗筛 Tag 复用同一函数：`purpose=analyze`，默认每批最多 20 条 / 30k chars，单条最多 6000 字（超长取头 4500 + 尾 1500）。一行 JSONL 是一批文本，不是一条。
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
- `PersonalAssetDashboard` 是个人资产分析页的只读投影，来自工作簿 Adapter，不是券商流水。金额仍使用十进制定点字符串；`increaseRate` 与 `cumulativeGrowthRate` 都是比率，例如 `"0.1"` 表示 10%。页面不得依赖 Excel 列号或工作表名称。
- `buy`、`sell`、`split` 必须引用 Instrument。
- `cashAmount` 使用带符号十进制字符串：资金流入为正，流出为负。

V6 保留旧 REAL 列用于兼容，新增 `*_decimal` 列作为新代码的权威数据。新 Repository 只读写 Decimal 字段。

## Inspiration 与 Knowledge

- `TaxonomyCatalog` 是 Instance 分类树的配置契约：`version=1`，节点包含稳定 `key`、显示名、可选父节点、说明和排序；重复 key、缺失父节点或跨 dimension 父子关系必须拒绝。仓库的 `config/taxonomy.default.json` 只提供中立模板。V16 已写入的旧分类树属于兼容数据，不由该契约自动删除或替换。
- Inspiration 的原文与来源分开保存：`sourceType/sourceId` 表示可追溯业务来源；`sourceUrl/sourceTitle` 表示外部网页；`captureChannel` 表示 `web`、`harmony-share`、`harmony-local`、`feed`、`agent` 或 `import` 等进入入口；`sourceApp` 仅在可靠取得时保存，未知使用空字符串。
- HarmonyOS 系统分享使用 `sourceType=external-share`、`captureChannel=harmony-share`。网页链接只允许 `http` / `https`，不得把链接、应用名或 UTD 拼进 `body` 逃避字段建模。
- 离线创建携带稳定 `clientMutationId`；服务端按 workspace + clientMutationId 幂等返回同一条 Inspiration。同步前，鸿蒙客户端还会对完整 `body + sourceUrl` 做精确匹配：服务端已存在同内容时直接关联，不再次创建。该匹配不做模糊文本推断。`capturedAt` 是用户在手机记下内容的原始时间，`createdAt` 是服务端首次落库时间。同步重试不得生成新 mutation ID，也不得用服务端时间覆盖 capturedAt。
- 鸿蒙本地灵感是设备侧单向投递箱，不是服务端镜像。手机只重放 create Outbox；本地删除不调用服务端 DELETE。同步前可读取 `GET /api/v1/notes?status=all` 做完整 `body + sourceUrl` 精确查重，但不得把快照写回本地列表。
- Agent `knowledge.search` / `knowledge.get` 同时覆盖 SQLite 知识文档与仓库 `knowledge/**/*.md` 文件框架。文件知识使用稳定语义 ID（例如 `finance.framework.tech_growth`），正文是判断结构（How to think），不写易过期事实。模型只按 id search/get，不得看到本地路径。
- Inspiration 永久保留用户原文。归档进入 Knowledge 时必须走 `KnowledgeDocument` 创建路径：同时写入 `knowledge_revisions`、`knowledge_fts` 和 `knowledge_links.derived_from`，不得只插 `knowledge_items`。
- 知识组织是多维 Taxonomy，不是目录树。稳定 key 形如 `industry.semiconductor.memory`；`AI` 不是单一节点。`knowledge_type` / `inspiration_type` 是内容类型，不进入分类表。
- `memory.save` 是问答里的写入工具：用户用自然语言下令后，模型整理 Structured Artifact，工具经 Domain Service 落库；禁止模型传入 `sourceRefs`，来源记当前 `ai-session`。
- AI 不得直接新建 taxonomy 节点。找不到时归最近父节点，并把 proposal 写入 `taxonomy_proposals`。
- `POST /api/v1/notes/from-run` 与 `POST /api/v1/knowledge/from-run` 入队 `inspiration.from-run` / `knowledge.from-run`，返回 `{ jobId }`，不在 HTTP 进程里等模型。
- AI 处理写入独立 `AiRun`，并归入 `AiSession`；不覆盖原文。同一会话内的多次问答按时间追加，便于回溯和继续。
- 问答进行中的页面进度来自本地 Agent trace 的压缩投影 `AgentRunProgressStep`（label / 最多 100 字的 detail），不把 Tool 原始 data 回给页面。未完成的 `ai.agent.run` 作为 `ActiveAgentRun` 出现在 `GET /api/v1/agent/runs`、会话列表的 `pendingRuns` 和会话详情 exchanges（`queued` / `running`）。Worker 一次只执行一条 Agent Job，后到的提问排队，不并行抢同一个 Runtime。
- 用户主动引用是协议，不是独立领域：`resourceType + resourceId + revision`。当前 P0 支持 `content-item`、`post`、`inspiration`、`knowledge-revision`、`ai-run`。页面 ID（例如 `x:externalId`）不能当作 Resource ID；信息流 DTO 使用 `resourceId` 指向 `content_items.id`。
- `CreateAgentRunInput.references` 进入 Job 后，由 Context Service `resolveReferences()` 确定性读取并写入模型上下文，不走 Tool Registry。写入 `ai_run_context_refs.origin = selected`；Tool 产生的引用为 `origin = tool`。问答会话详情把这些 refs 投影为 `sourceFooter`（去重、分组、最多 24 条），页面在回答文末展示并可跳转；不解析模型正文。
- `GET /api/v1/knowledge/mentions` 给问答输入框 `@` 补全：返回本地 Knowledge 文件（分析框架等）和 SQLite 知识文档，形状是 `knowledge-revision` 引用，不含文件路径。不是独立 MCP Skill 领域。
- `webMode` 控制 `web.search` 是否暴露给模型，以及 System Prompt 中的使用倾向：`off` 不暴露该工具；`fallback` 暴露，并提示优先本地来源、本地不足或确需公开互联网事实时再用 Web；`always` 同样暴露，并提示用户允许在有帮助时使用 Web，但 Web 仍是普通 Tool，不是必须调用。以后若收成「不联网 / 允许联网」两档，`fallback` 可作兼容 alias。该 Tool 通过 SourcePort 读取 `search.web`；`refs.resourceType` 保持 `web-result`，`resourceId` 为结果 URL（截断到契约长度），不持久化搜索原文。结果投影保留 `publishedAt`（引擎未提供则为 `null`）。
- Agent 只读 Tag 工具：`tag.list` 读取 Catalog；`feed.tag.search` 按已落盘 Tag 查 ContentItem。`tag` 同时接受稳定 id、中文名和关键词，由 TaggingService 解析。`timeRange` 为 `all | today | yesterday | last-24h | last-48h`，由 Runtime 当前本地时区确定性计算，优先 `publishedAt`，缺失时 fallback `createdAt`。
- `POST /api/v1/notes/from-run`、`POST /api/v1/knowledge/from-run` 把 AI 回答编译为 Inspiration / Knowledge Document，来源记在 `sourceType` / `sourceId` 或 `knowledge_links.derived_from`，不把来源塞进正文。手工创建仍用 `POST /api/v1/knowledge`。
- `AiSession.kind` 区分 `question-answer` 与 `inspiration`（以及后续其他 AI 处理记录）。页面第一层列出记录，第二层打开会话。
- KnowledgeDocument 保存当前规范版本；KnowledgeRevision 保存完整历史。
- 检索结果必须返回 knowledge ID 和 revision，确保问答可以追溯来源。
- 中文全文检索使用 SQLite FTS5 trigram tokenizer。

## Runtime 与事件

- Job 保存期望执行的工作和最终状态。
- JobAttempt 保存每次 Worker 执行、worker ID、开始/结束时间和错误。
- 新事件名称格式为 `<domain>.<aggregate>.<action>.vN`。
- `schemaVersion` 描述 payload 版本；事件名后缀与其保持一致。
- `correlationId` 串联一次用户动作产生的多个任务，`causationId` 指向直接上游事件或任务。

## 模块能力

模块使用 `CapabilityManifest` 声明：

- 稳定模块 ID 和语义版本。
- 提供的 capability。
- 可以执行的 job type。

未声明任务、重复任务 handler 和不符合命名规则的模块会在注册阶段被拒绝。
