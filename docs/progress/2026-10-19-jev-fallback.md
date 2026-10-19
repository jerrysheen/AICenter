# 2026-10-19 TypeSafe 兜底

TypeSafe 从 2026-10-18 08:18 起返回 HTTP 402。`AI_CENTER_FEED_FILTER=enforce` 且规则为 `all-three-0.60` 时，X、雪球和媒体抓取停在 REVIEW / `jev-failed`，信息流和阅读小时没有新内容。

## 开关

- `AI_CENTER_JEV_ENABLED` 默认 true。设为 `false` 后，Web 和 Worker 不再创建或调用 TypeSafe。旧的 `AI_CENTER_JEV_DISABLED` 以及先验、复核、证据门开关仍然有效，但全局开关优先。
- `AI_CENTER_FEED_FILTER_FALLBACK` 默认开。`off`、`0`、`false` 时，jev 仍开启的技术失败恢复为全部卡住。全局开关关闭时，这条即使是 off 也走兜底。
- `AI_CENTER_FEED_FILTER_XFOCUS_MIN` 默认 `0.7`。

需要同时重启 Web 和 Worker。除 migration 85 的部分索引外，不改表结构。兜底标记写在 capture 的 `metadata_json`。

## 准入

只在 jev 技术失败时兜底：`jev-failed` 和 `jev-unavailable`（401、403、402、429、5xx、超时、网络、未配置）。预检（正文缺失、截断、缺上下文）仍然挡住。正常 jev 打分不变。

- X 关注流直接 KEEP，原因 `fallback-following` 或 `jev-disabled-following`。
- X 推荐流先排除广告用语。`xFocus.focusScore` 达到阈值则 `*-xfocus`，否则命中 `config/x-focus.json` 关键词则 `*-keyword`。都没有则继续 REVIEW。
- 未标明关注流的 X 时间线按推荐流处理。
- 雪球、媒体、哔哩哔哩动态和其他来源直接 `*-source`。
- KEEP 时 `filterDecision=KEEP`，`filterApplied=false`，写入 `fallbackAt`，并保留原来的 `filterErrorCode` / `filterErrorStatus`。分数保持为空，不伪造 0.60。
- 全局关闭且没有放行时，原因是 `jev-disabled`，不再写成 `jev-failed`。
- 列表查询认 `fallback-*` 和 `jev-disabled-*`。原有按时间排序的索引仍然强制使用。

去重和抓取预检保持原样。翻译模型仍只用 Gemma 26B。搜索仍走 Grok。

关注流、雪球、媒体和哔哩哔哩动态在预检通过后会进入信息流。推荐流只有分数或关键词命中、且不像广告的帖子会进入。10 月 18 日以来已经记成 `jev-failed` 的抓取不会自动出现，需要跑下面的补评脚本。

## 阅读小时

FOCUS 问题调用失败，或全局开关关闭时，Gemini 阅读分组已经给出方向的材料直接记为命中（分数 1，原因 `reading-classification`）。分组失败、预算推迟和缺分组仍按原原因留下，小时任务本身不因为 jev 抛错。

`feed.quality.refresh` 在开关关闭时不调用 jev，只套用上面的兜底。开关开启时，技术失败的那一条也改走兜底，已经成功的分数仍复用。

问答先验、复核和证据门在全局关闭时全部关掉，检索结果原样进入。资料召回的标签和相关性判断同样跳过。投资者材料里的 Gemini 问题集不是 TypeSafe，不受这个开关影响。

连续技术失败达到 20 次后，Worker 至多每 10 分钟打一行：信息流准入已进入兜底。X 焦点打分和自动点赞继续打原来的 `x-focus batch=` 与 `x-focus rescore` 日志。关注流和推荐流每轮展开截断帖后另打一行：截断数、尝试数、成功数、失败数，以及按类别计的失败原因。

## 补评

先看会放行多少，再真正写入：

```text
node --env-file=.env scripts/reevaluate-jev-captures.mjs --from 1792311480000 --to 1792368000000 --dry-run
node --env-file=.env scripts/reevaluate-jev-captures.mjs --from 1792311480000 --to 1792368000000
```

时间用抓取时间的毫秒。脚本只处理状态为 `captured` 且 `filterReason=jev-failed` 的行，按原来的发布时间或抓取时间排序，不改 `captured_at`，所以旧帖不会插到信息流最前面。放行走原来的内容条目、作者关联和 Gemma 翻译队列。

全局开关为 false 时只套兜底，即使加上 `--jev` 也不会创建 TypeSafe 客户端。开关为 true 时，`--jev` 重新调用 jev，不加 `--jev` 则按 `fallback-*` 补放。

TypeSafe 恢复后把 `AI_CENTER_JEV_ENABLED` 设回 true 并重启。之后的新抓取重新走 jev；已经用兜底放行的条目保持 KEEP，除非再跑 `--jev`。把 `AI_CENTER_FEED_FILTER_FALLBACK` 设为 off 会让新的技术失败重新卡住。

## 索引

migration 85：

```sql
CREATE INDEX IF NOT EXISTS idx_captures_x_focus ON captures(workspace_id, captured_at) WHERE provider='x' AND json_extract(metadata_json,'$.xFocus.method') IS NOT NULL
```

`listXFocusPoints` 的内层 WHERE 使用同一条件，并用 `INDEXED BY idx_captures_x_focus`。旁边已有的 provider 索引否则会抢先被选中，部分索引用不上。
