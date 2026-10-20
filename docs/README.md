# AI Center 文档索引

- `progress/2026-10-07-gemma-five-accounts.md`：五账号原文翻译、跨模型每账号 10 秒节流、Worker 五并发及本地无日上限。

- `progress/2026-10-07-gemini-hourly.md`：小时报独立 Google Harness 路由、共享配额及 19—20 点固定材料验收。

- `progress/2026-10-07-gemma-original-translation.md`：912项检查、安全重载和真实原文翻译落库验收。

- `gemma-original-translation.md`：Gemma 原文翻译（默认只用 26B）、Worker 排队、排版落库和无其他模型回退规则。

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

- `progress/2026-10-20-hourly-report-stall.md`：小时报变慢是 Worker 主线程被快照、X 入库和材料哈希堵住。持仓、官方看板和信息流快照改为 5 分钟，内容没变不重写。入库和哈希分批让出主线程。小时报分组并发 3，阅读分类并发 3，单次 60 秒，超时换密钥。最新小时单独占队列，旧时段补跑另开一位。截断改用更大的模型和输出上限，对半最多 3 层并记下次数，失败不缓存成整份失败。已发布版本不再反复补跑；非终态失败素材没变仍会再入队。主线程看门狗默认关闭。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-19-body-completion-unseen.md`：滑出首页 50 条的 X 正文待补全，以前次数和 24 小时都不会动。这一路成功抓到时间线、但这条不在结果里，也算一次，满 3 次或 24 小时就清掉 pending，判定不动。失败或空抓取不计。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-19-official-release-list.md`：官方发布列表在手动重定向后连续为 0。status 0 的不透明重定向不再当成空正文；列表页改跟随重定向并核对最终官网地址，失败打出错误类别。不可用快照不再缓存。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-19-body-completion-cap.md`：X 正文待补全最多 3 次或 24 小时，到了清掉 pending 并保留原来的判定。展开会点「显示更多」，状态页不再因为文本框溢出把全文继续标成截断。不新增 migration。需要同时重启 Web 和 Worker。
- `progress/2026-10-19-official-body-extract.md`：白宫正文不再停在栏目名上。gov.cn 只有附件时改用页面摘要和附件标题。重定向逐跳过白名单，最多 3 跳。看板每轮最多补 20 条短正文。回填脚本再跑时只处理仍不足 80 字的条目。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-19-official-body-backfill.md`：官方看板导入以前只写标题和链接，正文是空的。现在导入和镜像会回到原链接取正文。已经进库的用 `scripts/backfill-official-bodies.mjs --dry-run` 预览后再跑，不要先跑 `hide-short-official-items`。不新增 migration。需要重启 Worker。Web 不用为这项重启。

- `progress/2026-10-19-research-recall-budget.md`：研究召回的 120 秒预算到点就停，一次只送一条，未完成的留在原池，下一轮接着判断。当前窗口没判完不冻结 7 天回看。关键词至少要有一个锚点，两个字的标签词不再单独召回。不新增 migration。需要重启 Worker。Web 不用为这项重启。

- `progress/2026-10-19-hardware-snapshot-loop.md`：硬件报价快照每天一次，放在当天最晚一档采集之后。快照行补上 `observation_id` 索引。列表一次查出各系列当前行。Worker 在任务结束时记下事件循环卡顿时长。migration 91。需要重启 Worker。
- `progress/2026-10-19-bamboo-feed-quality.md`：截断预览仍送 Bamboo 打分，KEEP 标正文待补全并可再抓全文。小时报 Bamboo 命中线默认 0.35，公司题材可以同时问市场组。新导入的短官方正文仍不直接可见；已经进库的空正文先用 `scripts/backfill-official-bodies.mjs` 补原文，不要先跑 `hide-short-official-items`。关注流按价值展开截断帖，订阅同步能在时限内中止浏览器。同一小时报不并行，重启接着检查点。事件循环日志只在超过 200 毫秒时打印。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-19-author-backfill-busy.md`：作者回填的写事务改为 `BEGIN IMMEDIATE`，避免和 Worker 提交撞上时直接 `SQLITE_BUSY`。脚本按批把进度写到 `source-author-backfill.json`，中断后从最后一批继续，跑完再执行会从头再走一遍。不新增 migration。回填脚本直接再跑；正在运行的 Worker 重启后，采集写入才使用同一把保留锁。

- `progress/2026-10-19-hardware-snapshot-loop.md`：硬件报价快照每天一次，放在当天最晚一档采集之后。快照行补上 `observation_id` 索引。列表一次查出各系列当前行。事件循环卡顿超过 200 毫秒才记一行。migration 91。需要重启 Worker。

- `progress/2026-10-19-aborted-board-cache.md`：看板请求被取消时，半成品不写入缓存，避免盖掉上一版完整看板。`http://xavatar.imedao.com` 升成 https，回填脚本同样处理。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-19-request-size-avatars.md`：翻译请求先读完超限正文再回 413，字节上限对齐 200000 字。YouTube 正文不再自动翻译。雪球相对头像补到 `https://xavatar.imedao.com/`，用手动脚本回填。CSP 的 `img-src` 放行 `https://pbs.twimg.com` 和 `https://xavatar.imedao.com`。不新增 migration。需要同时重启 Web 和 Worker，浏览器再加载一次。

- `progress/2026-10-19-market-board-backlog.md`：看板超时会取消还没发出的 Yahoo 请求。同一键的 refresh 复用进行中的请求。默认超时 20 秒。`^HSTECH` 404 只跳过自己。不新增 migration。需要同时重启 Web 和 Worker。


