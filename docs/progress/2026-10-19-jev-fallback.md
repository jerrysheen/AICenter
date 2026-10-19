# 2026-10-19 TypeSafe 兜底

TypeSafe 从 2026-10-18 08:18 起返回 HTTP 402。`AI_CENTER_FEED_FILTER=enforce` 且规则为 `all-three-0.60` 时，X、雪球和媒体抓取停在 REVIEW / `jev-failed`，信息流和阅读小时没有新内容。

## 开关

- `AI_CENTER_JEV_ENABLED` 默认 true。设为 `false` 后，Web 和 Worker 不再创建或调用 TypeSafe。旧的 `AI_CENTER_JEV_DISABLED` 以及先验、复核、证据门开关仍然有效，但全局开关优先。
- `AI_CENTER_FEED_FILTER_FALLBACK` 默认开。`off`、`0`、`false` 时，jev 仍开启的技术失败恢复为全部卡住。全局开关关闭时，这条即使是 off 也走兜底。
- `AI_CENTER_FEED_FILTER_XFOCUS_MIN` 默认 `0.7`。

需要同时重启 Web 和 Worker。除 migration 85 的部分索引外，不改表结构。兜底标记写在 capture 的 `metadata_json`。

## 准入

只在 `isJevOutage` 为真时兜底：HTTP 401、402、403、429、大于等于 500，`TYPESAFE_TIMEOUT`，真实 fetch 失败的 `TYPESAFE_NETWORK_ERROR`，以及未配置客户端的 `TYPESAFE_UNAVAILABLE`。200 但没有 answers 是 `TYPESAFE_BAD_RESPONSE`。调用方主动 abort、400、404、422 和其他非白名单错误继续 REVIEW，原因 `jev-rejected`。预检（正文缺失、截断、缺上下文）仍然挡住。正常 jev 打分不变。连续失败计数只在 jev 成功时清零，预检失败不清零。

- X 关注流直接 KEEP，原因 `fallback-following` 或 `jev-disabled-following`。
- X 推荐流先排除广告用语。单独的「广告」仍算推销。不算推销的有：广告收入、广告营收、广告费、广告费用、广告支出、广告投放、广告业绩、广告业务、广告主、广告商、广告市场，以及后面不接「务」的「广告业」。`xFocus.focusScore` 达到阈值则 `*-xfocus`，否则命中 `config/x-focus.json` 关键词则 `*-keyword`。都没有则继续 REVIEW。关注流和推荐流的来源判断共用 `focusFeedFromSource`，没有标明关注流的 X 时间线按推荐流处理。
- 雪球、媒体、哔哩哔哩动态和其他来源直接 `*-source`。
- KEEP 时 `filterDecision=KEEP`，`filterApplied=false`，写入 `fallbackAt`，并保留原来的 `filterErrorCode` / `filterErrorStatus`。分数保持为空，不伪造 0.60。
- 全局关闭且没有放行时，原因是 `jev-disabled`，不再写成 `jev-failed`。
- 列表查询认 `fallback-*` 和 `jev-disabled-*`。原有按时间排序的索引仍然强制使用。

去重和抓取预检保持原样。翻译模型仍只用 Gemma 26B。搜索仍走 Grok。

关注流、雪球、媒体和哔哩哔哩动态在预检通过后会进入信息流。推荐流只有分数或关键词命中、且不像广告的帖子会进入。10 月 18 日以来已经记成 `jev-failed` 的抓取不会自动出现，需要跑下面的补评脚本。

## 阅读小时

FOCUS 问题遇到白名单故障，或全局开关关闭时，Gemini 阅读分组已经给出方向的材料直接记为命中（分数 1，原因 `reading-classification`）。400、坏响应和调用方 abort 不记命中。分组失败、预算推迟和缺分组仍按原原因留下，小时任务本身不因为 jev 抛错。

`feed.quality.refresh` 在开关关闭时不调用 jev。已经有 jev 分数，或判定已是 KEEP / DROP 的行保持原样。没有分数的行仍先走预检：正文缺失或被截断的继续 REVIEW，预检通过后才按兜底放行。开关开启时，白名单内的故障才改走兜底，已经成功的分数仍复用。jev 关闭期间不要在页面上点「质量刷新」：没有分数且预检通过的历史行会被兜底改写。

问答先验、复核和证据门在全局关闭时全部关掉，检索结果原样进入。资料召回的标签和相关性判断同样跳过。投资者材料里的 Gemini 问题集不是 TypeSafe，不受这个开关影响。

连续技术失败达到 20 次后，Worker 至多每 10 分钟打一行：信息流准入已进入兜底。X 焦点打分和自动点赞继续打原来的 `x-focus batch=` 与 `x-focus rescore` 日志。关注流和推荐流每轮展开截断帖后另打一行：截断数、尝试数、成功数、失败数，以及按类别计的失败原因。

## 补评

先看会放行多少，再真正写入：

```text
node --env-file=.env scripts/reevaluate-jev-captures.mjs --from 1792252800000 --limit 2000 --dry-run
node --env-file=.env scripts/reevaluate-jev-captures.mjs --from 1792252800000 --limit 300 --interval-ms 200
```

`--from 1792252800000` 是北京时间 2026-10-18 00:00。不传 `--to`，窗口一直开到现在。时间用抓取时间的毫秒。默认只处理状态为 `captured` 且 `filterReason=jev-failed` 的行。TypeSafe 恢复后可以用 `--reasons jev-failed,jev-unavailable,jev-disabled` 把另外两类也纳入，再配合 `--jev` 重评。按原来的发布时间或抓取时间排序，不改 `captured_at`。内容条目的 `created_at` 优先用抓取时间，没有抓取时间再用发布时间。信息树和阅读小时按 `ci.created_at` 归入小时，补刷只覆盖最近 24 小时；用抓取时间才能落进当时的小时。

媒体按 article 写入：带上 summary，作者用 `article.author`，没有则用 `publisherKey`，并记入文章去重。capture 和内容条目在同一个事务里写入。放行后的 id 批量进入信息树准备和 `feed.items.enrich`。翻译只走这一条任务里的 `localizeContentItems`（文章归一开启时由该任务自己入队），脚本不再另开一条 Gemma 队列。`--jev` 放行时写入 `filterScores`、`filterPolicyHash`、`filterCacheKey`、`evaluatorModel` 和 `filterRuleHash`，列表 SQL 才能选中。

大约 1721 条 X 内容会经 `feed.items.enrich` 进入 Gemma 原文翻译，每条只译一次。Gemma 每天 5000 次额度，正式运行用 `--limit 300 --interval-ms 200` 分批，不要一次把窗口打满。

全局开关为 false 时只套兜底，即使加上 `--jev` 也不会创建 TypeSafe 客户端。开关为 true 时，`--jev` 重新调用 jev，不加 `--jev` 则按 `fallback-*` 补放。

TypeSafe 恢复后把 `AI_CENTER_JEV_ENABLED` 设回 true 并重启。之后的新抓取重新走 jev；已经用兜底放行的条目保持 KEEP，除非再跑 `--jev`。把 `AI_CENTER_FEED_FILTER_FALLBACK` 设为 off 会让新的技术失败重新卡住。

## 索引

migration 85：

```sql
CREATE INDEX IF NOT EXISTS idx_captures_x_focus ON captures(workspace_id, captured_at) WHERE provider='x' AND json_extract(metadata_json,'$.xFocus.method') IS NOT NULL
```

`listXFocusPoints` 的内层 WHERE 使用同一条件，并用 `INDEXED BY idx_captures_x_focus`。旁边已有的 provider 索引否则会抢先被选中，部分索引用不上。
