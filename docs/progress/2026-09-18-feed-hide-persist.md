# 社媒删除后本机不再反复出现

## 目标

信息流左滑删除后，本机刷新、再拉取同一条社媒都不再出现。

## 决定

- 删除仍只写 `UserItemState.isHidden`，不物理删 Capture / ContentItem。
- 前端把隐藏键写入 `localStorage`，不依赖设备连接；PATCH 失败也不把卡片插回列表。
- ingest 与 snapshot 回退都按已隐藏 `externalId` 跳过，避免同一条推文因换分组或正文微调再次入库显示。

## 验证

删除一条社媒后刷新页面，该条不再出现。`npm test -- test/domain-foundation.test.js`。
