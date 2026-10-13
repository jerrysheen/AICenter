# 2026-10-13 社媒信息流已读下沉

## 目标

信息流「社媒」打开 X / 雪球后不记已读，已读条目仍按发布时间留在前面。全部、媒体、官方已有打开即记已读，并用未读优先或 `sinkMuted` 把已读/低价值留在后面。

## 决定

- 社媒正文还在加载时就调用既有 `markFeedItemRead`：列表项 `isRead` 立刻为真，并 `PATCH /api/v1/content-items/:id/state`。刷新后服务端未读优先分页仍认这条状态。
- 后台合并列表时，本地或服务端任一为已读就保持已读，避免刷新覆盖刚点开的标记。
- 只在「社媒」页签把已读行放到未读之后，并标成 `muted`，沿用 `sinkMuted` 沉到列表底部。其他页签的时间排序不变。

## 验证

`node --test test/feed-social-read.test.js`

## 遗留

不需要重启 Web。改动在 `apps/web/public/app.js`，静态服务按文件指纹改写已有 `?v=`。Worker 不用重启。
