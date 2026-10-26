# 短帖的译文和标签合成一次 Gemma 调用

信息流新帖现在先打标、再排队翻译，短帖会打两次 Gemma 26B。开关打开后，需要中文译文、并且原文已经放进一个翻译窗口的帖子，只打一次，同时写入译文和标签。长帖仍分开。默认关闭，不回填旧帖。

## 决定

- `AI_CENTER_FEED_PREPROCESS_MERGED` 未设置、`0` 或 `false` 时，`feed.items.enrich` 与现在相同。只有 `1` 或 `true` 才走合并。
- 短帖按 `body || summary || title` 去掉空白后的长度。不超过一个翻译窗口才合并。窗口是 `AI_CENTER_TRANSLATION_CHUNK_CHARS`，默认 1500，范围仍是 400 到 2400。更长的帖继续先打标、再排队 `feed.translation.run`。
- 一次结构化调用返回 `item_id`、`translated_text`、`tags`。标签只根据这段原文，目录约束仍是 `tag_v3`。写入时提示词版本仍是 `tag_v3`，避免后面的打标因为版本不同再打一次。
- 译文写入现有的 `feed_item_translations`（`source_hash`、`engine`、`target_lang=zh`）。标签写入现有的 `resource_taggings`。空标签也写入，补扫不会反复选中同一条。
- 这一次成功之后，本轮不再给这条打标，也不再为它排队翻译。补扫和缺口补译沿用现有跳过：已有 tagging 行，或译文 hash 匹配且没有截断。
- 已经有完整译文，或已经有 tagging 行的，不走合并。缺的那一边仍由原来的路径补。
- 原文已经是中文的短帖不另造译文，只走原来的打标。
- 这一次失败（上游 5xx、限流、超过每分钟 token、不是 JSON、译文截断）只记 `[worker] feed-enrich preprocess failed` 和类别。这条退回原来的两步。文章整理路径上，打标失败仍不挡住 `prepareInformation`。
- 用量记一次，阶段是 `preprocess`，模型仍是 `gemma-4-26b-a4b-it`。单独打标仍记 `tagging`。
- 媒体索引的 enrich 不改。YouTube 仍不进翻译任务。任务名和入参不变。

## 改动

`packages/runtime/src/feed-automation-module.js` 在 enrich 里对合格短帖调用合并，成功的 id 不再进入本轮打标；有文章整理时，已写入的译文不会再被当成待译。没有文章整理时，这些 id 不再进入 `localizeContentItems`。`packages/domain/src/tagging-service.js` 解析 `{translated_text, tags}` 并写入 tagging。`packages/connectors/src/gemini-tag.js` 用现有 Gemma 路由打这一次，`usageStage` 记成 `preprocess`。不新增 migration，不新增任务类型。

## 验证

`node --test test/feed-preprocess-merged.test.js test/gemini-tag.test.js test/tagging.test.js`。开关关闭时不调用合并。短英文一次调用写入两张表，不再打标、不再排队翻译；补扫和缺口补译跳过。中文短帖只打标。长帖仍分开。调用失败或译文截断退回两步，`prepareInformation` 仍会执行。

`test/article-normalize.test.js` 的 “normalize branch queues title and summary for link items”，以及 `test/feed-automation.test.js` 的 “automatic translation is visible on the feed item id”，在未改的 main 上就已经失败。

## 部署

不要重建数据库。当前 schema 仍是 96。下一号是 97。空号仍是 63、79、80、82。默认关闭，不设这个变量就没有行为变化。要打开时把 `AI_CENTER_FEED_PREPROCESS_MERGED` 设为 `1`，只需要重启 Worker。Web 不用为这项重启。页面没有改。回退是去掉这个变量，再重启 Worker。旧帖不补。