- `progress/2026-10-19-youtube-podcast-article.md`：YouTube 单集正文默认用 Gemma 26B 翻译池整理成中文文章。已经是中文的字幕只整理。小标题按主题写，时间可以跟在后面。`article_state` 按段记下 provider 和 Gemma、Flash 调用次数。Gemma 同一次请求遇到上游 500 最多再换一把密钥。开关 `AI_CENTER_YOUTUBE_PODCASTS_ARTICLE` 默认关。不新增 migration。需要同时重启 Web 和 Worker。
- `progress/2026-10-19-bamboo-research-recall.md`：资料召回在 `AI_CENTER_CLASSIFICATION_PROVIDER=bamboo` 时，标签和相关性改成 noul 题。标签 0.60 命中。相关性由直接回答、相关背景、可核对事实三题加阈值得到 direct、background、irrelevant 或 insufficient。候选标签超过 12 个才按关键词预筛。不占信息流每日 7000，仍走研究任务自己的 400 次预算。TypeSafe 的 JSON 题面不变。不新增 migration。真实 JEV 对照没有历史结果。
- `progress/2026-10-19-market-flow.md`：股票子页最后增加「资金」（`#market/flow`）。南向净额和北向成交额只出现在这一页。北向沿用东财和港交所已有响应，净买入没有公布就不显示。migration 88 建 `northbound_daily` 和 `northbound_top10` 两张表。需要同时重启 Web 和 Worker，再按该说明补北向历史。

- `progress/2026-10-19-us-open-stale.md`：美股刚开盘的 5 分钟内，盘前报价不再标成红色「已过期」，顶部和美股观察写「盘中 · 等待报价」。盘前、盘后的 `asOf` 用报价自己的时间，行提示写盘前或盘后。不新增 migration。需要同时重启 Web 和 Worker，浏览器再加载一次。

- `progress/2026-10-19-bamboo-startlux.md`：Bamboo StartLux 作为可选分类 provider。默认仍是 TypeSafe。`AI_CENTER_JEV_ENABLED` 不变。设 `AI_CENTER_CLASSIFICATION_PROVIDER=bamboo` 后，信息流准入和小时报选题改走 Bamboo；问答先验和证据门默认 shadow。质量刷新默认不调 Bamboo，要设 `AI_CENTER_BAMBOO_REFRESH=1`。信息流准入每日上限 7000，只计准入。计数写在 `data/bamboo-usage-YYYYMMDD.json`，Web 和 Worker 共用，重启不清零。触达上限后当天其余走本地兜底。默认先到先得，可选按小时均分。目前免费。不新增 migration。需要同时重启 Web 和 Worker。真实对照在服务器上跑，仓库里没有密钥。

- `progress/2026-10-19-x-auto-like-tight.md`：自动点赞选条排除广告词、官号宣传和短帖。新增推广词只用于点赞。企业动态至少 0.9 才点。没有分类客户端时点赞门槛 0.9。`AI_CENTER_CLASSIFICATION_PROVIDER=bamboo` 时按有分类客户端处理，不抬到 0.9。`filterReason` 以 `fallback-` 或 `jev-disabled-` 开头的兜底 KEEP 不点赞。默认每天 8 次、每小时 2 次、间隔 15 分钟。任务连续失败 2 次自动停。配置版本 `x-focus-2`，趋势图仍接受 `x-focus-1`。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-19-quote-card-align.md`：股票页涨跌和标题跟总览卡片对齐。没有现价时走 `GET /api/v1/markets/quote`，10 秒超时返回 504。午间休市保持 `break`。总览数据没变不重绘，键盘焦点按代码恢复。名字先目录、再实时、再本进程记下的 A 股名字，最多 2000 条。不新增 migration。需要同时重启 Web 和 Worker，浏览器再加载一次。

- `progress/2026-10-19-us-premarket-quotes.md`：美股盘前、盘后价格进入看板，板块不再在这两个时段标成休市。新浪读取盘前字段，盘前优先新浪；Yahoo 盘前昨收改用上一个常规收盘。报价批改为 10 只、同时 2 路，失败的那一批重试一次再转备用。假日表覆盖 2026 和 2027，缺年份只警告一次。不新增 migration。需要同时重启 Web 和 Worker，浏览器再加载一次。

- `progress/2026-10-19-youtube-podcasts.md`：按博主抓取 YouTube 金融和 AI 播客。有字幕用字幕，没有就走现有 Gemini 转写。摘要不用 jev，翻译只用 Gemma 26B。不进小时报。总开关 `AI_CENTER_YOUTUBE_PODCASTS` 默认关。频道可写 `channelId`。补录窗口跑完后不再每天补录。转写器不可用时有字幕的集照常入库。migration 87 只加补录状态列。需要同时重启 Web 和 Worker。

- `progress/2026-10-19-jev-fallback.md`：TypeSafe 白名单故障或 `AI_CENTER_JEV_ENABLED=false` 时，信息流按关注流、推荐流焦点/关键词和其他来源放行。阅读小时在分组成功时直接命中。质量刷新在关闭时不改已有 KEEP、DROP 和分数。10 月 18 日 00:00（北京时间）起卡住的抓取用补评脚本按原时间放行，并注意 Gemma 每天 5000 次。关闭期间不要点「质量刷新」。migration 85 只给带 xFocus 的 X 抓取加部分索引。需要同时重启 Web 和 Worker。

- `progress/2026-10-19-mover-names.md`：股票总览领涨、领跌显示名字，副标是板块和代码。首屏快照带上板块。自选在同花顺兜底时先用目录名字，再用本进程记下的雪球名字。不新增 migration。需要同时重启 Web 和 Worker，浏览器再加载一次。
- `progress/2026-10-18-x-focus-steer.md`：X 抓取先给卡片打 7 个方向的分数。推荐流只展开相关度至少 0.75 的帖；关注流仍展开被截断的帖，每轮最多 8 条。自动点赞默认关。服务器必须设置 `AI_CENTER_HARNESS_HOURLY_PROVIDER=google`。migration 84 只建任务索引。需要同时重启 Web 和 Worker。
- `progress/2026-10-16-feed-report.md`：小时报主时间和排序改用入库时间，发布时间早于窗口时另写「发布于 …」，`timely=false` 放进默认收起的「旧闻补录」。信息流每个范围都显式设置 channel。首页和简报只读已发布的信息树日报，同一工作区缓存 60 秒，新一期发布后失效。bootstrap 仍带 `brief` 别名。小时变化时写入浏览器历史。从原文返回小时报时恢复该小时的滚动和展开。快讯入库时拆开 `【…】` 标题，不回填旧行。问答预览只去掉成对强调和行首标记。migration 83 只加索引。需要同时重启 Web 和 Worker。

- `progress/2026-10-16-southbound-flow.md`：股票页增加港股通南向资金。东财日度汇总和十大成交入库，港交所成交额做校验。migration 81 建 `southbound_daily` 和 `southbound_top10`。80 留给其他功能。需要同时重启 Web 和 Worker，再跑 `node --env-file=.env scripts/southbound-backfill.js --from 2021-10-16 --to 2026-10-16`。

- `progress/2026-10-16-author-view.md`：信息流最后一项是「作者」。migration 77、78。`AUTHOR_VIEW=0` 只隐藏页面和接口。需要同时重启 Web 和 Worker。上线先 `--dry-run`，再 backfill，需要的话 import，最后 recompute。Worker 每天凌晨重算近 30 天计数。

- `progress/2026-10-16-home-perf.md`：总览首屏改读 Worker 快照，页面并行拉各模块。阅读只补充有条目的前 4 个小时。缺报价立刻 `pending`，补拉超过 10 秒中止，页面重拉间隔逐步加长。A 股日 K 按上海日历日缓存，失败按 10 分钟、30 分钟退避，满 3 次当天不再试。看板下发 `session` 和 `marketOpen`。休市不标红。响应不下发 `timings`。不新增 migration。需要同时重启 Web 和 Worker。上线前在服务器跑 `scripts/measure-home-perf.mjs`。

- `progress/2026-10-16-market-translation-format.md`：事件概率的 Yes/No、不变、基点、百分比、区间和日期用规则译成中文，看板和提醒共用。规则覆盖不到的结果名用同一份词表交给 Gemma 26B，并单独入队。金额小于 1000 取整，涨跌带「个百分点」，标记价、资金费率、持仓量和稳定币总供应改为中文。官方来源名在入库时映射成中文，标题用 OpenCC 繁转简。结果名入队有 60 条上限，进行中的不再重复入队。提醒不在任务里同步调模型。上线前先跑 `npm ci`。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-16-nav-layout.md`：侧栏悬停高亮不再点完残留，「最近」改为「最近浏览」。总览右栏「官方」不再被左栏行高顶出空白，事件概率跟页面滚动，灵感页返回按钮不再把标题挤偏。纯前端，浏览器再加载一次。

