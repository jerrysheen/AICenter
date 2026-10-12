# AI Center 文档索引

- `progress/2026-10-07-gemma-five-accounts.md`：五账号原文翻译、跨模型每账号 10 秒节流、Worker 五并发及本地无日上限。

- `progress/2026-10-07-gemini-hourly.md`：小时报独立 Google Harness 路由、共享配额及 19—20 点固定材料验收。

- `progress/2026-10-07-gemma-original-translation.md`：912项检查、安全重载和真实原文翻译落库验收。

- `gemma-original-translation.md`：Gemma 31B/26B 专用原文翻译、Worker 排队、排版落库和无其他模型回退规则。

- `feed-interaction-v1.md`：用户授权的 X 阅读页单条点赞试用；BrowserRuntime 精确定位、Worker 固定任务及重开原帖核验。

阅读顺序：

```text
仓库 README
  → 本文
  → content-and-commit-guide（内容归属与提交规则）
  → release-readiness（当前问题与验收）
  → architecture / modules / agent / contracts（稳定规则）
  → 专题文档
```

`plan/` 与 `progress/` 保留历史，不重新驱动当前开发。旧计划与已执行迁移记录不要批量删除。

## 当前

- `progress/2026-10-12-auto-deploy.md`：Windows 守护脚本按 `origin/deploy` 或最新 `deploy-*` 标签快进部署。只改 `apps/web/public` 不重启；失败回滚。`GET /api/v1/runtime/deploy-status` 要设备登录。日志按天轮转和只重启 Worker 保持不变。

- `progress/2026-10-12-investor-digest-ab-retry.md`：日摘离线 A/B 补拆批重试。B 默认每批 12，解析失败或条数不齐时对半再打；输入 token 改读 `promptTokenCount`；方向不足 5 条显示「数据不足」。仍不进线上日摘。

- `progress/2026-10-12-investor-digest-ab.md`：股民讨论日摘离线 A/B。方案 A 用固定是非题，方案 B 用逐条结构化标签，都不进线上日摘、任务和页面。10/12 原始帖子未入库，试跑要先重抓成 JSON。

- `progress/2026-10-12-hourly-failure-job-error.md`：小时浓缩和日报失败把脱敏后的 kind、code、message 写入 job 错误。Web/Worker 日志按天追加并保留 7 天。`-WorkerOnly` 只重启 Worker。Gemini 每日配额冷却到太平洋午夜；小时模型按 `AI_CENTER_GEMINI_HOURLY_MODELS` 顺序回退；冷却 key 会做小请求探针，选 key 优先用当天更空闲的。

- `progress/2026-10-11-investor-digest-waf.md`：股民讨论日摘遇到阿里云 WAF 挑战页时退避并重开行情页；请求间隔改为 2.5 秒；置顶或单条旧帖不再让当天讨论停页。浏览器锁最长持有 15 分钟。

- `progress/2026-10-11-investor-digest-fetch.md`：股民讨论日摘生产 partial 修复。日期窗口改认 `startAt/endAt`，浏览器会话串行，验证页单独停住。

- `progress/2026-10-11-investor-discussion-digest.md`：股民讨论日摘。按持仓和可配置主题从雪球讨论区拉取当天帖子与评论，用 Gemini Flash Lite 总结；独立存储和定时任务，不进日报生产链路。简报页新增「股民讨论」标签。

- `progress/2026-10-10-unified-news-list.md`：总览、信息流、小时报共用同一条新闻列表。小时报末尾直接列出未进主列表和时效不足的条目，日报句子不再截成一行，摘要渲染前解码 HTML 实体。信源目录可以进入 B 站。

- 首页和简报显示：时间轴链接取窗口开始小时；阅读小时索引不覆盖已有标题；标题全文换行。简报标签栏不透明并贴顶，切到日报时去掉地址里的 `hour`。搜索在简报页写「搜索简报」。手机底栏在简报页不高亮总览。页面不再展示命中、已处理、更新时间和未生成计数。

- `progress/2026-10-10-hourly-mobile-columns.md`：小时报在 700px 及以下仍用两列。左栏子分类固定 64px，右栏是加粗标题和细分割线。桌面仍是 88px 左栏。

- `progress/2026-10-10-overview-redesign-v2.md`：总览首页改成左栏今天时间轴、右栏四张行情卡和今日日报。事件报价挪到全球行情。行情卡用时段小字，不再单列更新时间。

- `progress/2026-10-10-hourly-condense-error-log.md`：小时浓缩失败时把脱敏后的错误类型、上游状态和输入尺寸写入 Worker 日志。任务对外仍是「小时浓缩临时失败」。

- `progress/2026-10-10-hourly-layout-v1.md`：小时报改成电脑竖列加正文，支持 `#report?hour=HH`，相邻小时预取，「其他」不再重复方向大标题。

