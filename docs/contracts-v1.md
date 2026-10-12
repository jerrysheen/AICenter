# 数据契约 V1

用户授权五账号原文翻译：内部 `WorkerJobConcurrencySchema.translationLimit` 为 1—5、默认 1，Worker composition root 默认启用 5，仅影响已注册 `feed.translation.run`；HTTP 入参不能设置并发或凭据。详见 `gemma-original-translation.md`。

原文翻译异步化：`FeedTranslationJobInputSchema` 校验 workspace、目标语言、1—30 个唯一 ID/正文项目；拒绝额外命令字段。`POST /api/v1/translate` 与 `/translate/batch` 返回 202/jobId，`GET /api/v1/translate/jobs/:id` 返回同 workspace/type 的状态和完成结果，页面已适配；其他旧客户端需要适配。详见 `gemma-original-translation.md`。

简报读取使用`TreeManifestQuerySchema`校验七日窗口。不带`view`仍是完整响应；`view=reading`保持上一版的信息身份投影加完整刊期，供旧客户端使用一个版本。`view=index`是简报首屏目录：刊期只有编号、层级、窗口、状态、生成时间、根模块数量和是否已有研究稿，默认不含信息节点；`information=1`才附带信息节点的身份、时间与校验版本。`TreeIndexEditionSchema`和`TreeIndexInformationSchema`逐行校验这份目录，不接受正文、`inputIds`、`pendingIds`或`roots`。不合规的旧行被丢掉并记一条警告，不让整份目录失败。`/reports/tree/edition`使用`TreeNodeQuerySchema`校验不可变刊期ID，返回该刊期与全部根模块，未知或跨workspace版本404，不触发生成。读取与客户端缓存边界见`information-tree-v3.md`。

三层浓缩树见`information-tree-v3.md`和`packages/contracts/src/information-tree.js`：统一协议在Contract的treeResponseProtocol定义，模型完成返回单篇title/text/tagId或模块及inputIds，缺内容只返回status:needs_content。宿主先识别状态，再校验完成响应；无害额外字段丢弃并记录，非法归属仍拒绝。宿主生成不可变节点ID、版本、children和去重文章篇数；小时只连信息、日报只连小时，同一期每个可用输入恰好一个父模块。主Tag以人工锁定或信息主旨为准，旧多标签仅提示；版本化阅读映射只改变上层分组。待补保存原因、可重试性和冷却时间；发布与最近尝试分开，页面不暴露供应商字段。

研究召回见 `packages/contracts/src/research-recall.js`。研究 Tag 必须带定义、命中边界和排除边界；研究问题引用这些 Tag，并带 query、回看范围和证据要求。内容哈希识别定义变化，版本字符串本身不构成新发布。判断结果是直接相关、背景线索、不相关或材料不足；待处理和失败不是不相关。已发布研究报告按 id 冻结。页面不增加供应商字段。生产开关默认关闭。

模型用量见 `model-usage-v1.md`：`ModelUsageRecord` 严格校验 Runtime 内部索引，区分 request 与官方 turn 汇总；所有缺失桶/供应商金额用 null。`ModelUsageView` 移除供应商路由与私有日志格式/路径，返回中立执行身份、业务阶段和独立版本费率估算。`ModelUsageQuery` 校验按 Job 分页，本机读取不得执行模型调用、导入或修复任务。

硬件报价以独立结构化 Contract 保存完整规格、类型、Decimal 数值、币种/单位/报价期、来源更新时间与采集时间；未知字段为 null。报告简介是内容种类，summary_only 是完整度，两者独立。报价高低不表示股票 OHLC。兼容与去重规则见 `hardware-prices-v1.md`。

硬件行情行的 `history` 是真实报价期的最新修订均价序列（`at / period / average`），不包含同期旧修订或无日期记录。当前列表只读每个来源页面最新的价表及相应序列当前值；历史解析版本、退下来的规格与旧文本快照通过精确快照／序列链接保留，不在当前行情重复混排。前端在全球行情内呈现统一的行情行与价格折线，仍与证券 OHLC 契约分开。

算力价格见 `compute-prices-v1.md`。`ComputePriceBoard` 只返回型号、每百万 token 的输入/输出价、GPU 场地、档位、小时价、样本数、报价日、相对上一报价日的涨跌，以及来源检查时间。金额是十进制字符串。页面上的出处链接由场地推导，不返回解析版本、原始响应或本机模型供应商。

可执行定义位于 `packages/contracts/src`。本文档解释不应只靠字段名猜测的语义。

