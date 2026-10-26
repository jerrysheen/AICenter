# 2026-10-26 播客目录与章节对话

`#podcast/<id>` 正文有至少两个标题时显示目录。标题按页面上已经渲染的 h2、h3、h4 收集，跳过每章重复的「章节总结」和「对话」。点一项滚到对应标题。宽屏（1200px 起）目录固定在正文左侧。更窄时目录不占首屏，左下角一个「目录」打开侧栏；699px 以内这个按钮抬到「返回播客」上面。下滚收起页头、上滚露出返回和速读的那一行不变。底栏仍是 `.reader-mobile-bar.is-quad`，文案仍是「返回播客」。外层不再挂旧的 `podcast-reader-exit`，清理时改认 `data-podcast-chrome="exit"`。

新跑的整理，以及下面这条重跑，按章写成「章节总结」再写「对话」。总结用现有的 `gemini-3.1-flash-lite`，各章标题和摘录一次送出；提示超过大约 8 万字才对半拆成两次。对话仍由 Gemma 26B 按章排版，说话人写成 `**名字**：`。模型若在对话开头再印一次章名，后处理去掉重复的 `#` / `##`，正文仍是 Markdown。标题仍只走 Gemma 26B。

Flash 总结失败且不是配额窗口或本轮截止时，改由 Gemma 写同一份 JSON。这一份放不进 26B 的额度时才按章分批，不回到以前按 180 字摘录切片。某一章对话失败时，仍按原来的方式改用 Flash 写这一章。配额窗口和本轮截止都不改走另一边，进度留着，下一轮只补缺的部分。

已经落库、状态里没有 `layout: chapter-dialogue` 的文章不自动重写，修旧稿仍走原来的小节和开头「要点」。要换新格式时单独排队，不在这条改动里批量重跑：

```text
node scripts/rerun-youtube-chapter-articles.mjs --video <id> --dry-run
node scripts/rerun-youtube-chapter-articles.mjs --video <id>
node scripts/rerun-youtube-chapter-articles.mjs --all
```

只排队 `status` 和 `articleStatus` 都是 ready 的集。它把这一集改回 pending，清空当天名额占用和已有分段，并标上 `chapter-dialogue`。原字幕留着。命令本身不调用模型。`--all` 会把每一集都排进现有的 `youtube.podcasts.article`，每天仍受 `AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY` 限制。X 长视频共用这条整理，新跑的也会变成同一格式；旧的同样不自动重写。

长视频样例的分段窗口仍是最长 7840 字、最短 5174 字，同一档仍是 6 段。新文章不再为开头「要点」单独花一次 Gemma。

不新增 migration。需要同时重启 Web 和 Worker，浏览器再加载一次。
