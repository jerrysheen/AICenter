# 小时报索引

`GET /api/v1/reports/reading-hour/index?startAt&endAt&scope=hour` 按 `startAt` 倒序返回窗口内已发布小时报。每条是 `{startAt,endAt,id,status,scored,candidates,selected,headline,generatedAt}`。`headline` 为 `{nodeId,title}` 或 `null`。

只连接 `reading_hour_heads.published_id` 和快照，按 `start_at` 落在 `[startAt,endAt)` 里查询。只有 attempt、没有 published 的小时不出现。窗口必须大于 0 且不超过 7 天。`startAt` 和 `endAt` 都缺省时按 Asia/Shanghai 当天 00:00 到次日 00:00 补齐，不再返回 400；只缺一端、非法数字或超窗仍返回 400。工作区与相邻阅读小时路由相同：`identity?.device?.workspaceId || 'local'`。总览首页请求带当天窗口和 `scope=hour`。

头条是第一条 `disposition==='hit'` 的条目。顺序与页面 `renderReadingDirections` 相同：大类（金融、产业个股、科技与AI、地缘政治）→ 子类 → 快照原顺序。排除「待分类」和 `out-of-scope`。不调用 `present()` / `getNode`。同一工作区、同一组已发布 id 命中进程内小缓存时不再解析快照条目。

没有改主导航、顶栏、分类、翻译、JEV、新闻筛选，也没有改小时报或日报的生成，以及 `reports/tree?view=index`。设计材料：小时报排版-v1.md、总览重设计-v2.md（v2.1）。

## 验证

`npm run syntax` 通过。`npm test` 1010 项：999 通过、10 失败、1 跳过。失败数没有超过 main 基线 10：analysis-skill 7、information-tree-next 1、model-usage 1（本机 Node 22.14 没有 `node:zlib` 的 zstd）、work-package CLI 1。
