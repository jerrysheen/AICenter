# 小时报导航，以及正式标签为什么进桶少

## 目标

底部「简报」停在小时报。金融、科技、个股这些目录标签要进到类目桶里。不要把没有标签的帖改挂成「X / 雪球」来充数。雪球 7x24 继续排除。

## 数量在哪一步掉的

本环境没有生产库，不能回放 10 月 28 日那一小时的真实行。代码把四步分开了：

1. 入库。类目候选仍按入库时刻，并排除 YouTube 和快讯名单（含雪球 7x24）。已经标成 DROP 或 REVIEW 的帖不进候选。
2. 打标。Gemma 写在 `resource_taggings`。信息树准备还会把一个 `tagId` 写在信息节点上，但类目以前不读这个字段。节点上有标签、表里还没有时，这一步被看成没打标。
3. 分桶。以前只取标签列表里的第一个，再经 `groupByTag` 收进父标签。后面的宏观、A 股、财报标签不进自己的桶。`groupByTag` 本身不把这些标签丢成待标注。
4. Flash。模型最多写 12 条事件，但没被写进来源的材料仍留在该桶，桶的条数不因此减少。

所以「正式桶很少」主要出在第 2 步和第 3 步，不是 Flash 把已经进桶的材料删掉，也不是 7x24 黑名单误伤 X 和雪球博主。

## 决定

- 一条材料上的每个目录内标签都进入对应桶。`groupByTag` 仍把子标签收进父标签。
- `resource_taggings` 没有这一条时，用信息树节点上的 `tagId` 补上。
- 每个小时打一行 `[worker] hourly-category-tags`。`ingested` 是候选数，`noTag` 是没有可用标签的数，`tagged` 是至少有一个目录标签的数。`finance` / `tech` / `stock` / `policy` 按 `directionByTag` 统计，个股另计 `corporate_results` 和 `corporate_financing`。`tags=` 里每一段是 `标签:打标数>进桶数`。`eventSources` 是事件里实际点到的来源数。
- 简报打开仍停在小时报，地址写 `?hour=`。没有材料的刊期仍是 `empty`。失败补跑不打开。

## 验证

`node --test test/hourly-category.test.js`

- 同时有 `ai_compute` 和 `macro` 的材料，AI 桶和宏观桶都有它。
- `resource_taggings` 为空、节点 `tagId` 是 `market_cn` 时，A 股桶有这一条。
- Flash 只引用了其中一个标签时，另一个标签的桶仍留下这条来源。

重启 Web 和 Worker 之后，下一轮类目小时的 Worker 日志里能看到上面那一行数量。已经封好的小时不会自动重写。