`feed-quality.js`提供离线入库质量V2内部契约：六项概率必须是有限number且在[0,1]，不把null/字符串/越界值钳制成有效分；KEEP/DROP/REVIEW由Domain规则决定，原因来自代码分支。缺正文、输入截断、关键上下文缺失或评分失败必须REVIEW。概率是命题成立的判断，不是真实性、重要性或价值分数。当前不新增页面API、生产入库状态或数据库migration，完整原文/概率/输入版本仅供Host离线shadow审核。

`feed-value.js` 是当前 V3 内部契约：五项有限概率，无主题相关性；主帖、已确认续写、必要引用、普通评论分开保存。`FeedCaptureContext` 记录账号/回复关系和缺失对象、关键性、依据；已知关键缺失不得由模型低分覆盖。`FeedValueReference` 分开质量、完整性、兴趣以及主信息能否独立判断；疑似线程不等于主帖无法判断，争议与 UNKNOWN 不拟合质量阈值。校准固定版本/问题哈希/模型/样本哈希和生产资格。判定同时记录 KEEP/DROP/REVIEW 与技术/待补/语义待定类型。Capture metadata 保留判断，shadow 下 ContentItem 继续创建，Tag 后处理不回流为入库质量依据。不新增页面供应商字段或数据库 migration。

## 通用约定

最新用户选定 `FeedValueRule=all-three-0.60`：reading_value、specific_content、sufficient_information 三项全部 >=0.60；KEEP 原因 all-three，DROP 原因 below-all-three。enforce 仅 KEEP 进入 ContentItem/新闻池，REVIEW 包括技术失败只存 captured 状态的原始 Capture，不放行。旧 calibrated-value/two-of-three-0.60 保留回放兼容。Capture metadata 另记 filterMode/rule/ruleHash/filterApplied，与评分问题 policyHash 分开；切 enforce 不修改旧 calibration.productionQualified。相同模型/问题/输入可复用评分，历史回放由 Domain 校验一致性；输入变化不套旧分数，当前采集待重新评分并退出可读池。生产社交/媒体入口共用 gate；AI Tag 后处理与质量无关，无 Tag 可读。不新增 migration。

当前池刷新使用 `FeedValueRefreshInput`：workspaceId 由本机身份决定，perSourceLimit 为 1–200（默认 200），concurrency 为 1–8（默认 6），拒绝额外字段。仅本机 `POST /api/v1/feed/quality/refresh` 创建或复用同 workspace 的 `feed.quality.refresh` Job，返回 202 与 jobId；Worker 显式 handler 执行评估。Job output 记录 KEEP/DROP/REVIEW、复用/请求/预检、输入变更和缺失/无效数量，不向信息流页面增加供应商字段。入选读查询须存在当前规则明确 KEEP 与三项达标结果，未评分历史不默认为通过。

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

2026-10-05用户授权阅读语言稳定性修复：阅读会话保留当前已载入正文/译文版本，后台译文缺失或换版不得自动切到英文；译文未就绪显示段落进度，原文由用户显式选择。换版可用时主动切换，授权失效清空阅读快照。

```text
SourceAccount -> Subscription -> Capture -> ContentItem -> UserItemState
```