- `progress/2026-10-10-feed-all-progressive.md`：`#feed`「全部」到来源齐之前不报最终条数；「重点」改拉已保存星标；股票页和全球行情去掉独立更新时间行与概览说明。

- `progress/2026-10-10-reading-hour-index.md`：小时报索引一次返回窗口内已发布小时的摘要和头条。

- `progress/2026-10-10-event-quote-24h.md`：事件报价每小时快照，以及面板上的「较昨日」点数差。没有约 24 小时前的快照就不显示。

- `progress/2026-10-10-deeplink-feed-schedule.md`：行情单飞 20 秒超时；`#feed` 与近期日程首屏取数；重点按合并前窗口补拉；股票页先出骨架。

- `progress/2026-10-10-translation-reliability.md`：翻译失败落库并退避重试，信息流失败态显示原文和「暂未翻译」，复用小时报译文，入库摘录清洗。

- `progress/2026-10-10-hourly-swipe.md`：小时报内容区按顶部小时栏的左右方向切换相邻小时，点选与滑动共用 `selectHour`。

- `progress/2026-10-10-public-auth-write-stall.md`：公网鉴权不再同步写最后在线，避免和 Worker 写锁一起堵住 Web 事件循环。

- `progress/2026-10-10-tree-index.md`：简报目录改为`view=index`，刊期索引在Repository投影，正文仍按刊期和文章按需读取；`view=reading`保留一个版本。

- `progress/2026-10-09-yt-tools.md`：YouTube / B 站音轨下载和本地转写，用来补平台没有 AI 字幕的情况。

- `progress/2026-10-09-audio-transcription.md`：长音频按每分钟额度切成等长 WAV 段，分密钥转写后按时间拼回正文。

- `progress/2026-10-09-etf-whale-parity.md`：ETF 鲸鱼资金的交易所份额回填与参考站对账。页面只读计算结果，不替代发布门槛。

- `progress/2026-10-08-research-recall-v1.md`：问题驱动的研究 Tag 与日报材料召回。隔离运行，生产日报和栏目 Tag 不变。

- `progress/2026-10-08-hourly-reading-actions.md`：小时报和日报点开单条后，返回与原文跟信息流阅读页一样；手机放在底部并隐藏底部页签。

- `progress/2026-10-08-daily-editorial-v1.md`：日报研究报告隔离稿。生产 `generateDaily()` 仍是小时模块浓缩；新稿未写入生产库，也未改接 Elucid。

- `progress/2026-10-07-analysis-skill-selection.md`：问答 `@` 选择本轮分析方法，第一份技能为美股涨跌原因探索；同一 Ask 执行器，不新增 Agent。

- `progress/2026-10-07-zaobao-world.md`：联合早报国际栏目接入现有宏观媒体链路，默认关闭；隔离库实采列表与 3 篇正文并复核去重。

- `progress/2026-10-07-hourly-ingestion-and-social-loading.md`：社媒首屏先显示已收录内容，小时树按首次入库归窗、不可变正文复用及16点/17点运行核验。

- `progress/2026-10-07-tree-ref-resume.md`：修复小时ref从站内原文或后台返回后版本标记失效、卡在读取中；正式浏览器连续阅读回归。

- `progress/2026-10-07-brief-navigation-performance.md`：手机简报/历史/旧版存档入口统一、目录内存缓存、不可变刊期批量读取与传输优化验收。

- `progress/2026-10-07-feed-normalized-reading.md`：主页社交Feed复用已有中文整理，修复已完成整理仍显示英文。

- `progress/2026-10-07-dual-main-model-and-translation-test.md`：正式3.1/3.5文章模型池、Gemma纯翻译对比与官方调用规则诊断。

- `progress/2026-10-07-gemini-account-model-pool.md`：五账号并发和同账号不同模型独立限流、Host模型切换接口及正式重载核验。

- `progress/2026-10-07-local-commit.md`：本轮信息树、Gemini整理、用量账本和已完成互动能力的提交范围、882项检查及本机运行产物边界。

- `ops/hourly-readiness-diagnostics.md`：小时信息未就绪逐篇原因、只读证据导出、历史刊期对照、队列/模型等待与吞吐口径；本轮核对见`progress/2026-10-07-information-readiness-diagnosis.md`。

- `progress/2026-10-07-hourly-publication-recovery.md`：提前空ready纠正、未结束小时防护、单篇准备与有限低优先补编、旧queued批次保留式拆分；850项检查及正式API/页面发布引用回读，积压仍有待补。

- `progress/2026-10-07-usage-tool-social-chain.md`：Harness问答用量工具、直接X/雪球信息准备入口及安全重载、实际问答/社媒小时回读验收。
- `progress/2026-10-07-tree-hour-repair.md`：四项最小修复、836项回归、实际采集/信息准备/小时发布与自动版本验证；指定时段与实例时钟差异另行记录。