- `progress/2026-10-16-polymarket-card-change.md`：事件概率卡片恢复大号概率和涨跌。序列还不满 24 小时时，只取观察清单里 1 小时到 27 小时之间最早的一点，并写「较 Xh 前」。数字 `changeBasis` 显示「较 4h 前」这类文案，没有该字段才是「较昨日」。`lastPrice` 为空时不显示「上次」。满 24 小时后自己回到「较昨日」。多个结果的卡片上面是领先结果，下面默认收起最多 3 个其余区间。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-16-twkr-sources.md`：台湾和韩国第一批来源各自抓取。新闻进入媒体索引，沿用 Gemma 26B 翻译。证交所月营收写入 `twse_monthly_revenue`，不进新闻流。migration 76。需要重启 Worker。

- `progress/2026-10-16-gpu-rent-daily.md`：GPU 租金增加按北京日历日汇总的历史。migration 75 建 `gpu_rent_daily` 和按捕获时间的索引，接在 Polymarket 的 73、74 之后。当天价格在接口里现算，并缓存 60 秒。历史只按时间范围读。回填靠前的日子可能有缺口。Ornn 的 H100 SXM、H200、B200 指数按美东结算日记入，页面注明仅供内部参考。需要同时重启 Web 和 Worker，再跑 `node scripts/backfill-gpu-rent-daily.mjs`。

- `progress/2026-10-16-polymarket-board.md`：市场原生看板直接读观察清单，不再被默认的 24 条截断。比特币同时显示 10 月和 11 月「下一期尚未出现」。H100 改为跟踪 10 月并在当天结束后滚到 11 月。观察清单和快照共用 45 秒缓存。`predictionLimit` 只截断其他场所。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-16-polymarket-discovery.md`：Polymarket 白名单标签每小时写入候选表，审核通过后才上页面。GPU 租金按月滚动。比特币月度区间同时保留本月和下一月，当前月结算后自动补再下一月。发布日每分钟只读当天的系列。告警只出现在页面上。migration 74。需要同时重启 Web 和 Worker。

- `progress/2026-10-16-feed-sync-source-progress.md`：订阅同步每分钟只为到期订阅各入队一条 `feed.subscription.sync`。单源默认 90 秒，到时留下已抓到的条目。新的一分钟不取消仍在跑的那一条。迟到的完成不会盖掉更新的租约。雪球不再排在一轮 X 抓取后面被整轮打断。`media.index.enrich` 默认 4 分钟交出剩余 id，最多 10 次。不新增 migration。需要同时重启 Web 和 Worker。
- `progress/2026-10-16-polymarket-watchlist.md`：Polymarket 改为固定观察清单，不再用标题关键词截前 24 条。每 5 分钟按配置里的 slug 批量读 `/events`，事件身份和概率点写入新表。页面改读这份清单，并显示较昨日。`AI_CENTER_POLYMARKET_LEGACY=1` 仍走原来的成交额排序。migration 73。需要同时重启 Web 和 Worker。

