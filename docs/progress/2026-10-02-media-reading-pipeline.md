# 2026-10-02 媒体全文阅读闭环

接续 `2026-10-02-media-body-audit.md`。用户明确要求以「抓正文 → 全文翻译与排版 → 沿用 X Tag → 定时抓新文章」为验收目标，并指出 Techmeme 短句、宏观摘要和来源面板的混淆。以下是当前 Instance 在 2026-10-02T08:32:45Z 的真实核对结果，不替代前一份报告的历史观测。

## 当前结果

| 阅读频道 | 已验证全文 | 完整译文 | 已完成标签 | 摘要/发现线索 | 处理中 | 未取到正文 |
|---|---:|---:|---:|---:|---:|---:|
| 产业科技 | 21 | 21 | 21 | 18 | 13 | 4 |
| 宏观与国际 | 4 | 4 | 4 | 53 | 0 | 0 |
| 合计 | 25 | 25 | 25 | 71 | 13 | 4 |

25 篇全文共 458 个保存段落、484 个翻译分片（含标题）；11 篇原文超过5000字符，最长17591字符。逐篇核对当前 bodyHash、快照修订、分片 sourceHash、全部段落 ID/类型及末片覆盖。译文与当前正文逐段对应，不以旧摘要译文判定完成。标签记录使用当前 `tags_v1 / tag_v1`，分析时间不早于当前正文观测时间，标签 ID 均属于同一 Instance 目录。

| 来源 | 已验证全文 | 翻译分片 |
|---|---:|---:|
| Next Platform | 4 | 108 |
| Data Center Dynamics | 7 | 131 |
| The Decoder | 8 | 59 |
| Federal Reserve | 4 | 109 |
| Microsoft AI（Techmeme 原报道） | 1 | 35 |
| Matthew Green（Techmeme 原报道） | 1 | 42 |

宏观4篇均来自已有美联储来源：Bowman、Jefferson、Waller、Cook。BBC / FT 的53条线索保持摘要等级，不把 RSS 摘要或付费预览称为正文。

## 修复决定与兼容

- 发现原通用信息流本地化只处理单条前5000字符，保存的 sourceHash 却对应整条文本。媒体全文不再使用该短文本缓存判断完成；X 的现有流程保持兼容。
- `media-translation.js` 按保存段落切成最多2400字符的连续分片，每批最多16片/12000字符，复用 FeedService 与 `feed_item_translations`。缓存身份包含文章、正文哈希、标题哈希、段落与片号；只展示全部分片就绪的完整段落。正文或标题变化使旧缓存失效。
- `MediaArticleTranslationSchema` 运行时校验完整/部分/待处理状态和分片计数，禁止空译文冒充 ready。无需新增数据库迁移；已执行 migration 不改写。
- Tag 复用 X 的 TaggingService、Instance Catalog、Prompt、多标签和现有输入预算；不是第二套媒体分类。取得或修订正文后重新分析，保留现有 `truncatedForModel` 语义。全文翻译与 Tag 优先于可选提要。
- Techmeme 是聚合导读与链接发现，不是原报道全文。仅新增两家明确登记的原报道范围：Microsoft AI `/news/`、Matthew Green `/2026/`。Connector 校验 HTTPS、精确域名、路径、跳转和公共 DNS；Domain 建独立原文及 `discoveredVia`，重复链接不重复建文，关闭来源后不会再次自动启用。未开放任意原报道抓取。
- Microsoft AI 提取正文各 `.wysiwyg` 区块，排除组件、招聘和推荐；博客排除分享/相关文章区块。提取不执行页面脚本。
- 页面默认「全文」，摘要/发现线索单独筛选。来源设置折叠并说明各源能抓全文还是只收摘要；来源显示出版商名称。阅读页和原地展开均按标题、段落、列表、引文、滚动表格排版；支持中文全文、原文和逐段对照，提要收在全文之后。摘要条目按钮改为「展开线索」。文本使用安全 DOM 输出。

