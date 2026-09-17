# 灵感归档收口到 Knowledge Revision / FTS

## 结论

对照当前代码和 `data/ai-center.db`（schema V12→V13）：

- Source：`captures` / `content_items` 已持久化；本机库 345 条 Capture 的 `raw_artifact_path` 均为空。短文本阶段可继续用 ContentItem，Raw Artifact 仍标 P1。
- 灵感归档：旧 `archiveNote()` 只写 `knowledge_items` + `knowledge_links`，不写 revision / FTS。本机库尚无已归档知识，但代码路径会让 Agent `knowledge.search` 搜不到新归档。
- 连续问答：不需要再加 `chat_threads` / `chat_messages`。V12 的 `AiSession` + `AiRun.input_text`、`POST /api/v1/agent/runs` 的 `sessionId`、Runtime `priorTurns` 已经是同一套轻量会话。本轮只把载入历史从 8 轮提高到 16 轮。
- 数据库位置：启动脚本不改 `AI_CENTER_DATA_DIR`；`.env` 未设置该项时默认仓库根目录下的 `data/ai-center.db`。该文件存在（gitignore 的 `data/*` 会让部分扫描工具看不到）。

## 改动

- `archiveNote` 改为调用 `KnowledgeRepository.createDocument()`，再写 `knowledge_links.derived_from` 并更新 `notes`。
- Contract：`CreateKnowledgeDocumentInput` 可带 `source` / `sourceNoteId`。
- Migration V13：回填缺 revision / FTS 的知识文档，并补归档笔记的 link。
- 会话历史窗口：16 条。
