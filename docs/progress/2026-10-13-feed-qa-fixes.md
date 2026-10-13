# 2026-10-13 信息流验收回修

## 目标

社媒打开后会变灰并沉底，硬刷新后这条却从列表消失，滚到很后面也找不到。信息流「全部」和「社媒」变成同一份列表。切到「官方」时，社媒列表还会停大约数秒。10 月 12 日日报每一条时间都是「10月11日 08:00」。

## 决定

- 社媒仍先取未读。未读游标还停在未读分区时，再取一页已读头，单独记下已读游标。画面上先显示当前窗口里的未读，再把已加载的已读留在底部。继续下滑时先翻完未读，再翻已读，两边都能到达。已读头请求失败时，未读列表照常留下。
- 「全部」合并手工、TrendForce、X、雪球和官方，不受社媒平台筛选限制。媒体仍在自己的页签。
- 切换页签时递增请求代次，先把列表换成「正在读取内容…」。代次已经变了的 X / 雪球响应不再写入、不再重画。
- 日报和小时报条目显示自己的 `publishedAt`，其次 `firstIngestedAt`、`eventAt` 或来源引用时间。和刊期窗口起点相同的时间不当作条目时间。信息树读取时，模块自己没有可用时间，就用下层条目的时间填到响应里，不回写数据库。

## 验证

`node --test test/feed-qa-fixes.test.js test/feed-social-read.test.js test/feed-presentation.test.js test/feed-list-pagination.test.js test/feed-all-progressive.test.js test/feed-scope.test.js test/overview-home-p0.test.js test/hourly-ingestion-clock.test.js`

## 遗留

需要重启 Web。信息树节点时间在 Domain 读取时投影，由 Web 提供。社媒分页、页签清空和页面上的时间在 `apps/web/public`，静态服务会按文件指纹改写已有 `?v=`。Worker 不用重启。