- `progress/2026-10-15-us-quote-keep-newer.md`：更旧的报价时间不能盖掉较新的价格。缓存从请求开始起最多 45 秒，下一分钟的快照会重新取。新浪期货的 `provider` 写成 `sina`。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-15-us-quote-minute-refresh.md`：美股报价大约每分钟更新。美股代码走优先队列，亚洲、全球资产、历史 K 线和 A 股 Yahoo 回退不再挡在前面。共享缓存默认 30 秒。HTTP 404 只跳过那个代码。Web 读快照时按 `fetchedAt` 重算 `stale`，页面落后超过 3 分钟显示「已过期」。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-15-etf-whale-index-method.md`：指数方法只写 `intraday`、`daily-approx`、`mixed` 或 `insufficient`，不再写空。2024、2025 工作日休市没有日线，重算后方法是 `insufficient`。日线近似只在最低价相对昨收跌超过 1%、收盘相对最低价反弹至少 1%、且收盘靠近当日高点时命中；单独的下影或放量不加分。不新增 migration。需要同时重启 Web 和 Worker，再跑 `signals --start 2024-01-02`。

- `progress/2026-10-15-us-market-yahoo-429.md`：美股看板在 Yahoo HTTP 429 之后停在几小时前的快照。看板和持仓每分钟各打一轮 Yahoo，共用一层报价：45 秒缓存、进行中请求合并、两次请求至少间隔 800 毫秒。429 按 `Retry-After` 退避并打日志。退避或失败时美股改走腾讯 `qt.gtimg.cn`，没有的再走新浪 `hq.sinajs.cn`。上一份价格默认保留 3 分钟，之后标 `stale`，页面写「已过期」和上海时间。美股常规交易时段超过 10 分钟没更新，快照先写入再标失败。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-15-etf-whale-index-daily-approx.md`：没有 5 分钟线时，指数形态用日线开高低收和成交额近似，`inputs_json.index.method` 为 `daily-approx`；有分钟线时仍用原来的 5 分钟形态。日线也没有时 `sIndex` 为 null，接口和页面显示「数据不足」。信号写入会把 `insufficient` 里的分项强制写成 null，不再把 0 当成缺失。不新增 migration。15:30 的行情任务继续抓 5 分钟线。需要同时重启 Web 和 Worker，再跑 `signals --start 2024-01-02`。

- `progress/2026-10-15-etf-whale-backfill-sources.md`：指数日线和实际成交额先读腾讯 `newfqkline` 不复权日线。成交额在第 9 列，单位是万元，入库前乘 10000 收成元。长区间按返回的最早日期向前翻页。新浪 `__ERROR` 算失败。新浪、东财仍按这个顺序兜底。抓取失败写入 `etf_whale_fetches.status=error` 并打日志。回填打印每个上游的行数。中金所 URL 在 2026-06-25 之后没变；单日异常不再打断后面的日期。历史 404 页记 holiday。中信期货 `partyid` 0018 已核对。成交额或指数没有输入时，`sTurnover` / `sIndex` 为 null，并带 `insufficient`。不新增 migration。需要同时重启 Web 和 Worker，再按该说明重跑回填和 `signals`。

- `progress/2026-10-15-worker-dedup-scan.md`：小时去重不再对每条候选做 `source_url LIKE` 全表扫描。同一小时合成一次 NOCASE 前缀范围查询，并使用 migration 68 的 `dedup_key`。隐藏外部 id 走部分索引，最多 1 万条。领取时已达 `max_attempts` 的任务标失败，不再跑第 5 次。migration 72 只加索引。本机 5 万行、300 条候选从大约 2.3 秒降到 18–23ms。需要同时重启 Web 和 Worker。

- `progress/2026-10-15-worker-hot-loop.md`：Worker 主线程在 Gemma 配额 `retryAt` 已经过去时每 1ms 重做 SQLite 预约，把一个核打满，翻译请求停在 pending、没有 TCP。现在不足 250ms 的等待直接 `budget-deferred`，并带一个至少 250ms 之后的 `retryAt`；连续 8 次没有真正让出的等待会抛出。翻译租约过期仍马上重新入队、不占尝试次数，但不再删 `job_attempts`、不再把 `attempt_count` 减 1，改为把 `max_attempts` 加 1。本进程还在执行、且未到运行时限的任务不重新入队；从运行表拿掉时会中止旧执行。超过运行时限仍记 `WorkerRunTimeout`。启动补漏每轮最多扫 400 行，每页让出一次。Web 和 Worker 同时迁移时在事务里重查版本，`INSERT OR IGNORE`。日志仍写 `<dataDirectory>/logs`，并镜像到 stdout。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-15-etf-whale-score.md`：ETF 鲸鱼按 `gjd-score-v1` 打分。参考池 20 只，`588000` 只作对照。成交额、净申购、同时异常、指数形态各 25 分。单只成交额达到 8 倍时，同时异常至少 15 分，有红色标记再加 5 分，上限 25。初判在 15:30 行情之后，确认分在份额公布之后。`GET /api/v1/etf-whale/etfs/{code}` 是正式路径；`/series?code=` 返回同一份正文。不在观察池返回 404，格式不对返回 400。只读令牌新增 `daily`、`signals`、`series`。持仓和个人资产不开放。页面和接口写明「不构成投资建议」。不新增 migration，表在 migration 70。打分不在页面请求里现算。需要同时重启 Web 和 Worker。补数命令见该进度说明。

- `progress/2026-10-15-etf-whale-capture.md`：ETF 鲸鱼份额改为 T+1 的 09:00、12:00、16:30、18:30、20:30 补抓，补齐后当天后面的时刻跳过。15:30 抓日线、5 分钟线和实际成交额，17:00 抓中金所前 20 名持仓。交易日空份额记 pending，节假日记 holiday，超过 5 个交易日改 stale。深交所不再因为分段状态是 ok 就跳过未覆盖的窗口。xlsx 列宽改为逐格取最大列，避免展开爆栈；旧的栈溢出 error 在启动时改成 superseded，不删行。migration 70 只新增表。68 是文章去重，69 是硬件报价当前规格，71 是翻译用量归因。需要同时重启 Web 和 Worker。不要在启动时自动补历史；补数命令见该进度说明。