- `Capture` 是不可替代的来源证据，保存 provider、external ID、hash 和原始文件相对路径。`status=ignored` 的 Capture 不去建 ContentItem，只供去重与审计。
- `ContentItem` 是页面和下游 Agent 使用的标准内容。
- 信息流的阅读投影合并 X / 雪球，排除 B站；B站仍保存原 Capture / ContentItem，并通过原字幕接口供工具回看。B站工具读取允许未打 Tag 的已存字幕，隐藏状态仍生效，不增加页面字段或重写已有数据。评论仍保存在原 body，正文与评论分区只在 UI 渲染时解析。
- 信息流按 `Capture.capturedAt`（写入来源的先后）排列，不按推文 `publishedAt`。已读条目（`UserItemState.isRead`）仍保留在列表中，但排在未读之后；左滑删除只写 `isHidden`，不物理删除 Capture / ContentItem，再拉取同一条也不会回来。卡片仍显示发帖时间；相同内容去重时不刷新 `capturedAt`。同一批抓取里，时间线越靠前的条目 `capturedAt` 越大。
- X、雪球和媒体的 HTTP 列表默认 `fields=list`：只返回标识、标题、约 200 字摘要、来源、时间、标签，以及译文状态和标题。分页游标是 `before=<isRead>,<sortAt>,<id>`，未读仍排在前面；社交单页最多 50 条，媒体最多 100 条。`fields=full` 在一个版本内保留正文、译文、段落和中文整理稿。打开单篇才读全文：媒体用 `GET /api/v1/feed/media/article`，社交用 `GET /api/v1/content-items/:id`。Domain 直接调用未传 `fields` 时仍返回全文，小时阅读和日报材料不走这条精简列表。
- `FeedIdentityFingerprint` 是作者 + 正文的稳定身份（SHA-256），与 tweet / 视频 ID 分开保存。正文可以按保留期清掉，fingerprint 继续留着：同一作者同一段文字再次投递时跳过，左滑删除后即使 Capture 已不在也不会再出现。无正文时退回 `external:{id}`，避免图文空帖互相撞车。表里只存 hash、externalId 和时间，不存推文正文。X 与雪球的入库正文会在帖子原文后附上抓取当时可见的前 5 条评论摘录，指纹按这份正文计算；已经记下的 external ID 不会为了刷新评论再打开。
- `FeedItemTranslation` 是信息流与抓取文本的中文投影，按条目 ID + 正文哈希落在 SQLite，不覆盖 Capture / ContentItem 原文。电脑和手机读同一份。英文或韩文在抓取入库后统一走 Gemini 批量翻译并轻度清洗（去界面残渣、不总结、不扩写）。一次最多 30 条；`id` 必须对齐。Gemini返回429 / RESOURCE_EXHAUSTED时回退Elucid Grok；不再调用DeepL / Google翻译。翻译和打标在同一进程共享配额冷却，短限流按Retry-After / RetryInfo恢复，每日配额耗尽等到太平洋时间次日零点再尝试。缺Gemini Key时可使用已配置的Elucid；两者均不可用则保留待处理，不把原文或空结果当译文。用户 view 只消费译文；原文继续保存在 Capture / ContentItem，经 `GET /api/v1/content-items/:id/original` 或 `GET /api/v1/feed/items/:id/original` 读取。页面 Contract 不暴露供应商。官方日程、官媒标题和预测市场问题复用同一张译文表，Source Snapshot 字段保持原文事实。
- 发给模型的信息流请求走 Domain `packFeedAiBatches`：先给每条标注字数。翻译一次最多 30 条打成一组（条目模型输入仍可截到约 5000 字）。Capture/ContentItem 仍保存全文；只有模型输入可以截断，并标记 `truncatedForModel`。粗筛 Tag 复用同一函数：`purpose=analyze`，默认每批最多 20 条 / 30k chars，单条最多 6000 字（超长取头 4500 + 尾 1500）。Tag 走 Gemini，输出仍按 `item_id` + `tags[]` 验收。
- Tag 是全局粗筛：输入一批文本，按 `item_id` 回收 `tags[]`。当前可挂 `content-item`（多标）、`inspiration`（单标）、`knowledge`（多标）、`media-index`（多标）。字典来自 Instance 的 `config/tags.json`，缺省模板为仓库的 `config/tags.default.json`，与 Knowledge Taxonomy 分离。结果写入 `resource_taggings`，不改 ContentItem 字段。未知 tag / 未知 item 丢弃；漏项重试；空数组是合法成功。

