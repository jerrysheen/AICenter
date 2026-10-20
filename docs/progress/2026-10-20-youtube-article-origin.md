# 2026-10-20 YouTube 文章原帖、阅读位置和中文标题

YouTube 播客文章页可以打开原视频。页头和阅读菜单里的「原帖」在新标签页打开 `https://www.youtube.com/watch?v=视频`。小标题里的「主题（HH:MM:SS）」中，时间可以点，打开 `watch?v=视频&t=秒`。手机和桌面都用同一个入口，时间点的可点区域至少 44px。原标题仍留在采集元数据和单集 `title` 上；它和整理后的中文标题不一样时，文章页写「原标题：…」。

长文详情按文章 id 把当前小标题或段落锚点和相对阅读线的偏移记在浏览器 `localStorage`（`ai-center.article-read-position`）。再次打开时回到该锚点，并显示「已回到上次阅读位置 · 从头读」。滑到正文底部会清掉这条记录。「从头读」也清掉。短文不记。这不经过小时报的滚动恢复，`information-tree.js` 的返回位置没有改。

正文整理完成之后，只用 Gemma 26B 根据整理好的中文正文写一个标题，建议 15 到 30 个字，具体点出话题和核心信息。成功就替换内容条目的展示标题，单集原标题不动。失败、空标题或配额窗口都留着原来的标题；配额窗口记 `titleStatus=pending`，下一轮只补这一次，不重做正文。不走 Flash。不新增 migration。标题进度写在 migration 89 的 `article_state` 里。当前 schema 仍是 91。下一号仍是 92。空号仍是 63、79、80、82。不要重建数据库。

已经整理好的文章用回填补标题，每篇 1 次 Gemma 调用。先看会处理哪些：

```text
node scripts/backfill-youtube-article-titles.mjs --dry-run
```

再去掉 `--dry-run`。已经写成的会跳过，失败的下次再跑仍是每篇 1 次。`--limit` 默认 500。不要把这条放进 Web 或 Worker 的启动流程。

需要同时重启 Web 和 Worker，浏览器再加载一次。回填脚本另跑，不随进程启动。
