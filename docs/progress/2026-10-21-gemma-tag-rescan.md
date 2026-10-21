# 打标按上市地，并补扫没有标签记录的近期条目

## 原因

Gemma 26B 把宁德时代标成 `market_hk`。它是 A 股。中国移动多了 `ai_compute`，正文没有在讲 AI 算力。英文短标题没有展开半导体，也被标成 `semiconductor`。旧提示词写的是「不因为公司上市就打市场标签」，模型就按名称去猜别的市场，也会用标题里的一个词补上产业标签。

近期还有一些条目没有 `resource_taggings` 这一行。页面覆盖率读的是这张表。

## 决定

提示词改为 `tag_v3`。市场按上市地：正文在讲这家公司的股票、上市或行情时，宁德时代标 `market_cn`，不标 `market_hk`；中国移动若正文在讲其港股，标 `market_hk`。产业和主题只标正文明确在讲的内容。公司名、英文短标题、只出现一次的词，不能单独决定 `ai_compute` 或 `semiconductor`。

Worker 每 15 分钟补扫一次。只扫上线之后入库、并且落在最近 2 小时里、还没有 `resource_taggings` 行的可见新帖，每次最多 20 条，再用现有的 Gemma 26B 打标。起点是 `AI_CENTER_TAG_RESCAN_NOT_BEFORE`，默认 2026-10-21 14:47（UTC+8）。上线前的旧帖不补。已经有记录的不重打。模型正常看完但没有给出标签，包括只回了有标签的条目、把其余漏掉，或者整批回了空的 `items`，补扫会为这些条目写一条空的 `resource_taggings`。页面覆盖率仍把空数组当成未打标，下一轮不再选中同样的 20 条。回复不是 JSON，或调用失败，不写空记录，下一轮再试。失败只记条数和错误类别，不挡住信息树。Bamboo 准入分类不动。

Flash Lite 两把模型都到了当日上限时，下次可跑时间再看 Gemma 26B 的预留。Gemma 现在就能打就立刻可跑；Gemma 也要等，就把 Gemma 的 `retryAt` 交回去，任务不会在 Gemma 延后时空转。

`AI_CENTER_TAG_RESCAN_HOURS` 是补扫窗口，默认 2 小时，可设 1–336。拉长窗口也不会扫到上线前入库的条目。`AI_CENTER_TAG_RESCAN_INTERVAL_MINUTES` 和 `AI_CENTER_TAG_RESCAN_LIMIT` 可以改间隔和条数，条数默认仍是 20。

不新增 migration。当前 schema 是 95。下一号是 96。空号仍是 63、79、80、82。不要重建数据库。

需要重启 Worker。页面没有改，Web 不用为这项重启。

## 验证

`node --test test/tagging.test.js`