- 重新生成字幕、摘要或结构化结果时，不能覆盖原始 Capture。
- 平台登录、Cookie 和抓取脚本内部字段不得进入 ContentItem。
- `media` 是媒体资讯提供者，和 RSS 传输、出版商身份分开。`content.media.articles` 只接受目录里的 `sourceKey`。索引写在 `media_index_entries`，不进入社交 ContentItem 列表。同步后的 `media.index.enrich` 先处理正文、全文翻译和现有 X Tag 流程，Tag 资源类型是 `media-index`。`contentAccess=body` 的来源按配置抓正文快照（每日上限为null时不限额），并另存一条 Capture / ContentItem。FT主站保持索引；BBC/Guardian公开文章、FT官方周报与署名转载按Instance登记范围读取正文。Techmeme 保留发现记录，只有显式登记在 Instance `discoveryPublishers` 的域名、路径和正文用途可建立独立原报道，保留 `discoveredVia` 并计入原出版商采集统计。来源默认关闭，不进入 X / 雪球的自动订阅列表。
- `packages/contracts/src/media.js` 校验正文等级、抓取状态、段落与提要。fetchState 独立记录 HTTP 状态、失败原因、尝试/连续失败次数、冷却时间、请求/正文字节、解析版本、原文作者/日期/最终 URL；翻译和提要各有独立状态。Feed 新增 `view / offset / limit`、全视图 counts 与 nextOffset，默认参数兼容旧 GET。
- 媒体全文保留 `media-index` 的资源身份用于翻译、Tag和阅读引用；另投影真实 `contentItemId` 与 `isRead`，通过既有 ContentItem 状态接口保存已读。未读优先排序在分页前完成。来源可配置 `backfillHours`（1–2160小时），缺省沿用全局48小时；官方发布的 Instance 配置使用720小时，日历不自动变成文章。
- 媒体来源可选`listReadMethod / bodyReadMethod`为`http / browser`，缺省HTTP；活动来源上限可配置1–24、缺省6，旧1–16配置继续有效。2026-10-05用户授权扩充新闻栏目，当前Instance设为24；当时登记总数最多40。2026-10-07联合早报国际栏目使登记上限为41，来源默认关闭，活动上限仍为24。已有官方Adapter不占活动额度，discovery出版商占用额度。刷新间隔、串行域请求和字节限制保持。来源还可配置`maxListCandidates`、`maxNewBodiesPerRound`与`minRequestIntervalMs`；未配置时沿用原有轮次行为。早报同时读取国际和中国栏目，不读新加坡栏目；每轮最多80条新索引和80篇新正文，请求间隔至少3秒，并服从更严的每日额度。仅固定登记的公开栏目使用BrowserRuntime，缺少浏览器返回不可用，付费页不自动回退。转载在既有`discoveredVia`保存阅读入口，`publisherKey`保持原媒体；Feed可选`readingVia`投影入口名称，原文链接仍为可读入口，`originUrl`只保存真实发现的原报道地址。
- HTTP正文适配优先使用来源的`publisherKey`，缺失时兼容旧`sourceKey`；新BBC/Guardian栏目共用出版商适配，不修改历史文章身份。普通文章与live/video页面分别判定；特殊页面不能套用普通正文的full条件。真实入口与正文抽样只读验收使用Host隔离输出，无模型调用；生产启用仍通过Service探针与显式启用，不以配置enabled默认值代替数据库状态。
- 媒体采集范围来自媒体原生频道列表；`includeKeywords / excludeKeywords / focusKeywords`只兼容读取，不参与索引、正文候选或默认页面筛选。`sourceKey`表示采集入口，`publisherKey / publisherName`表示文章出版商，`channel`保持现有tech/macro分组。可选`channelName / channelUrl / listSelector / sourceAliases`描述入口及历史兼容，不新增主题分类系统。
- migration 36增加`media_entry_discoveries`，保留文章的多个频道入口、列表位置和首次/最近发现时间。规范化URL精确相同的新增发现复用已有externalId；不按标题合并，不重算历史Capture、译文、已读/隐藏与引用身份。Yahoo Economy替代两个旧署名入口，旧sourceKey作为兼容别名；采集统计合并计算旧别名与新入口的用量，不重置计数。
- `media_source_states.ingestion_policy`记录已成功应用的采集策略版本。版本变化触发一次无ETag/Last-Modified的受控读取，成功解析落库后才更新版本；失败保留待恢复状态。重新解析仍受既有回看窗口约束；每日元数据、正文成功数、请求数和来源detailDailyCap缺省为null，取消配额后原配额延期立即恢复。未知发布时间保持null，列表位置不代替发布时间。
- Feed 的可选 `articleTranslation` 是完整正文翻译投影，包含 `status / bodyHash / snapshotRevision / title / paragraphs / completedChunks / totalChunks / updatedAt`。每个当前正文分片 sourceHash 都匹配时才是 `ready`，旧的单条信息流译文不计入全文完成度。已译段落保持原段落 ID 与类型；正文或标题变化生成新缓存身份，读取端立即使旧译文失效。`translation` 兼容字段继续供摘要索引使用，不代表全文。UI 默认读取全文视图，未完成翻译时展示原文及进度。
- 提要绑定 `bodyHash / snapshotRevision`，每条 evidence 必须是已存段落的连续 quote。来源摘要不被生成文本覆盖。日报候选使用完整的有效提要（最多300字符）及 `media-body` SourceRef，旧索引修订上的提要不进入新报告。
- migration 34 增加正文观测、结构快照、提要与真实请求计数；35 增加按正文版本保存的提要处理状态；36增加频道发现、策略版本与逐篇出版商/作者字段。既有迁移不改写，不重建用户数据库。正文和投影保存与 outbox 同事务。

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
  `sourceHealth` 含 Source ID、标题、类别、Snapshot 状态、观测时间、客观读取说明，以及 `failingSince`。
  `failingSince` 是这次连续不可用开始的毫秒时间；可用或部分可用时为 null。首页和信源目录的「暂不可用」计数只计入开始未超过 24 小时的条目。首页关注范围由静态目录投影，
  不向事件添加 `importance` 字段。