稳定规则同步在 `architecture-modules-v1.md` 与 `contracts-v1.md`。未新增业务 Agent、Runtime、数据库体系或桌面自动操作。

## 自动更新与实际任务

既有 Worker `media-index-sync` Schedule 已启用，每60分钟检查一次来源是否到期；各源维持自己的60/120分钟间隔。同步后去重入队固定 `media.index.enrich`，发现原报道、抓取正文、翻译和打标。服务运行期间自动执行；重启读取 SQLite 状态，已处理版本复用缓存，不重新翻译全部历史。

Instance 正文成功预算由24增至32篇/日，美联储由2增至8篇/日。全局48次HTTP请求、单源16次HTTP请求、原报道各2篇/日保持有界。本日已记32次正文请求、26次成功配额；两次原站诊断请求也计入预算。预算延后保留索引和下一日重试时间，不因预算调整清空旧冷却。

- 第一批明确26个ID：新增原报道2篇、复用既有21篇；3篇仍在原预算冷却。全文翻译428片完成，无待译分片。可选提要有1次失败，已持久化；另一个新原报道提要未生成，均不影响正文阅读。
- 第二批仅对3个明确ID有界 repair：美联储2篇正文、56片翻译和标签完成。Next Platform 条目实际链接是 `intelligence.theregister.com/paper/view/20987` 的第三方材料，域名未登记，白名单在HTTP前拒绝，不放宽策略伪装为成功。
- 可选有效提要现23篇；快照 / ContentItem / API 一致的正文投影26条，含一条保留但未验证的旧DCD正文。
- 仍有DCD一篇403、Decoder两篇付费预览；13条正文候选按原预算延后。失败与线索保留真实等级，不清空历史正文、译文或报告引用。

## 验证

- 媒体专项41/41通过：长文末句、结构与缓存、旧短译文排除、修订失效、分片缺失、X多标签、原报道白名单/路径/关闭/去重、Schedule推进及同步入队。
- `scripts/verify-media-reading.mjs --require-complete`：实际API与只读SQLite核对25/25全文译文和标签，包括所有分片及段落覆盖、当前Catalog/Prompt和标签新鲜度；Schedule启用。重启后再次通过。模型翻译的结构完整性不等于逐句语义质量认证。
- `scripts/verify-media-projections.mjs`：25篇已验证全文、23篇有效提要、26条正文投影一致；旧版本仍保留。
- Headless Edge 渲染1440px桌面和390px手机：默认全文、来源折叠、正文760px/350px、无横向溢出；实际30段译文、30段原文对照与原地展开齐全。安全样例验证标题、列表、引文、表格、6个段落ID及HTML字面文本，未生成可执行HTML；12张摘要卡均显示「展开线索」。页面无JS异常。只进行无桌面鼠标/键盘操作的渲染测试，并拦截所有API写请求。
- `npm.cmd run check`：语法、契约typecheck、架构与Harmony检查通过，测试614/616通过。仍是原有两项失败：启动器精确仓库进程枚举与旧测试冲突；真实个人资产工作簿58期、旧断言57期。未改启动器或私人账本掩盖失败。最后阅读展开改动另外通过JS语法与上述真实DOM验证。

Host 的原站HTML、任务ID、逐篇JSON、截图和完整检查日志留在忽略的 `media-audit` 目录；本记录不包含正文全文、密钥或机器专属路径。

本轮涉及：`config/media.json`；Contracts `media.js / types.ts`；Connector `media/port.js / article-html.js`；Repository `media-repository.js`；Domain `media-translation.js / media-ingestion-service.js`；Runtime `media-enrich-module.js`；Web `app.js / index.html / styles.css`；`test/media-reading.test.js / media-ingestion.test.js`；`scripts/verify-media-reading.mjs`；架构、契约、发布门槛与本记录。未提交或清理原有工作区改动。
