# 用户主动引用

## 目标

把信息、灵感、知识和 AI 回答接到问答输入框，让用户指定的来源在进入 Agent 前确定性读取，而不是再搜一遍。

## 决定

- 不新增 Reference 领域。引用只是 `resourceType + resourceId + revision` 协议，由 Context Service `resolveReferences()` 跨域读取。
- 用户引用不是 Tool：不占用 Tool Budget，写入 `ai_run_context_refs.origin = selected`。
- 信息流 UI ID 与数据库 Resource ID 分开：`id` 仍是 `x:externalId`，`resourceId` 才是 UUID。
- 自动分组不做。知识组织下一轮再建模。

## 改动

- Contract：`CreateAgentRunInput.references`、`ReferenceInputSchema`。
- V15：`ai_run_context_refs.origin/label`，灵感 `source_type/source_id`。
- Feed / Knowledge 补按 ID 读取；Agent Job 把 resolved 文本放进当前轮用户消息。
- `POST /api/v1/notes/from-run`、`POST /api/v1/knowledge`。
- 前端全局 `state.referenceDraft`，信息/灵感/知识/回答可引用，问答框 chips 可预览、删除。

## 验证

- `npm run check`。
- 针对性测试覆盖 resolve、selected origin 落盘、不经 Tool 注入模型上下文。

## 后续

- 股票/持仓手工引用。
- 问答页把 selected / tool refs 分开展示；文末可跳转脚注已做，见 `docs/plan/ask-answer-source-footer.md`。
- 知识分组表。
- 问答输入 `@` 补全本地 Knowledge / 分析框架，写入同一套 `references` 协议。