- 静态信号契约不接受 `importance`、`forecast`、`consensus`、`surprise`、`impact`、`bullish` 或 `bearish`。这些属于市场预期或解释层，不得塞入来源 metadata 绕过建模。
- `prediction-market` 只保存场所原始报价事实：venue、问题、outcome、mid / bid / ask / spread、成交量、流动性、OI、到期时间和观测时间。Polymarket 与 Kalshi 的行保持分离，不生成跨场所加权或“真实概率”。
- 事件报价每小时快照写入 `event_quote_snapshots`：`symbol` 是 quoteId，`probability` 是当时的 midPrice 十进制字符串，`observed_at` 是写入时的整点。`GET /api/v1/market-native/board` 的每条事件可以多一个可选字段 `midPrice24hAgo`。它只取「当前时间减 24 小时」前后 3 小时内最近的一条快照；窗口里没有记录就省略该字段，不回填 0 或当前价。
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
- `HoldingLot` 批次按 `a_share` / `hk_connect` / `b_sh` / `b_sz` 记账，`openedAt` 为空表示导入仓（开仓日未知）。港股通 `costPrice` 是券商人民币成本单价，市值才用港币现价 × `HKDCNY`；不得把人民币成本再乘一遍汇率。持仓页汇总三行：A 股（含港股通+人民币现金）、B 股沪市（美元股票+美元现金）、B 股深市（港币股票+港币现金）。页面大字是 CNY，外币只作小字；汇率不单独展示。沪深股票、场内 ETF/LOF、B 股和港股通现价优先走雪球批量行情（Yahoo 符号 `.SS` → `SH600519`，`.SZ` → `SZ300750`，港股补齐 5 位如 `0981.HK` → `00981`）。同花顺 A 股/基金快照仅作缺票回退；Yahoo 约 15 分钟延迟只作再回退。汇率仍走 Yahoo。某次没有刷到精确现价时，持仓沿用上一笔精确报价，不把人民币市值或盈亏写成 0；只有新的精确现价才替换。页面 Contract 不暴露雪球或同花顺字段。`market.quotes` 的 Source TTL 为 3 秒。`moveGroups` 把波动按 A 股 / B 股拆开；首页各组「今日」等于该组持仓行 `dayPnlCny` 之和（现价对昨收，再折人民币），对齐券商「当日」；点进子页后，周 / 月仍按原持仓市值波动（含汇率）。`moves` 仍是全账户日周年对照，其中「今日」同样改走报价当日盈亏。`addedPnlCny` 是期间新开仓从开仓价到期末的波动。现金目前仍是余额快照，只计入汇兑，不把转入本金算成收益。转入本金的完整拆分要等 `Transaction` / 现金流水。`GET /api/v1/holdings?refresh=1` 跳过行情缓存并改拉更密的报价，用于核对是否实时。
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
- 用户主动引用是协议，不是独立领域：`resourceType + resourceId + revision`。当前支持 `content-item`、`post`、`inspiration`、`knowledge-revision`、`ai-run`、`daily-brief-item`。页面 ID（例如 `x:externalId`）不能当作 Resource ID；信息流 DTO 使用 `resourceId` 指向 `content_items.id`。同一组 refs 不只给问答：`POST /api/v1/context/pack` 把当前落库内容打成 Markdown 材料包（日期、来源链接、已有译文），页面可导出、放入任务框或继续带去问答。不新增 Pack / Bundle 领域，也不经隧道外发。
- `CreateAgentRunInput.references` 进入 Job 后，由 Context Service `resolveReferences()` 确定性读取并写入模型上下文，不走 Tool Registry。写入 `ai_run_context_refs.origin = selected`；Tool 产生的引用为 `origin = tool`。问答会话详情把这些 refs 投影为 `sourceFooter`（去重、分组、最多 24 条），页面在回答文末展示并可跳转；不解析模型正文。信息流条目优先用已落盘译文作为正文。
- 日报观点可作为 `daily-brief-item` 引用，沿用同一 references / 材料包 / 问答链路。`resourceId` 为 `reportDate/candidateId`（最长 267 字符），`revision` 必填，等于该 DailyBrief 的 `generatedAt`。其他主动引用 ID 仍最多 256 字符。Context Service 经 Report Service 读取同 workspace 的已落库观点及生成时快照，明确区分模型观点与原文依据，不暴露供应商字段。旧版之间重生成保持版本不匹配即missing；首次升级为V2时归档原旧稿。V2的`daily_brief_versions`按生成时间归档正文、材料快照与多源证据，旧引用读取对应版本，绝不指向新版结论。已发送引用按既有AiRunContextRef保存，来源栏归入日报。
- `GET /api/v1/knowledge/mentions` 给问答输入框 `@` 补全：返回本地 Knowledge 文件（分析框架等）和 SQLite 知识文档，形状是 `knowledge-revision` 引用，不含文件路径。不是独立 MCP Skill 领域。
- `CreateAgentRunInput.selectedSkills` 是本轮分析方法，最多一个 `{ id, version }`。旧客户端省略时为空数组。技能正文、文件路径和内容哈希不能提交，也不能放进 `references`。`GET /api/v1/agent/analysis-skills` 只返回可选择的编号、版本、名称和一句说明。服务端对照 `config/analysis-skills/registry.json` 校验编号、精确版本和 `selectable`；未知或不可用版本直接拒绝，不改用最新版。已发布版本的 `contentHash` 必须与对应 `SKILL.md` 字节一致，不一致则该版本不可选。更新指导时新增版本并保留旧文件。Job 只保存编号和版本。执行时 Connector 读取正文，`AiRun.output.activatedSkills` 保存 id、version、name、contentHash。历史重建只带这个身份，不把指导正文写回引用或先前轮次。下一轮未选择则为空。技能不改变 `webMode`、`researchMode`、`modelProfile`、工具权限或预算。
- `webMode` 在生产 Harness 上只表示 Prompt 倾向，不再隐藏联网工具：`off` / `fallback` / `always` 都有完整 `web_search` + `web_fetch`。本地循环回退仍可用 `webMode=off` 隐藏 Domain `web.search`。Domain `web.search` 经 SourcePort 读 `search.web`，只留给测试或 `AI_CENTER_AGENT_RUNTIME=local`。News 核验若发生，必须来自真实联网 Tool（Harness `web_search` / `web_fetch`，或本地 `web.search`）。
- `researchMode` 是问答的专业研究开关：`standard`（默认）走普通档；`research` 由 Domain `resolveResearchProfile` 解析为 `AgentResearchProfile`（`modelProfile` / `thinking` / `methodKeywords` / `extraToolIds`），写入 `ai.agent.run` Job input，不新增表。页面 Contract 不暴露供应商或具体模型名。`modelProfile=research` 只表示更高模型档位；Harness 映射 `AI_CENTER_HARNESS_RESEARCH_MODEL`，未配置时仍用 `AI_CENTER_HARNESS_MODEL`。`methodKeywords` 与 `extraToolIds` 是预留口，当前默认空数组；`researchOnly` 工具只有出现在 `extraToolIds` 时才暴露。不要用 `metadata` 塞研究方法。
- Agent 只读 Tag 工具：`tag.list` 读取 Catalog；`feed.tag.search` 按已落盘 Tag 查 ContentItem。`tag` 同时接受稳定 id、中文名和关键词，由 TaggingService 解析。`timeRange` 为 `all | today | yesterday | last-24h | last-48h`，由 Runtime 当前本地时区确定性计算，优先 `publishedAt`，缺失时 fallback `createdAt`。
- `POST /api/v1/notes/from-run`、`POST /api/v1/knowledge/from-run` 把 AI 回答编译为 Inspiration / Knowledge Document，来源记在 `sourceType` / `sourceId` 或 `knowledge_links.derived_from`，不把来源塞进正文。手工创建仍用 `POST /api/v1/knowledge`。
- `AiSession.kind` 区分 `question-answer` 与 `inspiration`（以及后续其他 AI 处理记录）。页面第一层列出记录，第二层打开会话。
- KnowledgeDocument 保存当前规范版本；KnowledgeRevision 保存完整历史。
- 检索结果必须返回 knowledge ID 和 revision，确保问答可以追溯来源。
- 中文全文检索使用 SQLite FTS5 trigram tokenizer。

