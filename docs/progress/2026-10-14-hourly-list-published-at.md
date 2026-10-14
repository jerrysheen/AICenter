# 小时报列表用原文发布时间

日期：2026-10-14

## 线上

总览「小时报」和 `#report` 的小时阅读都是同一类列表：按小时分组，下面是「金融 15 条」这样的栏目，每行是时间、标题、分类和「分享」。两篇原文的时间都显示成同一分钟，那是 AI Center 写入或生成的时刻。分类名（如「模型与技术」「综合」）和「分享」出现在未展开的行上。GitHub 上 `awesome-*` 清单的仓库更新也会进这些列表，标题类似「awesome-autoresearch 项目更新：新增 5 条」。

## 决定

- 小时列表的排序和行上时间以原文 `publishedAt` 为准，新的在前。没有这个时间时才用首次入库时间。发布时间比现在晚两分钟以上时，改用入库时间；只有一两分钟的偏差则收到当前时刻。灰色「发布 HH:MM」去掉。
- 读出小时快照时补上原文发布时间。新评分的小时把这个时间写进快照。
- `awesome-*` 仓库更新不进小时候选，评分时跳过，已经在快照里的读出时去掉。判定只看两类：标题是 `awesome-* 项目更新`，或来源地址是 `github.com` 上仓库名以 `awesome-` / `awesome_` 开头的地址。其他 GitHub 仓库保留。
- 未展开的行不显示分类标签和「分享」。展开正文后才显示。总览小时行点进去仍是小时报，分类和分享在那边的展开里。

## 验证

`node --test test/awesome-list-noise.test.js test/home-timeline.test.js test/hourly-unread.test.js test/overview-home-p0.test.js test/reading-hour.test.js test/share-card.test.js test/flash-sources.test.js`

## 重启

需要同时重启 Web 和 Worker。浏览器再加载一次。不新增 migration。不要重建数据库。