- `progress/2026-10-15-translation-call-cap.md`：一次翻译尝试的 Gemma 调用有硬上限，默认是条目数 ×（密钥数 + 换密钥重试次数）。83–240 字的单行标题不再因为译文偏短被判成没译完。正文和摘要每条任务默认 8 条、4000 字，处理每条之前续租约。`WorkerLeaseExpired` 不占尝试次数，马上重新入队。用量记下密钥后 4 位和条目 id。Worker 日志写到实例 `<dataDirectory>/logs`。migration 71。租约退回的做法见 `progress/2026-10-15-worker-hot-loop.md`。需要同时重启 Web 和 Worker。

- `progress/2026-10-15-hardware-price-labels.md`：闪存页 NAND 合约、NAND TLC 晶圆现货、MicroSD、SSD 合约和街价补上 USD 与表头对应的单位。週高點、日高點、均價和項目前缀不再写进规格名。数字不动，不删旧行，不新增 migration。解析版本 `trendforce-tables-5`。需要同时重启 Web 和 Worker，再跑一次 `feed.trendforce.reparse`。

- `progress/2026-10-15-hardware-price-units.md`：DRAM 合约里的 SO-DIMM 按条计价。内存条、显存、晶圆、存储卡、SSD 和 NAND 合约价补上 USD 和对应单位，数字不动。列表只留带单位且有报价期的当前规格，旧行改为 `is_current=0`。每一项显示官网数据日期，超过 7 天标已过期，DRAM 合约写明「8 月下半月」。migration 69。需要同时重启 Web 和 Worker。

- `progress/2026-10-15-article-dedup.md`：新媒体索引和订阅源按规范化原文链接加发布者去重，已有的那条补上缺失正文，不再另建一条。小时报生成时用同一把钥匙再去重，跨小时也合并，留下 media 那条。已有行不清理、不回填。migration 68 只加列和索引。`AI_CENTER_ARTICLE_DEDUP_TITLE_THRESHOLD` 默认 0.82。需要同时重启 Web 和 Worker。

- `progress/2026-10-14-translation-gap-read.md`：媒体列表按标题哈希和标题块 id 读出补漏译文，不再因为展示正文哈希对不上而标 stale。补漏按可配置时间窗口扫描缺译条目，默认至少 72 小时，每轮仍限制入队数；终态失败在递增间隔后重新入队。`feed_translation_chunks` 仍是续翻缓冲，全文落库即删除，健康部署后 0 行是预期。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-14-translation-batch-persist.md`：一批翻译里每条成功就写入 `feed_item_translations`，任务只把失败条目重新入队。长文已完成的段仍写入 `feed_translation_chunks`，重试跳过这些段。单行标题每批最多 5 条。Worker 定时把 pending 或 partial、且没有排队或进行中任务的条目以 -10 补入。不新增 migration。需要同时重启 Web 和 Worker。浏览器再加载一次。

- `progress/2026-10-14-gemma-upstream-backoff.md`：Gemma 仍只用 26B，`thinkingLevel` 保持 `minimal`。HTTP 500/502/503/408 立刻换下一把密钥；同一密钥连续失败才按 10 秒起翻倍退避，上限 40 秒，成功后清零。Token 只记 `usageMetadata`。每个密钥每分钟 25 次，同密钥间隔 2–3 秒随机。状态码、次数、间隔、退避和重试次数都可由环境变量改。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-14-access-log-plaintext.md`：访问日志每一行在原有 `client` 哈希、`ua` 分类和 `cfRay` 旁边写下明文 `ip`、`country` 和截到 300 字的 `userAgent`。`ip` 优先 `CF-Connecting-IP`，否则 `X-Forwarded-For` 第一段，否则套接字地址。国家来自 `CF-IPCountry`。User-Agent 去掉换行和控制字符。仍写 `data/logs/access.yyyy-MM-dd.log`，不新增接口。不新增 migration。需要重启 Web。Worker 不用为这项重启。

- `progress/2026-10-14-official-media-queue.md`：媒体充实不再为每个 `h:` 正文块各建一条优先级 0 的翻译任务。正文块合成任务并降到 -10，列表标题和官方标题是 10。官方文号可以打开，短标题不再因缺少句号判成没译完。小时「展开」恢复可点，页面策略放行 Cloudflare 信标。不新增 migration。需要同时重启 Web 和 Worker。浏览器再加载一次。

- `progress/2026-10-14-ellipsis-lead.md`：译文或正文以 `…` / `……` / `...` 开头、下一句又从同一前缀开始时，阅读页、列表和摘要去掉这段前缀。启动时改掉已保存的正文和译文，并写 `[worker] ellipsis-lead`。上交所空的交易日不再当作已完成区间；回看 12 天时，2026-10-14 的空结果明天会再取。不新增 migration。需要同时重启 Web 和 Worker。浏览器再加载一次。

- `progress/2026-10-14-translation-truncation.md`：截断译文按长度比和句末重新入队，阅读页先显示完整的中文整理。长文不再把预览接在全文前，也不再读到 400 字就停。列表空正文不再提交 `feed/translations`。不新增 migration。需要同时重启 Web 和 Worker。浏览器再加载一次。

- `progress/2026-10-14-translation-feed-qa.md`：补译同时最多 2 条，配额等待也占着这份额，并给优先级不低于 0 的翻译留席。小时展开用译文，栏仍按入库。社媒按上海发布时间分组。列表刷新回到第一页，不再越刷越多。`x:` 形式的内容条目可以打开。不新增 migration。需要同时重启 Web 和 Worker。浏览器再加载一次。