## Runtime 与事件

- 2026-10-06 用户要求方向文章：当前 `BriefEditorialOutput` 为 overview 与 directions/key/label/articleTitle/lead/sections/paragraphs，导语和段落保存 text/itemIds，方向身份固定，不接受模型链接。`brief-editorial-v3` 保存程序生成的文章/段落 ID、逐段冻结 evidence 与事项 inputVersion；ready 复用须同时匹配版号和输入指纹。事项正文主要归属唯一方向文章，同一文章的章节间可合理分段引用，导语可复述该方向正文；未知 ID、段内重复事项 ID、跨方向重复归属、标签错配或无依据导语整份拒绝。历史 v2 结构仍可解析，不伪造新版段落证据。
- 固定小时生成输入新增 `mode=resume|rewrite` 与可选 `snapshotId`；重编必须指定 hourStart，指定快照须使用 rewrite 且同 workspace/完整小时。只重编已保存冻结底稿，新不可变快照失败不替换旧 ready 发布指针。目录 itemCount 对 v3 表示方向文章数量，v2 表示主题数量，底稿查询保持全部原事项；日报文章 ID、旧主题 ID及底稿 ID仍按对应冻结版本可引用。
- 小时方向文章沿用 `hourly-digest` 引用类型，resourceId 可为 `snapshotId/articleId`，只解析该冻结文章；找不到文章时返回missing，不回退到整小时。旧 snapshotId 引用仍读取整小时，日报方向文章沿用 date/articleId 与成稿 revision；两者不创建问答线程。

