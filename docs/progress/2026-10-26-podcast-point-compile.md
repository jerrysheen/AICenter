# 2026-10-26 播客成稿默认改为事点统编

#239 先把段产出改成提炼正文，合并策略留着试跑，默认是 `chapter-concat`：Flash 只切章，再把各段正文接上。这次把默认改成 `point-compile`。

新开的 YouTube / X 长视频整理仍按 `longVideoPartBounds` 切段，默认并发 8。每一段由 Gemma 26B 写一次，返回 2～5 个简体中文事点，带上数字、人名、公司、股票代码和立场。提示写明 `$N billion` 换成 `N×10 亿美元`，例如 `$4 billion` 写成 `40 亿美元`，`$2.5 billion` 写成 `25 亿美元`。不再逐句翻译，也不先译再改写。

Flash Lite 仍只用一次。这一次按主题把事点写成一篇长文：每章一个 `##` 标题，数字和人名写进正文。不另起「章节总结」或「对话」。输入只有各段事点，不把整集字幕灌进去。

统编失败、额度不够、返回的不是带章正文，或又拆出「章节总结 / 对话」时，降级到 `chapter-concat`：Gemma 26B 只划分章节，再把事点按 `partIds` 接上。这一降级不再开第二轮润色。中途被截止打断时先停下，下一轮再试统编，不立刻改拼接。

`AI_CENTER_PODCAST_MERGE` 为空或 `point-compile` 走上面的默认。写成 `chapter-concat` 仍只切章再拼接。`flash-polish` 还没接，写成这个名字也走事点统编，状态里记下 `mergeRequested`。整集字幕一次成稿不在这条路径上。

已经 `ready` 的稿，包括 `parallel-segments` 和 `chapter-dialogue`，不自动重写。还没写完、段上不是合格事点的，丢掉旧译文，用一次事点重写。显式重跑仍用 `scripts/rerun-youtube-chapter-articles.mjs`。不新增 migration。只需要重启 Worker。

本地核对：

```text
node --test test/podcast-article-merge.test.js test/gemma-long-video.test.js test/youtube-article.test.js test/x-video-article.test.js
```

像 `_b3LfMflIGs` 这样的长集走同一条路径：大约 N 次 Gemma 事点加一次 Flash 统编。要换已落库的一集，先重启 Worker，再 `node scripts/rerun-youtube-chapter-articles.mjs --video _b3LfMflIGs`。命令本身不调用模型。