- `progress/2026-10-14-reader-and-queue.md`：列表上中文正文不再留着英文标题。直接打开 `#article` 和简报走同一份内容条目，已有译文不再入队。补译让出一席给手机发起的翻译。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-14-translation-chunks.md`：长文翻译每次只送一段，默认 1500 字，并记下段序号、字数和结果。一段 500 在段内退避，已完成的段写进数据库，任务重试从失败的那段继续。启动补译写明跳过原因。migration 67。需要同时重启 Web 和 Worker。

- `progress/2026-10-14-feed-translation-list.md`：社媒列表带上中文标题和摘要，中文来源不再标「暂未翻译」。阅读页用接口全文译文。超过 2 万字的帖会入队。Worker 启动最多补 80 条，可用环境变量改小。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-14-etf-whale-blobs-untrack.md`：`etf.whale.sync` 重写的 `data/blobs/etf-whale/` 不再进入 Git。页面只读 SQLite。拉取会删掉服务器上这些曾被跟踪的文件；要保留原始响应就先备份，等工作区干净并快进完成后再拷回。不新增 migration。不必为这项单独重启。

- `progress/2026-10-14-overlay-crlf.md`：Windows `core.autocrlf=true` 把 overlay 检出成 CRLF，`web.searchProvider` 的匹配只认 LF，问答在 1 秒内失败。解析先把换行收成 LF，写出的 overlay 也是 LF。`.gitattributes` 让 `*.yml` / `*.yaml` 按 LF 检出。不新增 migration。需要重启 Worker。

- `progress/2026-10-14-grok-web-search.md`：问答 `web_search` 只走 Grok。overlay 把 `web.searchProvider` 写成 `elucid-grok`，并禁用 `web-search-deepseek`。没有 Grok 密钥就报错，不回退 DeepSeek 搜索。`web.search` 事件记下实际 provider。不新增 migration。需要重启 Worker。

