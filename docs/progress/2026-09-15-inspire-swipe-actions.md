# 灵感左滑：置顶、转入知识库、删除

## 目标

灵感列表能在手机上左滑露出操作，不必依赖卡片上的链接。

## 决定

- 左滑露出三个按钮：置顶（再滑一次取消）、转入知识库、删除。操作条宽 168px，不超过半屏。
- 数据仍在本机 SQLite：`data/ai-center.db` 的 `notes` 与 `knowledge_items`，workspace 为 `local`。

## 改动

- 库：`notes.pinned` 迁移；`pinNote` / `deleteNote`
- API：`POST /api/v1/notes/:id/pin`、`DELETE /api/v1/notes/:id`
- 页面：灵感列表滑动层
