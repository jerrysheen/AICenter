# 2026-10-02 媒体正文验收与修复

依据用户提供的 media_body_audit_20261002 报告。本记录时间：2026-10-02T07:27:19.878Z。

## 结果与范围

- 修复 DCD、Next Platform、Decoder，并复用已有 policy.us.fed 验证宏观正文；未新增 Agent、数据库体系或浏览器绕行。
- 当前 Instance 有 21 篇已验证正文，21 篇有效提要；22 条已有正文的快照 / ContentItem / HTTP 投影逐字一致（包括保留但降级的旧正文）。提要不替换 RSS 摘要，引用已存 bodyHash、快照修订和段落。
- 旧 full 12 个明确 ID 做有界修复：11 个新正文修订成功，1 个 DCD 本次403。原12个旧快照全部保留。失败条目在 API 标为未验证，不继续称为完整正文。
- Decoder 付费预览保持降级，FT仍是索引，Techmeme仍是发现；未开放任意原报道域名。
- BBC 技术上返回公开页面，但当前 [robots](https://www.bbc.com/robots.txt) 与 [使用条款](https://www.bbc.com/pages/terms-of-use) 限制自动系统采集，停止后续正文抓取并保留索引。宏观替代采用已有美联储官方公开来源，其 [免责声明](https://www.federalreserve.gov/disclaimer.htm) 说明官方材料与第三方材料的用途区别；不复制第三方图片。

## 前置只读诊断

运行 Node v22.23.2，读取 Instance 路径解析后的 `data/ai-center.db`，当时 schema 33。Web / Worker 为修复前运行版本；没有先改数据库或解析器。原始诊断在 Host 的 before.json / pre-repair.json。

| 来源 | 索引 | 原标full | 有快照 | 正文字符min/p50/p95/max | RSS摘要字符min/p50/p95/max | 快照/ContentItem长度差异 |
|---|---:|---:|---:|---|---|---:|
| bbc | 28 | 0 | 0 | — | 38 / 101 / 147 / 195 | 0 |
| dcd | 20 | 8 | 8 | 1172 / 2043 / 2933 / 13468 | 35 / 60 / 101 / 168 | 0 |
| decoder | 10 | 0 | 0 | — | 417 / 484 / 566 / 575 | 0 |
| ft | 24 | 0 | 0 | — | 32 / 99 / 125 / 147 | 0 |
| nextplatform | 5 | 4 | 4 | 7632 / 9276 / 11127 / 11711 | 0 / 0 / 134 / 215 | 0 |
| techmeme | 15 | 0 | 0 | — | 323 / 343 / 367 / 381 | 0 |

修复前逐篇 HTTP 失败原因和请求成本**当前未记录**，不能从正文缺失反推403或付费原因。已有正文快照与 ContentItem 没有长度不一致；此前没有做桌面录屏，不能声称测得原UI屏幕差异。阅读投影原先只对 full 展示正文且没有版本校验，现已用真实 API 与UI映射回归核对。诊断期间原 Worker 继续同步，故 before 与 pre-repair 的索引数有正常增量。

## 实现与兼容

1. 新 migration 34/35：逐篇 fetchState、结构段落、独立请求预算、版本提要和提要处理状态。已执行1–33不改写；不重建数据库，旧快照不删除。
2. htmlparser2 DOM解析，不执行源站脚本。DCD articleBody、Next bodytext、Decoder content-wrapper、Fed 官方文章列分别有真实响应策略。过滤推荐/订阅/旁栏，保留正文列表、段落、表格和声明；付费页即使有隐藏 JSON-LD 正文也不使用。
3. captcha脚本或新闻术语不等于验证页；真实验证容器、403、付费墙分别降级。RSS content:encoded / Atom content 可作为经过验证的候选，预览不足时才取正文。UTF-8按实际100000字节裁切，截断必为partial。
4. HTTP、XML、DOM、日期与URL在Connector；Domain只依赖注入端口。目录、频率、关注关键词与额度移入Instance config/media.json，Core仅空模板；不是扩大默认启用来源。
5. GET只读缓存；刷新/探针/正文进入注册 Worker handler。显式用途确认与repair仅本机，repair必须有ID。请求计数不退还；暂时故障最多5次并退避。旧full只在明确repair中重抓。
6. 轻索引按关注关键词、新增信息、重复标题、尝试次数排序；记录选择理由，按排序分配额度。列表查询不加载全部RSS HTML。超额保留可见待处理状态，不机械轮询最近40条。
7. 正文条件请求独立于RSS，304不增加快照；正文/元信息修订独立递增。partial修复不会覆盖旧full，后续成功不会与已保存partial修订撞号。
8. 提要共用冻结Harness，closedContext、无工具、无联网。模型输出片段编号，程序填充连续原文并校验引用。150–300字符，单次180秒，格式最多纠正一次；超时停止本批，失败不会每轮自动重生成。可信内部media-brief任务使用现有Elucid插件支持的low推理与4096输出token配置，继续使用原模型；其他任务和DeepSeek官方路由不变，不从HTTP/Job透传该配置。
9. UI有全量/已验证/部分/索引/待处理/失败及全视图数量、分页；明确正文范围、失败原因、图表未解析限制、提要与引用。SSE正文/提要/译文/标签更新刷新缓存。未使用Computer Use或桌面鼠标键盘模拟。
10. 日报候选优先使用有效完整提要（最多300字符）与media-body引用。正文哈希、索引修订不匹配的旧提要不进入新日报；已保存旧日报引用不改写。回归与实际候选核对均维持闭集120候选/80KiB边界。

## 真实样本

全部来自真实公开HTTP响应；正文原始HTML保存在Host .ai-data/media-audit/samples，不提交完整版权正文。Core中4份fixture保留真实DOM形状并替换成合成文字；10个报告反例也保留为独立回归。真实响应回放单独在临时数据库完成，不把历史样本伪装成今日新闻。

| 来源 | 实际样本 | full | 拒绝/付费 | 可读公开样本质量分母 |
|---|---:|---:|---:|---|
| dcd | 9 | 6 | 3 | 6/6 |
| nextplatform | 5 | 5 | 0 | 5/5 |
| decoder | 9 | 7 | 2 | 7/7 |
| fed | 5 | 5 | 0 | 5/5 |

可读正文23/23全部通过；全部尝试样本23/28（另5篇BBC只做用途核查，不计入正文质量分母）。失败为DCD三次403、Decoder两篇付费预览，未混入公开可读质量分母。未因HTTP200就判全文。首段、末段已人工对照源响应；下表首尾段哈希可与Host样本和回放记录复核。正文中的数字/单位和归因保留在段落，提要的证据必须是这些段落的原文。HTML表格按行保留，图片图表不推断数字并在UI注明需另核对。

| 序号 | 来源 | URL | HTTP | 等级/原因 | 正文字符/段落 | 首段/末段SHA256前12位 | 落库投影 |
|---|---|---|---:|---|---|---|---|
| 1 | dcd | [文章](https://www.datacenterdynamics.com/en/news/gmi-cloud-raises-668m-in-funding/) | 403 | summary_only / blocked | 0 / 0 | — / — | 无业务正文 |
| 2 | dcd | [文章](https://www.datacenterdynamics.com/en/news/european-space-agency-taps-ovhcloud-and-cgi-for-earth-observation-system/) | 200 | full / structured_body | 2210 / 8 | 9d412349f457 / be822b114acc | 一致 |
| 3 | dcd | [文章](https://www.datacenterdynamics.com/en/news/nebius-signs-50mw-lease-with-aib-data-centers/) | 200 | full / structured_body | 2449 / 12 | cb731bf712bb / a9186b0ef5cd | 一致 |
| 4 | dcd | [文章](https://www.datacenterdynamics.com/en/news/ai-cloud-provider-blackfuel-emerges-from-stealth-plans-first-deployment-in-spain/) | 200 | full / structured_body | 2266 / 10 | 94fb26d70f0c / c36c9c2792f8 | 一致 |
| 5 | dcd | [文章](https://www.datacenterdynamics.com/en/news/traysar-and-armada-team-up-for-underground-ai-infrastructure/) | 200 | full / structured_body | 2051 / 8 | c33d98366e6f / bdf354a20429 | 一致 |
| 6 | nextplatform | [文章](https://www.nextplatform.com/store/2026/10/02/microns-numbers-show-why-hbm4-memory-is-worth-15x-its-weight-in-gold/5300701) | 200 | full / structured_body | 11434 / 31 | a5a4d62c9579 / 91f87f01f49b | 一致 |
| 7 | nextplatform | [文章](https://www.nextplatform.com/ai/2026/10/01/sponsored-build-the-right-ai-factory-for-your-needs-partner-for-success/5300157) | 200 | full / structured_body | 11022 / 35 | bac0ba859f9b / 31a969d9476e | 一致 |
| 8 | nextplatform | [文章](https://www.nextplatform.com/compute/2026/09/30/optimization-is-the-key-challenge-for-quantum-computing/5300117) | 200 | full / structured_body | 8976 / 20 | 6dfeeeb7e841 / 5105b9e9ee2e | 一致 |
| 9 | nextplatform | [文章](https://www.nextplatform.com/ai/2026/09/30/nvidia-wraps-security-layer-around-agentic-ai-to-stop-rogue-behavior/5300098) | 200 | full / structured_body | 7445 / 18 | bd08d122395e / 38428adcde8f | 一致 |
| 10 | nextplatform | [文章](https://www.nextplatform.com/compute/2026/09/23/improving-quantum-error-correction-by-meshing-surface-code-with-ibms-heavy-hex-architecture/5298457) | 200 | full / structured_body | 6284 / 17 | 751e7f6f2631 / 0e42da3f54ca | 一致 |
| 11 | decoder | [文章](https://the-decoder.com/nearly-half-of-test-subjects-mistook-tavus-ai-video-avatar-for-a-real-person-on-a-one-minute-call/) | 200 | full / structured_body | 1236 / 4 | f31227acf340 / 93e30cbb2c9d | 一致 |
| 12 | decoder | [文章](https://the-decoder.com/ideogram-says-its-new-model-can-edit-part-of-an-image-without-messing-up-the-rest/) | 200 | full / structured_body | 922 / 2 | 9b9c47a1d5f2 / 0bb728a64387 | 一致 |
| 13 | decoder | [文章](https://the-decoder.com/anthropic-brings-claude-to-civilian-agencies-as-its-fight-with-the-pentagon-drags-on/) | 200 | full / structured_body | 1027 / 3 | ace0f3695b00 / a7129cfb8528 | 一致 |
| 14 | decoder | [文章](https://the-decoder.com/security-startup-finds-more-than-13000-internal-company-screenshots-that-ai-agents-uploaded-publicly/) | 200 | full / structured_body | 1189 / 3 | 83924ebb961c / f9b216b20166 | 一致 |
| 15 | decoder | [文章](https://the-decoder.com/ai-beats-strategos-greatest-player-ending-one-of-the-last-human-strongholds-in-board-games/) | 200 | summary_only / paywall | 0 / 0 | — / — | 无业务正文 |
| 16 | dcd | [文章](https://www.datacenterdynamics.com/en/analysis/giving-extra-time-to-video-content/) | 403 | summary_only / blocked | 0 / 0 | — / — | 无业务正文 |
| 17 | decoder | [文章](https://the-decoder.com/openai-says-it-stopped-a-campaign-to-steal-its-models-reasoning-but-the-trick-still-worked-on-azure/) | 200 | summary_only / paywall | 0 / 0 | — / — | 无业务正文 |
| 18 | fed | [文章](https://www.federalreserve.gov/newsevents/speech/bowman20261001a.htm) | 200 | full / structured_body | 14003 / 30 | c3c95b41671f / 44b04af38e4c | 一致 |
| 19 | fed | [文章](https://www.federalreserve.gov/newsevents/speech/jefferson20261001a.htm) | 200 | full / structured_body | 9905 / 21 | fd0a0b96cfb6 / 2a45b2fef3c0 | 一致 |
| 20 | fed | [文章](https://www.federalreserve.gov/newsevents/speech/waller20261001a.htm) | 200 | full / structured_body | 7577 / 13 | 175c0fff8220 / 8569efc4ed5a | 一致 |
| 21 | fed | [文章](https://www.federalreserve.gov/newsevents/speech/cook20260930a.htm) | 200 | full / structured_body | 16982 / 41 | 096634df367e / 2a45b2fef3c0 | 一致 |
| 22 | fed | [文章](https://www.federalreserve.gov/newsevents/speech/waller20260928a.htm) | 200 | full / structured_body | 13647 / 25 | 99f6bbb9cd23 / 085d28ed5ddd | 一致 |
| 23 | dcd | [文章](https://www.datacenterdynamics.com/en/news/russian-drones-enter-into-moldovan-airspace-collides-with-comms-tower/) | 403 | summary_only / blocked | 0 / 0 | — / — | 无业务正文 |
| 24 | dcd | [文章](https://www.datacenterdynamics.com/en/news/climber-protection-group-obtains-federal-recognized-501c3-status/) | 200 | full / structured_body | 2559 / 13 | 08dbff5d0e30 / 845418bc5d27 | 一致 |
| 25 | dcd | [文章](https://www.datacenterdynamics.com/en/news/data-center-in-kyiv-ukraine-suffers-critical-damage-and-goes-offline-after-russian-bomb-attack/) | 200 | full / structured_body | 1935 / 11 | 832298d7ce7b / 6473bcac266b | 一致 |
| 26 | decoder | [文章](https://the-decoder.com/google-gemini-4-argon-closes-the-gap-with-openai-and-anthropic-but-doesnt-take-a-clear-lead/) | 200 | full / structured_body | 7159 / 24 | 78f1bcde7183 / a88d717ef8a5 | 一致 |
| 27 | decoder | [文章](https://the-decoder.com/openai-and-synopsys-team-up-to-build-an-ai-model-that-designs-chips-like-a-seasoned-engineer/) | 200 | full / structured_body | 1224 / 4 | fe8eb7630a6e / 5c9a4ea7dd7e | 一致 |
| 28 | decoder | [文章](https://the-decoder.com/google-drops-gems-for-skills-joining-openai-and-anthropic-in-the-shift-to-agent-ready-prompt-formats/) | 200 | full / structured_body | 1173 / 4 | 946ae3ca4003 / fff585a8d827 | 一致 |

## 实际Instance读回与日报候选

verify-media-projections.mjs只读实际库与本机API：哈希一致、ContentItem等于快照、API正文含完整快照、段落一致；有效提要逐条核对连续quote与快照修订。随后调用实际日报候选构建器，确认完整提要及media-body引用进入候选。未改写用户既有日报。

| externalId | API等级/抓取 | 快照修订 | 字符/段落 | 提要字符 | 日报候选核对 |
|---|---|---:|---|---|---|
| `nextplatform:5300701` | full / ready | 2 | 11434 / 31 | 173 | 通过 |
| `decoder:the-decoder.com/nearly-half-of-test-subjects-mistook-tavus-ai-video-avatar-for-a-real-person-on-a-one-minute-call/` | full / ready | 1 | 1236 / 4 | 287 | 通过 |
| `dcd:www.datacenterdynamics.com/en/news/gmi-cloud-raises-668m-in-funding/` | partial / failed | 1 | 2043 / 0 | 待处理 | 未消费无效提要 |
| `decoder:the-decoder.com/ideogram-says-its-new-model-can-edit-part-of-an-image-without-messing-up-the-rest/` | full / ready | 1 | 922 / 2 | 224 | 通过 |
| `dcd:www.datacenterdynamics.com/en/news/ai-cloud-provider-blackfuel-emerges-from-stealth-plans-first-deployment-in-spain/` | full / ready | 2 | 2266 / 10 | 228 | 通过 |
| `dcd:www.datacenterdynamics.com/en/news/data-center-in-kyiv-ukraine-suffers-critical-damage-and-goes-offline-after-russian-bomb-attack/` | full / ready | 2 | 1935 / 11 | 181 | 通过 |
| `nextplatform:5300157` | full / ready | 2 | 11022 / 35 | 201 | 通过 |
| `decoder:the-decoder.com/anthropic-brings-claude-to-civilian-agencies-as-its-fight-with-the-pentagon-drags-on/` | full / ready | 1 | 1027 / 3 | 230 | 通过 |
| `decoder:the-decoder.com/security-startup-finds-more-than-13000-internal-company-screenshots-that-ai-agents-uploaded-publicly/` | full / ready | 1 | 1189 / 3 | 274 | 通过 |
| `dcd:www.datacenterdynamics.com/en/news/xantaro-group-names-christian-werner-as-ceo/` | full / ready | 2 | 1626 / 9 | 205 | 通过 |
| `dcd:www.datacenterdynamics.com/en/news/amazon-signs-ppa-with-constellation-for-maryland-nuclear-plant/` | full / ready | 2 | 2439 / 10 | 241 | 通过 |
| `dcd:www.datacenterdynamics.com/en/news/94gw-smr-powered-data-center-campus-proposed-in-utah/` | full / ready | 2 | 2617 / 17 | 252 | 通过 |
| `dcd:www.datacenterdynamics.com/en/news/softbank-closes-digitalbridge-acquisition/` | full / ready | 2 | 1425 / 7 | 281 | 通过 |
| `dcd:www.datacenterdynamics.com/en/marketwatch/if-youve-got-it-unlock-it/` | full / ready | 2 | 13949 / 60 | 244 | 通过 |
| `decoder:the-decoder.com/google-gemini-4-argon-closes-the-gap-with-openai-and-anthropic-but-doesnt-take-a-clear-lead/` | full / ready | 1 | 7159 / 24 | 275 | 通过 |
| `decoder:the-decoder.com/openai-and-synopsys-team-up-to-build-an-ai-model-that-designs-chips-like-a-seasoned-engineer/` | full / ready | 1 | 1224 / 4 | 291 | 通过 |
| `decoder:the-decoder.com/google-drops-gems-for-skills-joining-openai-and-anthropic-in-the-shift-to-agent-ready-prompt-formats/` | full / ready | 1 | 1173 / 4 | 208 | 通过 |
| `decoder:the-decoder.com/meta-dodges-billions-in-us-taxes-by-calling-its-ai-data-centers-experiments/` | full / ready | 1 | 2099 / 7 | 271 | 通过 |
| `nextplatform:5300117` | full / ready | 2 | 8976 / 20 | 193 | 通过 |
| `nextplatform:5300098` | full / ready | 2 | 7445 / 18 | 228 | 通过 |
| `fed:www.federalreserve.gov/newsevents/speech/bowman20261001a.htm` | full / ready | 2 | 14003 / 30 | 173 | 通过 |
| `fed:www.federalreserve.gov/newsevents/speech/jefferson20261001a.htm` | full / ready | 2 | 9905 / 21 | 187 | 通过 |

UI核对方式为实际API数据与浏览器映射函数回归，以及读者提要/证据渲染代码核对；没有宣称真机或桌面视觉验收已完成。

### 索引与正文分开统计

原6个RSS来源持久化探针为6/6有效索引响应（HTTP200且有条目），属于此前探针观测，不等于本轮逐篇正文成功率。Fed复用已有官方Adapter，本轮同步保留4条索引，来源健康为ready；不把它算作直接RSS探针成功。全库没有完整索引请求历史，不能虚构全历史成功率。下表完整正文数按当前API的版本校验计数，故DCD的旧403正文不算已验证full。

| 来源 | 保存索引数 | 已记录索引探针HTTP/条数 | 当前同步状态 | 已验证正文/全部索引 | 有效提要/已验证正文 |
|---|---:|---|---|---:|---:|
| bbc | 29 | 200 / 51条 | ready | 0/29 | —（无已验证正文） |
| dcd | 20 | 200 / 20条 | not_modified | 7/20 | 7/7 |
| decoder | 10 | 200 / 10条 | not_modified | 8/10 | 8/8 |
| fed | 4 | 既有官方Adapter | ready | 2/4 | 2/2 |
| ft | 24 | 200 / 25条 | ready | 0/24 | —（无已验证正文） |
| nextplatform | 5 | 200 / 83条 | not_modified | 4/5 | 4/4 |
| techmeme | 18 | 200 / 15条 | ready | 0/18 | —（无已验证正文） |

| 频道 | 全部 | 已验证 | 部分 | 索引/发现 | 待处理 | 失败 |
|---|---:|---:|---:|---:|---:|---:|
| tech | 53 | 19 | 0 | 18 | 12 | 4 |
| macro | 57 | 2 | 0 | 53 | 2 | 0 |

正文/提要状态和翻译状态独立。已验证正文不意味着其他所有索引都完成正文，列表数量与筛选使用全视图计数。

### 关键变化、数字与证据核对

以下为本次模型提要的完整文本，已经逐篇核对保存正文中的单位、期间、实际/预期和归因。程序另校验每条连续引用属于指定段落与bodyHash；这不表示对来源说法做了外部独立事实核实。原文作者/发布时间/更新时间/canonical/最终URL保存在快照，真实API元信息与ContentItem作者已逐条校验；缺失字段保持未知。

| 文章 | 提要与关键字段 | bodyHash前12位 / 修订 / 证据段落 | 源作者 / 源发布时间 |
|---|---|---|---|
| Micron’s Numbers Show Why HBM4 Memory Is Worth 15X Its Weight In Gold | 据报道，美光科技2026财年于9月3日结束的季度营收同比增至4.8倍，达到542.3亿美元；营业利润接近一年前的12倍，为437.5亿美元；净利润增至12倍，为377亿美元，相当于营收的69.5%。同期现金增至734.5亿美元，约为上年的7.6倍，资本开支为107.7亿美元。文章称，公司并不打算把存储器与闪存晶圆厂的建设速度提高到既有计划之上。 | 6de05b448786 / r2 / p0004, p0005, p0006 | Timothy Prickett Morgan / 2026-10-02T00:37:58.000Z |
| Nearly half of test subjects mistook Tavus&#039; AI video avatar for a real person on a one-minute call | Tavus推出其称为首个“人类交互模型”（HIM）的Griffin，用于实时理解并开展面对面交谈，在接收与生成视频时处理语音、表情、语气、手势和停顿。据Tavus研究，一分钟视频通话后有48%参与者认为Griffin是真人，此前系统最高为2%。在Tavus所称的独立英伟达测试中，Griffin的拟人感得分为3.83分，真人3.92分，此前最佳AI模型为2.80分。Griffin-Lite目前仅作为研究预览向部分测试者开放，能力更强的版本待安全问题处理后推出。这家2020年成立于旧金山的公司已融资约6400万美元，业务由销售营销用个性化AI视频扩展至数字人实时视频对话。 | ba4923c0a2e7 / r1 / p0001, p0002, p0003, p0004 | Matthias Bastian / 2026-10-01T18:03:40+00:00 |
| Ideogram says its new model can edit part of an image without messing up the rest | Ideogram已推出图像模型Ideogram 4.5，目前可在其平台及API上使用，全部档位均为原生2K分辨率，四档质量价格从每张0.8美分到22美分不等。公司称，模型只会改动用户指定的局部，其余画面保持不变，从而缓解局部编辑连带改变整体的问题；早期测试者确认多次编辑后一致性较强。适用场景包括产品摄影、室内设计、照片修复和图内文字编辑。公司还表示开源权重版本即将发布，合作伙伴包括Picsart、Runway、Pika和Leonardo AI。 | 482c13568936 / r1 / p0001, p0002 | Matthias Bastian / 2026-10-01T17:33:03+00:00 |
| AI cloud provider Blackfuel emerges from stealth, plans first deployment in Spain | 推理云服务商Blackfuel于9月30日正式结束隐身并启动，宣布计划在西班牙巴塞罗那Digital Realty的BCN1数据中心进行首次部署。据报道，BCN1于今年早些时候启用，托管面积为1.5万平方米；首期将基于液冷戴尔PowerRack，采用搭载AMD Instinct MI355X加速器的PowerEdge XE9785L服务器。公司还计划在西班牙其他地点以及芬兰和法国部署，并推出以固定月费预留模型服务份额的分片GPU容量，而非整租多卡集群。 | bd0e087d60e2 / r2 / p0002, p0003, p0004, p0006 | 未提供 / 未提供 |
| Data center in Kyiv, Ukraine, suffers "critical damage" and goes offline after Russian bomb attack | 基辅Parkovyi数据中心业主在Facebook发文称，截至2026年10月1日，该设施因俄罗斯联邦一系列袭击遭受严重损坏并完全停止运行，现场已无法恢复服务。业主表示员工安全，客户数据已部署在欧盟备份站点。据Data Center Map，该中心曾是乌克兰唯一获得Uptime认证的Tier III数据中心，面积2715平方米；建筑是否被炸弹完全摧毁尚不清楚。 | 4647915b730e / r2 / p0002, p0003, p0004, p0005 | 未提供 / 未提供 |
| Build The Right AI Factory For Your Needs: Partner For Success | HPE与NVIDIA的AI工厂组合按工作负载提供三条路径，而非单一配置。交钥匙的HPE Private Cloud AI为本地平台，面向微调、RAG与推理，规模最高256颗GPU；大规模方案覆盖数百至数万颗GPU，并在全生命周期提供集中管控与多租户。主权AI工厂在此基础上增加数据驻留、可选气隙配置与内置合规框架。材料称加拿大TELUS与美国犹他大学近期已部署相关工厂，成效属于厂商表述，未见独立数据。 | 131bd788d331 / r2 / p0009, p0010, p0011, p0012, p0032 | James Hayes / 2026-10-01T15:00:00.000Z |
| Anthropic brings Claude to civilian agencies as its fight with the Pentagon drags on | Anthropic现向美国联邦及州民用机构提供Claude for Government。平台自7月起公测并运行于FedRAMP High最严云安全环境。因五角大楼禁用Claude，公司3月拒绝放弃大规模监控和自主武器禁令后被列为供应链风险，遂主攻民用。特朗普曾下令停用，军方却在伊朗战争使用后移除；8月底一项认定被裁为非法报复并撤销，9月底另一项由上诉法院维持。机构按使用量付费并设固定上限，功能与企业相同，包含预算权限管控、双人审批以及聊天留存于机构设备。 | 1ddef71ae6ca / r1 / p0001, p0002, p0003 | Manuel Uth / 2026-10-01T14:26:54+00:00 |
| Security startup finds more than 13,000 internal company screenshots that AI agents uploaded publicly | 安全初创公司Glow Security发现，人工智能代理将超过13000张企业内部软件项目截图上传到公开GitHub仓库，涉及343家机构，包括财富500强公司、金融机构和人工智能实验室。开发者通常让代理截取界面改动前后的图像供审核，这些图像本应只出现在授权成员可见的私有拉取请求中，但GitHub不支持通过代理使用的命令行附加图片，代理因而多在开发者个人账户下建立公开仓库上传。截图含客户数据、登录凭证和未发布功能等；约三分之一受影响机构使用会公开存储截图的开源工具gitshot，部分由代理自行发现，且因图像不在公司账户中，安全团队此前未察觉。 | 3b8bee043585 / r1 / p0001, p0002, p0003 | Manuel Uth / 2026-10-01T13:19:33+00:00 |
| Xantaro Group names Christian Werner as CEO | Xantaro集团宣布任命Christian Werner为首席执行官，接替Martin Czermin，后者转任这家德国公司的执行董事长。Werner此前在digit solutions GmbH担任董事总经理，并曾出任Logicalis Group DACH首席执行官八年。Czermin表示，此次交接经过仔细准备，标志着公司发展进入下一阶段；Werner称将在既有基础上，与团队继续系统拓展集团增长平台。 | 230ba92ebd0f / r2 / p0001, p0002, p0004, p0006, p0007 | 未提供 / 未提供 |
| Amazon signs PPA with Constellation for Maryland nuclear plant | 亚马逊与星座能源本周宣布签署长期购电协议，亚马逊将从马里兰州唯一核电站、位于卡尔弗特县拉斯比的1.78吉瓦卡尔弗特悬崖清洁能源中心采购电力。该协议为期20年、合计690兆瓦容量，并据称将促成超过30亿美元基础设施投资，包括电厂改进及约190兆瓦新增发电容量，将于2030年至2032年间投产。双方还签署相关零售供电协议，以支持亚马逊在覆盖13个州的PJM市场运营。此前亚马逊曾计划在该核电站旁建设大型数据中心园区，但于8月退出；文件显示项目规模曾超过246万平方英尺、约500兆瓦。 | 5a91b27b03cd / r2 / p0001, p0002, p0003, p0004, p0007 | 未提供 / 未提供 |
| 9.4GW SMR-powered data center campus proposed in Utah | 据NPR与《盐湖城论坛报》报道，Valar Atomics计划在犹他州卡本县普赖斯附近、土地管理局持有的逾9000英亩土地上建设“蜂巢计划”数据中心园区。NPR所见、公司向联邦监管机构提交的方案称，园区拟配套约456座小型模块化反应堆，电力装机或可达9.6吉瓦。据报道，建设最快或于今年年底启动，首批反应堆2028年上线、2032年建成，但目前尚无企业将此类反应堆投入商业运行。土地管理局犹他办公室向NPR表示正审查申请完整性，并须履行国家环境政策法程序；Valar向NPR称，取得许可与批准前不会开工。 | c902d70b216f / r2 / p0002, p0003, p0004, p0005, p0008 | 未提供 / 未提供 |
| SoftBank closes DigitalBridge acquisition | 软银集团本周宣布，已完成对DigitalBridge集团全部流通普通股的收购，交易金额约为31亿美元。由此，DigitalBridge成为软银集团的控股子公司，并将继续作为由现任首席执行官Marc Ganzi领导的独立管理平台运营，该交易不涉及DigitalBridge的任何投资组合公司。两家公司于12月宣布此项交易，DigitalBridge被私有化后将不再在纽约证券交易所上市。自收购之日起，DigitalBridge的财务状况和经营业绩将纳入软银的合并财务报表。DigitalBridge是全球主要数字基础设施投资者之一，管理资产规模超过1080亿美元。 | 86fe34bc9ad3 / r2 / p0002, p0003, p0004, p0005, p0006 | 未提供 / 未提供 |
| Sponsored: If you’ve got it, unlock it | 文章称，新建占2025年全球数据中心市场的61.8%，美国2026年建设支出自2024年近乎翻倍至853亿美元。Enabled Energy首席执行官Joe Staib强调，全球在运数据中心装机功率约120吉瓦，按典型PUE 1.5计，生产IT负荷约80吉瓦，电气与机械开销约40吉瓦。他指出，回收该开销的四分之一即可不新建而释放约10吉瓦，约相当于100座100兆瓦数据中心、占全球已装机基数约8%。他认为问题不在于必须现代化还是新建，而在于各站点适合何种定位、资本在何处创造最大价值。 | 793a3700c94b / r2 / p0024, p0025, p0036, p0038 | 未提供 / 未提供 |
| Google Gemini 4 Argon closes the gap with OpenAI and Anthropic but doesn&#039;t take a clear lead | 谷歌发布前沿模型Gemini 4 Argon，这是继Gemini 3.1 Pro后逾七个月来的首个前沿模型。文章称其缩小了与OpenAI、Anthropic的差距，但并未明确领先，Anthropic很可能仍居首位。目前先向Fairwind计划的“可信网络防御者”和内部团队开放且不设网络防护栏，属分阶段发布。介绍价为每百万输入token 2美元、每百万输出token 10美元；Artificial Analysis称其最高推理档Intelligence Index为53分，与GPT-6 Astra（max）及Claude Fable 5.1并列。 | 5c1de038bbe3 / r1 / p0001, p0002, p0004, p0006, p0012 | Matthias Bastian / 2026-09-30T22:06:30+00:00 |
| OpenAI and Synopsys team up to build an AI model that designs chips like a seasoned engineer | OpenAI与Synopsys已签署多年期战略合作，共同打造名为GPT-Synopsys的专用人工智能模型，用于芯片设计。该模型结合OpenAI技术与Synopsys的电子设计自动化工具，OpenAI将获得相关工具授权；目标是让模型能够推理芯片设计与验证并直接操作这些工具，工程师则提出设计目标并审核批准结果。据两家公司称，模型将运行在OpenAI基础设施上，客户数据不用于训练且加密存储，与半导体客户的早期测试已经展开，双方将共同营销并分享收入。Synopsys首席执行官表示人工智能可能显著加快设计进程，OpenAI联合创始人则认为这一合作有助于做出更好的芯片和更好的人工智能。 | 3178090395dc / r1 / p0001, p0002, p0003, p0004 | Matthias Bastian / 2026-09-30T19:12:30+00:00 |
| Google drops Gems for Skills, joining OpenAI and Anthropic in the shift to agent-ready prompt formats | 谷歌正在Gemini聊天中全球推出“Skills”，用以取代Gems；Gems相当于OpenAI的Custom GPTs，而OpenAI也在停用该功能。Skills是面向特定任务的详细提示，可由人工智能协助编写与优化，其格式源自Anthropic并作为开放标准提供。个人账户的Gems将于11月关闭，企业与非营利Workspace客户为2027年3月，教育客户为2027年6月，现有Gems将自动转换为Skills。 | bff25417261c / r1 / p0001, p0004 | Matthias Bastian / 2026-09-30T18:16:04+00:00 |
| Meta dodges billions in US taxes by calling its AI data centers experiments | Meta正通过将人工智能数据中心归类为“试点模型”、将英伟达芯片视为实验材料，利用联邦研究税收抵免节省巨额税款。据《纽约时报》报道，该公司2025年因此节省39亿美元，高于前一年的20亿美元及2023年的7亿美元，并成为所有上市公司中该抵免的最大受益者。这项抵免源于1981年法律，提出法案的议员向《纽约时报》表示，立法本意在于支持人力、知识与信息，而Meta的用法已远远超出当初想象。Meta以过去五年研发支出2000亿美元进行辩护，但公司在证券交易委员会备案中警告相关节省可能受到质疑，不确定税务状况准备金已跳升45%至187.4亿美元。 | 82c23d647b48 / r1 / p0001, p0002, p0005, p0006 | Matthias Bastian / 2026-09-30T17:22:34+00:00 |
| Optimization Is The Key Challenge For Quantum Computing | 据麦肯锡4月报告，量子计算已达商业临界点，气候与生命科学、出行物流及金融服务等行业企业已将其用于流程优化、情景测试和模拟，去年投资者向量子初创企业投入126亿美元。戴尔全球首席技术官约翰·罗伊斯称，量子计算并非一键开启，而是向可扩展、实用的容错系统稳步推进。他预计2028至2029年前将有足够纠错逻辑量子比特，可处理分子级优化等首批实际问题；到下一个十年初，系统有望应对更大规模优化。 | edb0d37f7945 / r2 / p0001, p0002, p0005, p0006 | Jeff Burt / 2026-09-30T12:27:56.000Z |
| Nvidia Wraps Security Layer Around Agentic AI To Stop Rogue Behavior | 英伟达本周推出开放智能体安全平台，把安全控制从智能体可及范围移出，改由支撑基础设施实施监测与强制执行。其中，三月公布的开源运行时OpenShell以内核级沙箱落实访问策略，并配合Vera处理器在运行中约束行为；研究人员称，Sentry可在毫秒内隔离并停止越界尝试。黄仁勋在声明中表示，这一问题可通过“全栈工程”解决。该努力得到Anthropic等数十家公司支持，但OpenAI缺席；阿尔特曼表示，模型对齐仍是有待解决的科学问题，不能把安全仅仅视为工程问题。 | ff6ee5241fc9 / r2 / p0007, p0010, p0013, p0016, p0018 | Jeff Burt / 2026-09-30T12:00:58.000Z |
| Bowman, Modernizing Financial Regulation: Initial Observations from eSLR | 美联储负责监管的副主席鲍曼称，增强补充杠杆率修订于2026年一季度被八家美国全球系统重要性银行中的七家提前采用后，交易商资产负债表约束有所放松。据部分估算，六家交易商母行控股公司当季合计新增近5万亿美元杠杆缓冲空间。监管数据显示，交易商国债总持仓由调整期初约6000亿美元增至4月底逾7000亿美元，且增量主要来自此前缓冲最低、受约束更紧的机构。 | 7f16b6d0e5df / r2 / p0009, p0011, p0012 | Vice Chair for Supervision Michelle W. Bowman / October 01, 2026 |
| Jefferson, The U.S. Economy and Monetary Policy | 杰斐逊在讲话中称，联邦公开市场委员会上月投票将联邦基金利率目标区间上调四分之一个百分点至3.75%至4%，他支持该决定，认为这有助于锚定长期通胀预期并及时实现2%目标。据其所述，8月个人消费支出价格指数十二个月变动为3.4%，通胀高于2%目标已逾五年；他预计短期内通胀仍将偏高，风险偏向上行。他并预计，失业率今年余下时间将维持在8月4.1%附近，经济活动与就业风险大致平衡。 | 6e026bc01c02 / r2 / p0013, p0009, p0012, p0007, p0008 | Vice Chair Philip N. Jefferson / October 01, 2026 |

## 预算与失败

- 显式第一轮repair选择21个ID（12旧full、7Decoder、2Fed），实际请求21，成功正文20，失败1，partial0，预算延后0。失败是 gmi-cloud-raises-668m-in-funding 的403，保留旧版本并降级。
- 迁移后业务请求累计 **26/48**；单源上限16。成功配额累计 **22/24**（保留修复前12个计数，旧正文修订不重计成功额度）。包括自动处理额外Decoder条目和2篇Fed元信息修订。解读为迁移后的计数，不能当成当天全部HTTP历史。
- 原诊断获得33篇响应样本（含BBC5），在请求计数迁移前独立抓取，未逐跳记录重定向成本；因此只能说至少33次请求，不能把业务计数冒充本次所有网络成本。后续capture脚本已接入同一Repository请求预算，默认dry-run，不重抓已有样本。
- deferred_count=71是沿用的历史累计延后次数，含前版本重复尝试；不是唯一文章数。当前待处理数量见API counts，不能把二者混报。
- 每篇失败/政策跳过/配额延后、模型超时或无效提要均独立保存。早期提要格式失败和超时已记录，只有当前通过校验的版本会被消费。

## 明确repair ID与保留版本

第一轮repair-job.json固定记录以下集合，未删除旧数据。列表包含后续Fed元信息修订；原12篇旧full的revision1及bodyHash均与前置诊断匹配。

| externalId | 当前状态/原因 | 保留修订 | 首版bodyHash前12位 |
|---|---|---|---|
| `nextplatform:5300701` | ready / structured_body | 1, 2 | 926abf9d75c3 |
| `nextplatform:5300157` | ready / structured_body | 1, 2 | 04689fc8a62b |
| `nextplatform:5300117` | ready / structured_body | 1, 2 | 950750bf44fc |
| `nextplatform:5300098` | ready / structured_body | 1, 2 | 58a395856852 |
| `dcd:www.datacenterdynamics.com/en/news/gmi-cloud-raises-668m-in-funding/` | failed / blocked | 1 | fdaa0fb7264a |
| `dcd:www.datacenterdynamics.com/en/news/ai-cloud-provider-blackfuel-emerges-from-stealth-plans-first-deployment-in-spain/` | ready / structured_body | 1, 2 | 2b4fe67b2f56 |
| `dcd:www.datacenterdynamics.com/en/news/data-center-in-kyiv-ukraine-suffers-critical-damage-and-goes-offline-after-russian-bomb-attack/` | ready / structured_body | 1, 2 | 95096abd1389 |
| `dcd:www.datacenterdynamics.com/en/news/xantaro-group-names-christian-werner-as-ceo/` | ready / structured_body | 1, 2 | 5192d20f11f1 |
| `dcd:www.datacenterdynamics.com/en/news/amazon-signs-ppa-with-constellation-for-maryland-nuclear-plant/` | ready / structured_body | 1, 2 | 89c6f6f0c388 |
| `dcd:www.datacenterdynamics.com/en/news/94gw-smr-powered-data-center-campus-proposed-in-utah/` | ready / structured_body | 1, 2 | dafaf495a0ed |
| `dcd:www.datacenterdynamics.com/en/news/softbank-closes-digitalbridge-acquisition/` | ready / structured_body | 1, 2 | 88fc47d8e46d |
| `dcd:www.datacenterdynamics.com/en/marketwatch/if-youve-got-it-unlock-it/` | ready / structured_body | 1, 2 | d113331b3d7b |
| `decoder:the-decoder.com/nearly-half-of-test-subjects-mistook-tavus-ai-video-avatar-for-a-real-person-on-a-one-minute-call/` | ready / structured_body | 1 | ba4923c0a2e7 |
| `decoder:the-decoder.com/ideogram-says-its-new-model-can-edit-part-of-an-image-without-messing-up-the-rest/` | ready / structured_body | 1 | 482c13568936 |
| `decoder:the-decoder.com/anthropic-brings-claude-to-civilian-agencies-as-its-fight-with-the-pentagon-drags-on/` | ready / structured_body | 1 | 1ddef71ae6ca |
| `decoder:the-decoder.com/security-startup-finds-more-than-13000-internal-company-screenshots-that-ai-agents-uploaded-publicly/` | ready / structured_body | 1 | 3b8bee043585 |
| `decoder:the-decoder.com/google-gemini-4-argon-closes-the-gap-with-openai-and-anthropic-but-doesnt-take-a-clear-lead/` | ready / structured_body | 1 | 5c1de038bbe3 |
| `decoder:the-decoder.com/openai-and-synopsys-team-up-to-build-an-ai-model-that-designs-chips-like-a-seasoned-engineer/` | ready / structured_body | 1 | 3178090395dc |
| `decoder:the-decoder.com/google-drops-gems-for-skills-joining-openai-and-anthropic-in-the-shift-to-agent-ready-prompt-formats/` | ready / structured_body | 1 | bff25417261c |
| `fed:www.federalreserve.gov/newsevents/speech/bowman20261001a.htm` | ready / structured_body | 1, 2 | 7f16b6d0e5df |
| `fed:www.federalreserve.gov/newsevents/speech/jefferson20261001a.htm` | ready / structured_body | 1, 2 | 6e026bc01c02 |

## changedPaths

以下只列本轮涉及文件，不把原有脏工作区的所有diff认作本轮改动；未提交或清理用户已有改动。

- config/media.json、config/media.default.json、packages/instance/src/media-config.js（原source媒体目录内容移入Instance配置）。
- packages/contracts/src/media.js、feed.js、report.js、index.js。
- packages/connectors/src/media/article-html.js、http.js、feed-xml.js、port.js、index.js。
- packages/database/src/migrations.js、repositories/media-repository.js、repositories/index.js。
- packages/domain/src/media-ingestion-service.js、feed-service.js、runtime-service.js、report-service.js、daily-brief-candidates.js、index.js。
- packages/runtime/src/media-enrich-module.js、media-brief-port.js；packages/source/src/content/definitions.js。
- packages/harness/src/harness-agent-runtime.js、launch.js、llm-route.js（仅内部短提要任务配置）。
- apps/web/src/server.js、routes/feed-routes.js、public/app.js；apps/worker/src/worker.js。
- package.json、package-lock.json（htmlparser2固定10.0.0）。
- scripts/audit-media-bodies.mjs、capture-media-samples.mjs、capture-media-extra.mjs、repair-media-bodies.mjs、verify-media-samples.mjs、verify-media-projections.mjs。
- test/media-ingestion.test.js、media-body-audit.test.js、harness-runtime.test.js、fixtures/media/*；personal-asset-ledger.test.js和work-package.test.js仅去掉锁死旧schema版本的断言，未改账本业务数据。
- docs/content-and-commit-guide.md、architecture-modules-v1.md、contracts-v1.md、release-readiness.md与本记录。

## 检查与剩余缺口

- 专项 node --test test/media-ingestion.test.js test/media-body-audit.test.js test/harness-runtime.test.js：67/67通过（媒体36项、Harness31项），含报告10反例、全部失败/混合失败、冷却/请求额度、旧full与partial修复、修订/304、RSS复用、API/UI映射、提要证据、日报候选、事务回滚与内部任务配置隔离。
- npm.cmd run check：syntax、source/harness语法、契约typecheck、架构和Harmony脚手架检查通过；测试609/611通过，仍失败2项。完整输出保存在Host check.log。
- launcher-boundary.test.js：用户已有启动器实现包含精确仓库入口的Win32_Process枚举，与旧“不得枚举node.exe”测试冲突。本轮不覆写其启动器改动。
- personal-asset.test.js：真实工作簿现有58期，旧断言期待57。本轮不改私人工作簿、不把测试强行写成58掩盖变化。
- DCD一篇实际403仍未补出新正文；FT授权、BBC用途限制与Techmeme未接入原站仍如实保留。未使用浏览器绕行、模拟凭证或虚构正文。
