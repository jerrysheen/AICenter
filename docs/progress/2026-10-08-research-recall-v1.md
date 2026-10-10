# 2026-10-08 研究 Tag 与日报材料召回 V1

## 当前链路

栏目 `tagId` 仍是信息节点上的单个分类，空值进入未分类。`resource_taggings` 仍是另一条多标签记录，按目录版本和提示词版本缓存，投影给模型时可以不带 description。`feed.tag.search` 仍先取最近 500 条再筛时间，而且只查 content-item。这些都没有改。

生产 `generateDaily()` 仍只读小时模块。`daily-editorial-v1` 是另一条隔离稿，本轮没有把它和生产日报接在一起。

## 本轮闭环

新增研究 Tag 和研究问题。Tag 定义、命中边界、排除边界进入模型输入。问题决定引用哪些 Tag、query 和回看范围。关键词只补充召回，不单独写成已支持的判断。

材料池先按信息节点、Feed、Media 的时间游标冻结，再做三路并集：研究 Tag、query、JEV 相关性。相关性不先用 Tag 或 query 过滤。摘要被判为材料不足时，才读已经落盘的正文。

配置用 `activate()` 原子切换。内容哈希变化才会发布新版本；只改版本字符串不会。一次运行固定当时的问题、Tag 和材料快照。已发布报告按 id 保留。定义已加载、当期补判、报告实际使用分成三个状态。

统一入口是 `createResearchRecallService().buildReport()`。隔离脚本和 `research.report.generate` 都走它。`AI_CENTER_RESEARCH_RECALL` 默认关闭；打开后只注册 Job，不添加调度，也不改 `generateDaily()`。

## 配置

- `config/research/ai-compute.json`：AI 算力与科技产业变化，三个子问题。
- `config/research/optical-export.json`：增补「国产光通信进入海外市场的条件是否变化」，新增 `overseas_orders`，复用认证和出口准入 Tag。

下一轮要加问题或 Tag 时，改增补文件或传入同结构对象，然后调用 `activate({ addition })`。确认 `states.definitionLoaded.contentHash` 与 `states.reportUsed.contentHash` 都是新发布，且旧报告 id 仍能读到旧哈希。未改定义的 Tag 会复用判断；定义变了的 Tag 会新增判断行。

## 验证

确定性测试：`node --test test/research-recall.test.js`，7 项通过。覆盖分页超过 500 的 Feed 和 Media、无 Tag、只有 query、只有相关性、正文补看、缓存、定义变化、无关 Tag、限流、重试、并发租约、运行中切换配置，以及「尚不能判断」。

隔离命令：`node scripts/research-recall-isolated.mjs`。它只读生产库，把最近 200 条信息节点复制到 `data/research-recall/isolated.sqlite`，不写生产标签、小时报或日报。

这次实际复制 200/200。关键词模拟不是模型实测：第一问 200 条都已检查，召回 60，其中 Tag 54、query 58、相关性 13。已检查不是召回率。第二问使用新发布 `2026-10-08.2`，复用了 800 条旧 Tag 判断，并召回 17 条。其中一条是第一问没有召回的旧材料：标题「摩根大通增持中际旭创H股持股比例至14.36%」，来源 content-item `7d97a617-7198-4c2a-8801-a74955b61e0f`，只命中新问题里的实体「中际旭创」，归在未验证线索，没有写成出口条件已经变化。`overseas_orders` 的关键词没有命中这 200 条。

同一窗口按发布时间另有 Feed 97 条、Media 13 条。隔离快照没有把它们全部复制进来，也没有把 7 日回看里更早的节点复制进来。Feed/Media 超过 500 条的行为由确定性测试覆盖。

真实 JEV 未执行。没有设置 `AI_CENTER_RESEARCH_RECALL_LIVE=1`，也没有把模拟结果当成实测。附件里的 100 条分层对照不在仓库里，评测函数已按 debug/holdout、random/hard 分开，但该实验未执行。

模拟两轮合计约 200 次进程内判断，没有供应商费用。第一轮耗时 1.7 秒，第二轮 0.6 秒。费用字段保持 null。

## 生产启用

1. 确认要使用的研究目录已经 `activate`。
2. 设置 `AI_CENTER_RESEARCH_RECALL=on` 后重启 Worker。这只注册 `research.catalog.activate` 和 `research.report.generate`。
3. 真实判断需要已配置的 JEV 凭证，并单独给出请求预算。不要换用聊天密钥或其他付费模型。
4. 不要把该 Job 放进现有日报调度，直到关键词模拟和真实模型的差异被接受。

剩余风险：关键词模拟会漏掉没有配置词的事实，也会把实体名称带回未验证线索。真实相关性仍未测量。隔离窗口没有覆盖全部 Feed、Media 和更早历史。
