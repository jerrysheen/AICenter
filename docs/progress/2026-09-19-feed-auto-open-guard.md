# 总览/信息流滚动时误开新闻

## 目标

总览时间线和社媒信息流会在没有点开的情况下进入新闻详情。

## 决定

- 左滑手势原先在 `pointerdown` 立刻 `setPointerCapture`，Harmony / 手机 WebView 随后 `pointercancel`；`attachSwipe` 把「按下后还没分出轴向」当成点击，于是提前 `openArticle`。
- `pointercancel` 和纵向滑动不再当作点击；横向滑动确认后才 capture。
- 总览时间线整卡是 `button`，短距离滚动结束后的残留 click 也会打开。改为 `attachGuardedOpen`，移动或 cancel 后忽略 click。
- 阅读页已改成 hash 详情。`restoreOpenFeedItem` 不再用残留 `dialogPostId` 把人从列表拉回详情。

## 验证

`npm test -- test/feed-open-guard.test.js`。总览或社媒列表上向下滑，不应再进详情；点标题仍进入。
