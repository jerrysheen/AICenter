# 2026-10-28 播客成稿按事点块分段统编

默认仍是 A：`point-compile`。Gemma 26B 继续按段写 2～5 个事点。变的是统编：以前一次 Flash 吃下全部事点，长集后半的议题容易被并掉。现在按事点块分批写成带 `##` 的正文，再拼成一篇。

## 调用

- 每批最多 4 段。这一批事点正文超过 1600 字，也另起一批。一段自己超长就单独成批，不再往下拆事点。
- 短集一批写完，仍是一次 Flash。
- 每一批用原来的 `EPISODE_COMPILE_SYSTEM`。提示改成：筛掉口水、口头禅和重复；数字、人名、公司、股票代码、因果、风险、时间和立场写进正文；可以合并相邻叙述，不要把不同议题收成一句；不要为了写短丢掉后半段，也不要为了显得长而注水。篇幅跟着事点里的信息走。
- 多批时，用户提示写明「第 n 批，共 m 批」，只写这一批，不补没给出的议题。
- 各批按顺序接成一篇。不另开润色轮，以免再压一遍。
- 某一批不是带 `##` 的正文、是 JSON，或又写出「章节总结 / 对话」，整次统编作废，降级到 `chapter-concat`：Gemma 26B 切章，事点按 `partIds` 接上。
- 一轮被截止打断时，已经写成的批留在 `compiledBlocks`。下一轮只补没写完的批。
- 不设「成稿至少 N 字」。`compileCoverage` 只统计事点里的百分数、亿美元金额和股票代码有没有出现在正文里，缺了也不打回。

`AI_CENTER_PODCAST_MERGE=chapter-concat` 仍只切章再拼接。`flash-polish` 还没接，写成这个名字也走分段统编，状态里记下 `mergeRequested`。整集字幕一次成稿不在这条路径上。

已经 `ready` 的稿不自动重写。不新增 migration。只需要重启 Worker。

## 对一集

不要加 `--all`，也不要批量重跑。重跑会重新抽事点，写完才替换正文，所以先把这一集现在的正文抄下来。

```text
node scripts/rerun-youtube-chapter-articles.mjs --video <id> --dry-run
node scripts/rerun-youtube-chapter-articles.mjs --video <id>
```

命令本身不调用模型。重启 Worker 之后，现有 `youtube.podcasts.article` 按每天名额跑这一集。

对比时看这一轮事点里的数字、公司、因果、风险、时间，以及后半段议题，有没有写进新正文。`articleState.compileCoverage.missing` 是没写进正文的锚点，`compiledBlocks` 是各批原文。不要用汉字数当达标线。旧正文只用来看后半议题还在不在；事点是这一轮新抽的，锚点对的是这一轮，不是上一轮。

本地核对：

```text
node --test test/podcast-article-merge.test.js test/gemma-long-video.test.js test/youtube-article.test.js test/x-video-article.test.js
```
