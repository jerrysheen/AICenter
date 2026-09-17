# Cursor 设计规则落地

## 目标

把已整理的后续开发手册变成 Cursor 可明确加载的 `.cursor/rules/`，使后续会话默认知道设计思路、分层边界和接口规范。

## 完成

- `.cursor/rules/ai-center-required-reading.mdc`：始终应用；阅读顺序、冲突处理、B4 阶段、仓库身份。
- `.cursor/rules/layer-boundaries.mdc`：Route / Service / Repository / Connector 与数据所有权。
- `.cursor/rules/contracts-and-data.mdc`：Contract、Decimal、ID、时间、路径、分页。
- `.cursor/rules/jobs-events-migrations.mdc`：V6 不可改、事件命名、Capability/Job、禁止捷径。
- `.cursor/rules/ui-and-safety.mdc`：共用 UI、配对安全、用户执行步骤。
- `AGENTS.md` 与 `docs/README.md` 已登记该目录。

本轮只增加 Cursor 规则与文档索引，没有修改运行代码。
