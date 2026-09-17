# 问答文末来源脚注

## 目标

工具或用户引用打到本地资源后，在回答文末列出可点击来源。不改模型返回，不做句级 `refN`。

## 决定

- 来源只来自已落库的 `ai_run_context_refs`。`projectAnswerSourceFooter()` 去重、分组、最多 24 条。
- 会话详情 API 给每轮带上 `sourceFooter`。页面不解析模型 Markdown。
- 跳转按 resourceType：信息详情、灵感/知识卡片、网页 URL、持仓/市场页、其它会话。

## 改动

- `packages/domain/src/answer-source-footer.js`
- `packages/domain/src/knowledge-service.js`：`getAiSession` 附带 footer；`getDocumentForView`
- `GET /api/v1/content-items/:id`、`GET /api/v1/notes/:id`、`GET /api/v1/knowledge/documents/:id`、`GET /api/v1/agent/records/:id`
- `apps/web/public/app.js` / `styles.css`：文末「来源」chip
- `docs/plan/ask-answer-source-footer.md`、`docs/contracts-v1.md`

## 验证

- `npm test -- test/answer-source-footer.test.js`
- `npm run check`