- 2026-10-05 整小时编辑：`HourlyDigest` 与 `DailyBrief` 新增可选 `editorial`，兼容原 JSON。`BriefEditorialOutput` 只包含 overview、overviewItemIds、directions/topics（title/body/itemIds），不接受链接、供应商或任意命令。Domain 拒绝未知、重复事项、无依据总览和空方向，程序回填主题 ID、时间和全部冻结 evidence；ready 正文与底稿分别保存，未采用事项不自动追加。failed 明确表示“主题整理未完成”，旧 ready 发布指针保持有效。小时/日报目录的 itemCount 对 ready 新稿表示阅读主题数量；搜索结果 hours.itemCount 仍表示底稿数量。
- `ReferenceInput` 允许 `hourly-digest`，resourceId 是不可变快照 ID，不需要额外成稿版本；Context Service 按冻结 ID 读取总览、主题和证据，并提示字数预算、底稿查询入口及覆盖。它不创建 Agent Session；更新发布指针不改旧引用。日报主题 ID 与底稿 ID 都可按原日报 date/revision 解析。
- `MediaSavedArticleQuery` 严格校验 externalId；`GET /api/v1/feed/media/article` 经 Media Service/Repository 按身份与 workspace 读取已保存文章，复用列表文章投影、全文结构与译文，找不到返回404，不扫描列表、不抓取、不派发任务。来源身份由冻结材料 sourceRefs 解析，媒体列表未加载不影响站内阅读。

- 简报只读元数据：`HourlyDigestIndexQuery`严格校验大于零、七日以内的UTC窗口；`HourlyDigestIndex`返回实例timezone及每个完整小时的hourStart、已发布id（可null）、generatedAt、itemCount、最近处理status/updatedAt、unread/failed计数，独立表达旧发布版本与新重试状态，不携带正文、供应商或Host路径。`running`须持有有效租约，已过期运行记录作为`failed`读取，不在GET中写回状态。`DailyBriefWindowQuery`按date/revision读取指定成稿版本的冻结window/timezone，无法核对的旧版本返回null。两条读取路径均经Report Service/Repository，不生成Job、不改变现有InformationItem/DailyBrief存储契约。

- 2026-10-06 小时状态补全：目录列出请求范围内全部已结束完整小时（不含未来/当前未结束小时），缺处理记录时status/phase为`not-started`。可选`readable`表示发布指针确有可读文章，`draftId/draftItemCount`单独描述最新保存底稿；旧ready与新失败可同时存在。`phase`区分queued-extraction/extracting/queued-editing/editing/draft/ready/empty/failed，`failureStage/failureReason`为固定枚举，`queueMs/executionMs`是最近模型阶段耗时；不返回原始错误或供应商字段。旧目录响应可继续兼容。每个阶段的诊断不进入模型输入和缓存身份，不改变冻结事项或证据契约。

- 信息摘选新稿沿用 DailyBrief `schemaVersion=2` 并以 `flowVersion=information-digest-v1` 区分流程。`informationItems` 保存全部逐条信息，`hourlySnapshots` 固定来源快照；旧 `items` 前八项仅为兼容概览，历史目录条数读取完整清单。`DailyAnalysisOutput` 新形状是 `items[{sentence,evidence}]`，旧 analysis 字符串阶段使用 `LegacyDailyAnalysisOutput`，不可把两种输出混读。每条 `InformationEvidence` 包含 snapshotId/materialId/paragraphId/materialHash/materialVersion；日报继承原引用并直接读证据，无须依赖新的日报生成时间。HourlyDigest 保存窗口、冻结/生成时间、事项、覆盖和警告。HTTP 生成只接受 hourStart 并入队固定 `report.hourly.extract`，不接收预算/Provider/命令。只读 Ask 工具支持七日以内窗口和 offset 分页。非整点日报截止的边界快照仅供该日报使用，不替换独立小时查询。详见 `information-digest-v1.md`。

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
  行情 `asOf` 仅使用来源报价时间；没有时为 null，不能用获取时间代替。`fetchedAt` / 持仓 `updatedAt` 是获取时间。
  沪深市场及持仓附带可选 `calendar`（交易日期、交易日状态、交易阶段、休市原因、下次交易时间、已核验年度）。
  2026 年按交易所休市公告，调休周末仍休市；未核验年度工作日状态为 unknown，不推断节假日。
  持仓可选 `quoteAsOf` / `session` 保留报价时间和市场状态；休市时现价对前收盘价表示最近交易日变动。
