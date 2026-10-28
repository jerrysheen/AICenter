# 分类小时报

## 目标

小时报和信息流卡片分开。分类视图按 Gemma 已经写入的目录标签分桶，每个非空桶在已结束的小时里打一次 Flash，写出事件和原帖链接。旧的信息树小时刊期继续写，文章整理不关闭。

## 决定

- 分桶不调用模型。主桶是 `resource_taggings` 里第一个目录内有效的 `tagId`，再走现有 `treeCatalog` / `groupByTag`。没有行、空数组或全部无效时归入 `__untagged__`，显示「待标注」。一条材料只进一个主桶。
- 候选沿用小时报材料口，仍然跳过 YouTube、快讯源和现有噪声过滤。不读信息树节点上的 `tagId`。
- 封闭任务是 `hourly-category-brief`，不复用 `article-normalize`。输入只有窗口、分类和摘录（约 200 字），没有正文。输出必须是 `{categoryId, events:[{bullet, sourceIds}]}`，`sourceIds` 必须是这次输入的子集，事件最多 12 条。材料被截断时记下 `truncated`。
- 新表 `hourly_category_editions`（migration 97），文档 `formatVersion` 为 `hourly-category-v1`。同一工作区和小时起点覆盖写一份。`dualRun` 固定为 true。页面读取时把 `sourceId` 解成现有文章地址 `#article/feed:…` 或 `#article/media:…`，不把模型名下发到页面。
- `AI_CENTER_HOURLY_CATEGORY` 默认关闭。打开后，现有 `report.hourly.extract` 在信息树小时刊期返回后顺带写分类刊期；树刊期抛错时，只要任务已经带了小时起点，分类刊期仍会写，然后原错误继续抛出。阅读分类仍按原来的开关跑。
- 页面只在会话里的开关为真时画出分类块：一句事件，链到原文。开关打开后，同一小时分成「信息树小时」和「类目小时」两栏；分类刊期还没有、或这一小时没有分类条目时，树侧照常显示，类目侧留一句提示。开关关闭时不加栏、不加分类块。
- 观察只记日志，不新增模型调用。开关打开且这条小时任务写分类刊期时，Worker 打一行 `[worker] hourly-category-observe`，带上工作区、小时起点、材料数、桶数、待标注数和占比、本轮已经发生的 Flash 次数、耗时、分类刊期状态、同一小时信息树刊期是否存在及其状态、截断桶数。次数从已经写下的刊期数出来，不为此再打 Flash，也不改补跑或重试。

## 改动

- 分桶、校验和生成在 `packages/domain/src/hourly-category.js`。
- Flash 路由与 `hourly-brief` 共用小时模型，不改文章整理路由。
- Web：`GET /api/v1/reports/hourly-category?hourStart=`。开关关闭时返回 `enabled: false`。开关打开时，小时页用现有接口把两份刊期并排画出来。
- 观察日志在 `runHourlyCategoryAlongside` 写出，字段由已保存的分类刊期和手头的信息树刊期状态组成。

## 验证

`node --test test/hourly-category.test.js`

- `primary bucket uses the first catalog tag and groupByTag`
- `category brief output rejects sourceIds outside the input`
- `empty closed hour writes a ready edition and does not call Flash`
- `each non-empty bucket gets one hourly-category-brief call`
- `hourly category flag off keeps the tree hour and does not call Flash`
- `category brief reuses the hourly Flash route and does not replace article normalize`
- `category blocks render bullets and article links`
- `hourly category observe log records comparison fields and does not add a model call`
- `dual-run hourly page shows both sections only when the flag is on`

## 遗留

分类刊期和树刊期串在同一条小时任务里。桶多的时候，这条任务会多几次 Flash。开关关闭后不再生成，已写入的表留着。日报主路径没有改。