- `information-tree-v3.md`：2026-10-06 用户授权的「单篇短文 → 小时模块 → 日报模块」链路、固定Skill、隔离回放与回退开关；新模式覆盖旧信息摘选设计，仓库默认legacy，本机Instance已按用户后续授权启用tree-v3。
- `progress/2026-10-06-tree-v3-next-round.md`：tree-v3.1审核修复、固定12篇对照、18份完整正文、全部重复、实际用量与本轮生产启动异常/恢复授权边界。

- `model-usage-v1.md`：用户授权的 Harness 原生用量复用、请求归因索引、直连补记与本机查询；费用未知不补零。

- `hardware-prices-v1.md`：用户授权的内容分流、结构化硬件报价与旧身份兼容规则。

- `content-and-commit-guide.md`：Core / Instance / Host 内容归属、默认模板和 Git 提交规则。
- `release-readiness.md`：0.2.0 基线候选、发布门槛、容易写错的现状对照。
- `architecture.md`：进程、数据与运行边界。
- `architecture.md#single-user-instance-边界`：Core / Instance / Host 的现行边界与兼容布局。
- `architecture-modules-v1.md`：模块依赖、端口、单 Agent Runtime。
- `architecture-agent-v1.md`：Ask Agent 冻结职责——Single Agent + Runtime Guardrails + Jev Quality Observer（Prior / Evidence Gate / Reviewer）。Jev 不指挥 Agent 想什么。生产执行器是冻结 `dsh-base` 0.1.6-alpha.2；本地循环只作测试/回退。Node < 22.18 用 `dsh-entry.js` 启动 Harness 子进程。
- `contracts-v1.md` + `packages/contracts/src`：可执行数据契约。
- `ai-development-guide.md`：如何在现有分层上改代码；当前停止线见发布门槛。
- `search-agent-v1.md`：Article Analysis Skill / 文章阅读冻结设计。同一套生产执行器（Harness）上的明确调用：阅读框架 + Domain Knowledge Tool + Harness 内置 web。不是第二个 Agent。专用搜索插件以后再设计。
- `article-analysis-v1.md`：当前 Job / API / 输入字段，设计以 Article Analysis Skill 为准。
- `product-v2.md`：现行信息架构与领域范围（已按实现校正，不是「尚未开工」清单）。

## 专题

- `feed-value-v3.md`：JEV 只判断保存价值、结构化采集完整性、入库后 Tag、版本缓存与 A/B/C 校准边界。
- `connection-and-pairing.md`：二维码、授权、自动重连；鸿蒙分享走本地 Outbox。
- `harmony-share-to-inspiration.md`：系统分享字段、鉴权与真机验收。
- `public-access-security.md`：可选公网 HTTPS、隧道和管理员隔离；Agent / Host 调用方能力平面。示例域名是占位符，不是真实部署。
- `ops/cloudflare-tunnel.md`：本机 `cloudflared` 安装与 token 落盘；域名和 Tunnel 仍在 Cloudflare 控制台创建。
- `ops/local-files-mcp-tailscale.md`：本机 Local Files MCP 经 Tailscale Funnel 给 ChatGPT 的配置提示；**不是** AI Center 公网入口，不含本机 Hostname。

## 历史（不驱动当前开发）

- `product-v1.md`：连接原型范围与验收，已完成。
- `backend-work-package-b.md`：工作包 B 骨架交付时的快照；「尚未包含」一节已过时。
- `plan/stage-2.md`：第二阶段工作包拆分。B4 关注同步不是当前下一步。
- `plan/contracts-draft.md`：冻结前草案；实现以 `contracts-v1.md` 为准。
- `plan/agent-runtime-p0.md`：单 Agent 立项计划；现行边界见 modules 与 `packages/contracts/src/agent.js`。
- `plan/ask-answer-source-footer.md`：问答脚注计划。
- `progress/`：按任务记录当时目标、决定、验证；与现行规则冲突时以稳定文档和发布门槛为准。

仓库根目录 `.cursor/rules/` 与手册对齐，改设计时同步更新。

## 旧仓库参考

- 旧 AI / AI-Hub 仓库只作 Adapter 参考，路径从环境变量读取。不得直接复制旧仓代码。

- `daily-analysis-v2.md`：用户授权的日报分层阅读、材料覆盖、追踪问题、阶段重试与版本引用。
- `information-digest-v1.md`：小时提炼底稿与逐项冻结引用，当前阅读正文为版本化方向文章；日报复用小时成果和完整底稿，旧主题稿/旧分析兼容读取。


- `article-normalize-pilot.md`：2026-10-07信息层一次中文整理的隔离原型与历史验收；后续正式接入见 gemini-article-normalize。

- `gemini-article-normalize.md`：同一Harness的Gemini四字段整理、三Key项目配额、限流与明确quota fallback；实际状态见对应progress。
