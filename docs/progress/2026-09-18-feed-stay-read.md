# 外链回来停在原推文，已读下沉

## 目标

从社媒点开外部链接再回来，仍停在原来那条；阅读用 `isRead` 标记降低排序，左滑删除继续只隐藏。

## 决定

- 浏览位置、筛选和当前详情写入 `localStorage`，离开页面前（`pagehide` / 外链）保存；重启或 Web 无 hash 时恢复 `#feed` 并滚回该条，必要时重开详情。
- 点进详情或打开来源链接标记 `UserItemState.isRead`，不删 Capture。未读排在已读前面。
- 左滑「删除」仍是 `isHidden`：列表不再出现，库里原文还在。

## 验证

`npm run check`。
