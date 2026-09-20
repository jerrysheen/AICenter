# 2026-09-19 Jev Evidence Gate

## 目标

把 Jev 从只做 Prior / Reviewer，扩展到检索结果进入模型 Context 之前的证据门。解决的是「信息流里混进了不该参与推理的东西」，不是限制 Agent 看多少。

## 决定

- 不另建 Agent，不恢复 Claim Pipeline。
- 通用层放在 `AgentRuntime`：`web.search` / `knowledge.search` / `feed.search` / `feed.tag.search` 都走同一道门。
- 每条结果问 Relevance / Evidence / Quality；过滤后再问 Sufficiency。
- 默认 `enforce`：低相关或无证据的条目不进 Context，也不进 Source Footer。
- 不限制搜索次数。Agent 仍自己决定要不要继续搜；充分度只给轻提示。
- Jev 失败放行原结果，不失败 Run。
- Prior 继续 shadow；Evidence Gate 与 Prior 独立开关。

## 改动

- `packages/runtime/src/evidence-gate.js`
- `packages/runtime/src/agent-quality.js`
- `packages/runtime/src/agent-runtime.js`
- `packages/runtime/src/agent-prompt.js`
- `packages/runtime/src/agent-module.js`
- `packages/runtime/src/article-analysis/*`
- `packages/runtime/src/agent-trace-log.js`
- `packages/domain/src/answer-source-footer.js`
- `packages/database/src/repositories/knowledge-repository.js`
- `apps/web/public/app.js` / `styles.css`
- 稳定文档：`architecture-agent-v1.md`、`architecture-modules-v1.md`、`search-agent-v1.md`

## 验证

- 单元测试覆盖 Monkeytype 类垃圾过滤、Investing.com 有相关无证据、Jev 失败放行、Footer 只留 accepted refs。
- `npm test -- test/evidence-gate.test.js test/agent-quality.test.js test/agent.test.js test/answer-source-footer.test.js test/agent-trace-log.test.js test/article-analysis-runtime.test.js`

## 遗留

- 页面质量看板未做；当前只在来源脚注显示置信 / 充分度 / 采用数。
- Evidence Gate 的阈值和 Sufficiency 文案还要用真实检索样本校准。