- `progress/2026-10-14-etf-whale-history.md`：ETF 鲸鱼单只序列改读路径里的代码。总览和单只 GET 对只读令牌开放。`etf.whale.sync` 默认每天上海时间 18:30 跑，并回看 12 天。指数日线走 `index_daily`，ETF 日线走 `fund_daily`，日 K 带 `amount`。缺交易日会丢掉缓存重取；收盘前不把当天未完成的柱写成完整日 K；开高低收不自洽的柱不入库。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-14-home-hour-fallback.md`：总览 bootstrap 的缓存键没有上海日期，昨天的正文会在 200/304 之后继续留在手机上。现在按日期分钥匙，窗口已结束的正文不再当成今天；仍是上一天就无缓存重取。缺小时仍回退到已有刊期。本地缓存最多 2 小时。日期和小时按上海 UTC+8 计算。小时任务仍在第 30 分钟入队，这次不提前。不新增 migration。需要重启 Web。浏览器再加载一次。

- `progress/2026-10-14-hourly-list-published-at.md`：小时报列表按原文 `publishedAt` 排序和显示，缺发布时间才用入库时间，过远的未来时间改用入库时间。去掉灰色「发布 HH:MM」。GitHub `awesome-*` 仓库更新不进小时列表。分类标签和「分享」只在展开后出现。不新增 migration。需要同时重启 Web 和 Worker。浏览器再加载一次。

- `progress/2026-10-14-scrape-chrome-default-profile.md`：日常 Chrome 不带 `--user-data-dir`。配置的目录等于 `%LOCALAPPDATA%\Google\Chrome\User Data` 时，这种进程算该目录已在使用，`--type=` 子进程不算，因此不另开第二只。`AI_CENTER_SCRAPE_CHROME_PROFILE_DIRECTORY` 会连同 `--user-data-dir` 传 `--profile-directory`。不新增 migration。需要重新运行 `scripts/start-ai-center.ps1`。

- `progress/2026-10-14-worker-claim-loop.md`：手动把 `jobs.attempt_count` 清回 0 后，领取按已有 `job_attempts` 的最大序号继续，避免唯一约束把领取循环打停。领取抛错时记下日志、只把仍在排队的那条标失败，循环继续。循环超过约 5 分钟没有往下走时打一行。空的订阅来源 id 改为跳过，不再每轮报错。不新增 migration。需要重启 Worker。

- `progress/2026-10-14-scrape-browser-guard.md`：采集走 BrowserSkill 扩展，不走 CDP。启动器在扩展未连接且 `.ai-data\chrome-profile`（或 `AI_CENTER_SCRAPE_CHROME_USER_DATA`）没有对应 Chrome 进程时拉起该目录。守护循环连续约 3 次仍无浏览器再拉起一次，并在启动器窗口打一行。不改页面。不新增 migration。需要重新运行 `scripts/start-ai-center.ps1`。

- `progress/2026-10-13-feed-x-flash-buffers.md`：X 的推荐、已读头和收藏第一页，以及快讯，只写出预备缓冲区。`pending` 只出现在这些槽还没有第一份快照时。翻页、报价 `snapshotId`、刊期和单小时阅读在 Web 的工作线程里查询并返回。事件推送改读 `sse_data`。migration 66。需要同时重启 Web 和 Worker。浏览器再加载一次。

- `progress/2026-10-13-google-fetch-dispatcher.md`：Google 直连改为使用 undici 自己的 `fetch` 和同一份 Agent。Node 内置 `fetch` 不再接收 npm undici 的 dispatcher。26B 默认和换密钥重试不变。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-13-gemma-26b-connect-timeout.md`：Gemma 原文翻译默认只用 26B。5xx、响应超时和连接超时在 26B 上换另一把密钥，不转到 31B。Google 直连增加可配置的短连接超时，和长响应超时分开。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-13-prebuilt-buffer-hit.md`：报价列表、雪球首页 / 7x24 和总览 bootstrap 的请求只写出已经预备好的缓冲区。没有缓冲区时返回 `pending`，不在请求里组包或序列化。大事件帧不再读出 payload。migration 65。需要同时重启 Web 和 Worker。

- `progress/2026-10-13-usage-http-gemma-retry.md`：信息树和阅读分类的成功调用记下 HTTP 200，模型执行超时记下 408。Gemma 翻译的 5xx 和超时换另一把 Gemma 密钥重试，失败日志带上输入长度、密钥后缀、耗时、并发和响应体。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-13-flash-sources.md`：雪球 7x24 和产业在线快讯不再进入小时阅读分类、JEV 和信息树。信息流增加「快讯」页签，按时间列出原文。名单在 `config/flash-sources.json`，可用 `AI_CENTER_FLASH_SOURCES` 整表替换。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-13-loop-wait-off-request.md`：硬件报价列表去掉原单元格并缓存已序列化的正文。雪球首页快照按写入时间保留 10 分钟，筛选列不再在请求里解析 metadata。事件推送把大 payload 分段写出。界面版本号并行读取文件时间。migration 64。需要同时重启 Web 和 Worker。

- `progress/2026-10-13-gemini-model-balance.md`：小时报和阅读分类按（模型，key）用量最少的一对先发，不再把 Gemini 3.1 用满才碰 3.5。文章模型池的轮换游标写入数据库。用量账本记下 HTTP 状态码。migration 61、62。需要同时重启 Web 和 Worker。

- `progress/2026-10-13-feed-sync-off-request.md`：X / 雪球首页改由 Worker 每分钟写入快照，请求不再做全表计数和正文解析。简报目录用 migration 60 的列，并缓存已序列化的缓冲区。总览在缓存到期前后台重算。需要同时重启 Web 和 Worker。

- `progress/2026-10-13-bootstrap-stringify.md`：总览 bootstrap 只留首屏，序列化和 gzip 在缓存填入时做完。X / 雪球列表不再为了列表去读正文。事件推送按几条一帧发送，没有订阅者时不读正文。favicon 从内存返回，缓存 7 天。需要重启 Web。

- `progress/2026-10-13-client-timing-behavior.md`：每次文档加载都把页面计时 POST 到 `/api/v1/runtime/client-timing`。点原文 / 打开原站记 `source.original`，展开条目记 `item.expand`。需要重启 Web。浏览器再加载一次。

- `progress/2026-10-13-frontend-load.md`：首屏改读 `GET /api/v1/home/bootstrap` 一份快照，浏览器按用户把页面响应放进本地缓存。事件循环阻塞按任务名写入 `data/logs/event-loop.*.log`。X / 雪球和硬件价表用短缓存，问答列表不再在别的页面上轮询。需要重启 Web。

- `progress/2026-10-13-event-loop-markets.md`：访问日志为每个请求记下这段时间里的事件循环延迟。静态文件和压缩 JSON 改为异步 gzip。行情总览和市场原生看板改由 Worker 每分钟写入 `runtime_snapshots`，Web 只读快照。不新增 migration。需要同时重启 Web 和 Worker。

- `progress/2026-10-13-feed-qa-fixes.md`：社媒刷新后已读仍留在列表底部，未读页翻完再翻已读。信息流「全部」合并手工、X、雪球和官方。「官方」切换立即清空旧列表，并丢掉过期的社媒响应。日报条目时间用条目自己的发布时间或入库时间。需要重启 Web。Worker 不用重启。

- `progress/2026-10-13-feed-query-perf.md`：X / 雪球列表走索引分页，TrendForce 列表只返回摘要并支持 ETag / 304，客户端计时改为 `text/plain` 上报，行为事件补上页签、文章、分享、小时、展开、原文、提问和慢页面。migration 59。已读游标仍只返回已读。需要重启 Web。

- `progress/2026-10-13-web-main-thread.md`：官方看板和持仓行情改由 Worker 每分钟写入快照，Web 只读快照并做 45 秒内存缓存。访问日志每分钟记一次事件循环延迟。migration 58。需要同时重启 Web 和 Worker。

- `progress/2026-10-13-access-log.md`：Web 把每个请求写成一行 JSON 到 `data/logs/access.yyyy-MM-dd.log`，并提供只读汇总脚本和需设备登录的 `GET /api/v1/runtime/access-summary`。页面加载后抽样上报 Navigation Timing。需要重启 Web。Worker 不用重启。

- `progress/2026-10-13-social-feed-read.md`：信息流「社媒」打开 X / 雪球即记已读并写回内容状态，已读行沉到该页签底部。其他页签排序不变。不需要重启 Web。

- `progress/2026-10-12-hourly-pending-prep.md`：小时补跑会为本小时仍未准备好的来源入队信息准备，不再只重发刊期。连续准备失败记为 `prep-exhausted`，不再永远算进 pendingCount。窗口内的回扫按小时轮转，不总是补最新的两小时。需要重启 Worker。

- `progress/2026-10-12-hourly-pending-sweep.md`：定时小时任务在主小时补跑之后，再为最近 6 小时里仍有未处理或分类延后、且没有排队或运行中任务的刊期最多补 2 张 `edition-pending-sweep`。更早的小时不排，补跑不连环。`[worker] tree-hourly` 的 `finishReason` 写完整枚举。需要重启 Worker。

- `progress/2026-10-12-hourly-followup-hour.md`：小时补跑只排这次主小时。回补小时上的旧分类失败不再抢走补跑。刊期仍有未就绪来源时也会补一次。每次小时浓缩调用写一行 `[worker] tree-hourly` 到 Worker 标准输出日志，非配额失败换一把 key 再试一次。需要重启 Worker。

- `progress/2026-10-12-hourly-error-logs.md`：阅读分类失败会写下状态、错误名、响应片段、模型和耗时，每次调用正好一行。非配额失败换一把 key 再试一次。过了整点槽之后，未完成的小时在一分钟内补跑。Web / Worker 自己追加按日日志。需要重启 `start-ai-center.ps1`。

- `progress/2026-10-12-static-js-cache.md`：分享卡对 `markdown.js`、`qr-code.js` 的引用补上 `?v=`，静态服务只对带 `v` 的 JS 使用一年 immutable 缓存，没有 `v` 的 JS 改为 `no-cache`。需要重启 Web。Worker 不用重启。

- `progress/2026-10-12-hourly-batch-pool.md`：小时阅读分类把同一小时里未分类的材料攒满 `AI_CENTER_READING_CLASS_BATCH` 再调用。信息还在到达时不送出短批。每次分类调用和浓缩失败都写明批次、回退原因、状态、响应片段、模型和 key 后缀。启动脚本的日志泵改为队列写入，进程还在时日志不再停。需要重启启动脚本。

- `progress/2026-10-12-reading-class-batch.md`：小时报阅读分类按 `AI_CENTER_READING_CLASS_BATCH` 分批，默认 10。解析缺口只回退缺的条目；配额不拆批。信息树浓缩和小时报停用开关不变。需重启 Worker。

- `progress/2026-10-12-classify-batching-eval.md`：小时阅读分类的离线批量对照。脚本只读最近样本，用 Gemini 按 10/20/30 条一批分类，对照已有单条分类。不写库，不改小时报。

- `progress/2026-10-12-share-image.md`：分享「保存」在预览打开后即可下载，iPhone / iPad 走系统分享。问答分享是回答右上角小按钮，不再盖住正文。阅读页和小时报展开正文去掉 `[未抓取]`、`图片 ×N`。日报日期按上海日历日分开格式化，窗口结束于 0 点时标在窗口内的那一天。小时报展开有来源地址时给出「原文」。重载 Web。Worker 不用重启。

- `progress/2026-10-12-hourly-disabled.md`：`AI_CENTER_HOURLY_DISABLED=1` 停用小时报。启动不把小时调度写成启用，不再自动入队，已排队的小时任务取消。需重启 Worker。

- `progress/2026-10-12-investor-digest-api-shares.md`：股民讨论日摘接口在方向样本不足时返回 `shares: null` 和 `insufficient: true`，仍保留 `counts` 与 `sampleSize`。见 `api.md`。

- `progress/2026-10-12-share-image.md`：日报和小时报单条可直接分享；小时报用本条标题和摘要，并去掉 `[未抓取]`、`图片 ×N`。问答分享用回答时间，表格画成网格，链接只留文字，按钮在回答顶部。媒体列表壳不再挡住已验证正文。问答历史卡片在手机上不再超出右缘。重载 Web；正文回退要重启 Web 进程。Worker 不用重启。

- `progress/2026-10-12-investor-digest-summary-retry.md`：股民讨论总结遇到 500/503/429 时换 Gemini key、指数退避，再按 `AI_CENTER_INVESTOR_DIGEST_SUMMARY_MODELS` 换模型。方向样本不足只显示「数据不足（n 条）」。占比超过 60% 的一侧不再写成「分歧明显」。可以只重试当天失败的标的。

- `progress/2026-10-12-gpu-price-sources.md`：AI Token 的 GPU 租金增加 CCIR、GPU Economy、Bargo。沿用异常价过滤，不新增 migration。见 `compute-prices-v1.md`。

- `progress/2026-10-12-share-image.md`：信息流、阅读页、小时报和日报单条，以及问答卡，共用一张分享图。长文始终是一张 PNG，倍率在面积和边长内从 3 降到 1.5，再不够就用放得下的最大倍率。卡片 CSS 宽 540。Web 重载一次以提供 `/qr-code.js`，Worker 不用重启。

- `progress/2026-10-12-readonly-api-tokens.md`：外部机器人用只读 Bearer 令牌访问白名单 GET。设置页生成和撤销，库里只存哈希。migration 57。见 `api.md`。

- `progress/2026-10-12-investor-digest-jev.md`：股民讨论日摘用 `config/jev-questions.v2.json` 逐条打是非题，代码计算加权多空占比。总结不再写情绪标签。旧日摘仍可读原来的情绪。migration 56 只增加题集版本列。

- `progress/2026-10-12-compute-price-filters.md`：AI Token 族只映射文本模型；RunPod 去掉无库存和过低占位价；Vast 按型号扩大查询，少于 3 条不展示并写出样本数。解析版本 `compute-prices-2`，不新增 migration。见 `compute-prices-v1.md`。

- `progress/2026-10-12-compute-prices.md`：全球行情「AI Token」保存 OpenRouter 每百万 token 价，以及 RunPod / Vast 的 GPU 小时租金。migration 55。Worker 默认每天 08:20 抓 token，每 6 小时抓 GPU。见 `compute-prices-v1.md`。

- `progress/2026-10-12-report-reliability.md`：小时报对 500/503 做有限退避并换 `AI_CENTER_GEMINI_HOURLY_MODELS` 的下一个模型；坏归属先修再换模型；同一小时失败到上限后停手。运行过久的任务释放队列。日报单组超时不再整期失败，当天缺刊会再试，并可用脚本补指定日期。

- `progress/2026-10-12-auto-deploy.md`：Windows 守护脚本按 `origin/deploy` 或最新 `deploy-*` 标签快进部署。只改 `apps/web/public` 不重启；失败回滚。异常写入 `deploy-status.json` 的 `state=error`。过期或非 PowerShell 的部署锁会接管。`GET /api/v1/runtime/deploy-status` 要设备登录。日志按天轮转和只重启 Worker 保持不变。

- `progress/2026-10-12-brief-truncated-manifest.md`：弱网截断的 gzip 不再被当成简报成功。200 的无效 JSON 会失败；没有 `pipeline` 的清单不进 30 秒缓存。失败时保留上一份有效清单，否则显示骨架和重试。只有服务端明确返回旧版 `pipeline` 才进入旧版简报。入口按钮改为「旧版简报」。

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
- `compute-prices-v1.md`：AI Token 与 GPU 小时租金的公开快照、报价日和日程。

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
