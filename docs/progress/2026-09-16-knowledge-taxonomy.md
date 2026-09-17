# 知识结构化与 Taxonomy

## 目标

让 AI 能按冻结的 Structured Artifact 契约整理回答，回填灵感或知识，并挂上多维 Taxonomy；来源仍由服务器记录，不让模型编 ID。

## 决定

- 不新建领域。Taxonomy 属于 Knowledge。`thesis` 是 `knowledge_type`，不是 Thesis 域。
- Key 语法：`{dimension}.{segment}`，kebab-case。同一 dimension 最多一个 primary。
- 分类挂在知识文档 / 灵感上，不挂 Revision。
- AI 禁止创建节点；最多 1 条 `taxonomy_proposals`，parent 必须已存在。
- `POST /api/v1/notes/from-run` 与 `POST /api/v1/knowledge/from-run` 改为入队 Job，返回 `{ jobId }`。

## 改动

- Contract：`TaxonomyNode` / `StructuredArtifact` / from-run Job。
- V16：`taxonomy_nodes`、`resource_taxonomy`、`taxonomy_proposals`，以及 `notes.title` / `inspiration_type`、`knowledge_items.knowledge_type`。
- Seed 约 100 个节点，含 market / asset-class / platform。
- Job：`inspiration.from-run`、`knowledge.from-run`；问答 Agent 可用自然语言调用 `memory.save`，整理当前会话后落库。
- 问答页按钮仍可对单条回答入队整理任务。

## 验证

- `npm run check`
- 针对性测试覆盖 key 语法、未知 key 回退父节点、taxonomy 过滤检索、Worker 回填知识。

## 后续

- 分类建议的采纳 UI。
- Agent `knowledge.search` 在问答里主动带 taxonomy。
- 不引入图谱、Vector DB 或自由 Tag。

## 2026-09-16 回执误落盘

截图里「已落库」那条不是合格灵感正文，而是把对话回执又存了一遍。真正结构化的假设已另有记录。现在 `sanitizeStructuredArtifact` 会拒收回执正文；灵感卡片用标题 + 类型/分类标签；左滑删除灵感，知识库同样左滑删除。
