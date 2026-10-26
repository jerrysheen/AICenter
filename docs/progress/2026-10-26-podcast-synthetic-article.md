# 2026-10-26 播客成稿改为提炼正文

新开的 YouTube / X 长视频整理仍按 `longVideoPartBounds` 切段，默认并发 8。每一段由 Gemma 26B 写一次通顺的中文正文：保留数字、人名、公司和立场，去掉口语和字幕碎句，并附上 hint 与 topic。不再先做忠实翻译，再改写第二轮。

Flash Lite 仍只用一次，失败时改由 Gemma 26B。这一次只划分章节：`title`、`start`、`partIds`，以及可选的一行 `oneLiner`。不再写「章节总结」列表，也不再把译文接在总结下面。

合并放在 `packages/domain/src/podcast-article-merge.js`，还没按试跑钉死：

- `chapter-concat`（当前默认）：`## 章标题`、可选一行导语，然后按 `partIds` 把各段正文接上。
- `point-compile`：段内多事点再由 Flash 统编。段产出不同，还没接。
- `flash-polish`：各段正文交给 Flash 统编润色。还没接，避免多打一轮。

`AI_CENTER_PODCAST_MERGE` 写成后两个名字时仍走 `chapter-concat`，状态里记下 `mergeRequested`。已经 `ready` 的稿，包括 `parallel-segments` 和 `chapter-dialogue`，不自动重写。还没写完、段上没有 `segmentKind: prose` 的，丢掉旧译文，用一次提炼重写。显式重跑仍用 `scripts/rerun-youtube-chapter-articles.mjs`。不新增 migration。只需要重启 Worker。

本地核对合并形状：

```text
node --test test/podcast-article-merge.test.js test/gemma-long-video.test.js test/youtube-article.test.js test/x-video-article.test.js
```

像 `_b3LfMflIGs` 这样的长集走同一条路径：N 段提炼正文加一次切章，正文是一篇按章接上的长文，不是「要点」加「译文」两层。要换已落库的一集，先重启 Worker，再 `node scripts/rerun-youtube-chapter-articles.mjs --video _b3LfMflIGs`。命令本身不调用模型。