- `DailyBrief` V1 是旧快照的注意力筛选；V2 (`schemaVersion=2`) 是材料快照后的分轮综合分析，仍不是新的事实层。V2 支持完整 `sections.body`、多材料段落证据、来源覆盖与追踪问题更新；前8项提供兼容概览卡片。`DailyMaterial` 固定来源、时间、正文等级、版本与哈希。`daily_analysis_stages` 保存输入/输出与失败状态，`daily_analysis_runs` 固定运行快照和租约。接口 `/daily/brief/generate` 默认刷新所选日期材料，`mode=rewrite` 读取已成稿冻结版本并复用阅读阶段，原文 `/daily/evidence` 按日期、生成版本和段落解析。以下候选行为仅适用于V1。候选池由程序从日报生成；模型只返回 `candidateId` 和说明。`type`、`occurredAt`、`sourceRefs` 都从候选池回填。模型输出里不存在的 `candidateId` 整份拒绝。`daily_report_briefs` 按 `workspaceId + reportId` 唯一，并保存当时的候选快照和 `sourceReportUpdatedAt`。日报手工重跑后 `updatedAt` 变化，对应 Brief 需要重新生成。Brief 不改写 DailyReport。`catchup: true` 只用于失败后的延迟补跑：同一 `reportId` 已有且 `sourceReportUpdatedAt` 仍等于日报 `updatedAt` 时直接返回，不调用模型。`GET /api/v1/reports/daily/briefs` 只返回日期、概述、条数和生成时间，点进某一天再读完整 `DailyBrief`。
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
## X 点赞试用契约（2026-10-07）

`feed-interaction.js` 声明固定 `feed.x.like`、严格 ContentItem ID 入参、`confirmed:true` HTTP 命令与脱敏结果。结果区分 `liked` / `already-liked` / `login-required` / `blocked` / `unavailable` / `not-found` / `unconfirmed`；账号仅返回 handle，不输出登录态或 BrowserRuntime 信息。接口与兼容边界见 `feed-interaction-v1.md`。


文章整理隔离协议 `article-normalize-v1`：模型返回 title/tagId/summary/body 或 needs_content。信息节点仅以 text 保存摘要，新增可选 body 和 formatVersion；新格式无 body 校验失败。旧短稿读取不回填正文。小时/日报沿用原短文 Schema，输入投影排除 body。详见 `article-normalize-pilot.md`。

2026-10-07 用户授权Gemini信息整理接入：同一冻结Harness新增封闭article-normalize路由，一次生成标题/Tag/摘要/正文；正文可选字段按版本校验，小时/日报仍只传摘要投影。三Key按项目持久化限流，明确quota冷却后显式Grok fallback，正常报告半点调度；不增加Agent或页面供应商字段。设计和兼容边界见 `gemini-article-normalize.md`。

2026-10-07 用户授权五账号并发文章整理：封闭article-normalize任务可通过同一冻结Harness适配器的最多5个隔离执行上下文并行，不共享Session/Gateway/DSH Home；Ask、文章阅读和报告保留原串行上下文，不新增业务Agent。WorkerJobConcurrency新增informationPreparationLimit（1—5，默认1）。领取文章准备Job前检查持久化预算，关闭窗口不领取、不消耗attempt、不派生短周期重试；每账号租约及分钟/日预算经Repository事务准入，新增migration45，不改历史迁移。预算与兼容开关见gemini-article-normalize.md。

补充：用户重新授权上述并发上线，准入和在途租约的最小单位为账号/已知项目＋模型。同账号不同模型可同时执行，分钟/日/滚动小时预算与冷却独立；总封闭任务并发仍最多5。Host模型选择参数不进入HTTP/Page契约，正式运行状态见progress/2026-10-07-gemini-account-model-pool.md。

社交Feed兼容阅读投影可包含normalizedArticle，运行时由FeedNormalizedArticleSchema校验nodeId、中文title、summary、body和generatedAt，读取必须匹配同workspace当前原文版本。它是中文整理稿，不等同完整逐句翻译；旧translation字段语义不变，原文body不覆盖，不暴露供应商字段。
2026-10-07 小时浓缩树的 eventAt/window 使用首次入库时刻（社交 createdAt、媒体索引 createdAt）；publishedAt 仍保存原文发布时间。仅 tree-v3 候选读取采用收录口径，旧 DailyWindow/legacy 日报保持发布时间语义。重分窗以新不可变信息节点保存，旧引用保持，页面不增加供应商字段。
