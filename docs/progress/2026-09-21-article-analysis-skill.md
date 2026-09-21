# 2026-09-21 Article Analysis Skill

## 目标

把文章解读从「Search Agent / Article Reader」收成 **Article Analysis Skill**：Instruction + Domain Tool Scope + Output Goal。仍走同一套 DeepSeek Harness，不另建 Agent、Router、Planner 或 Knowledge/News Workflow。

## 决定

- Skill 由 `ai.article.analyze` 明确调用，不打开 DSH `skill-filesystem` / `tool-skill`。
- Knowledge / News / Mixed 只是同一次 Harness Run 内部的分析框架，不是程序分类器。
- 生产 Domain Tool 仍只有 `knowledge.search` / `knowledge.get`。公开互联网继续用 Harness 内置 `web_search` / `web_fetch`。
- 本地 legacy runtime 仍可附带 Domain `web.search`。不自动写知识库，不开放 `memory.save` / `taxonomy.list`。
- 产品入口、Job、API、`taskType` 和 UI「文章阅读」保持不变。

## 改动

- 新增 `packages/runtime/src/article-analysis/article-analysis-skill.js`
- Runner 改为 `articleAnalysisSkillInvocation(agentRuntime)`
- 删除 `article-analysis-prompts.js`
- 更新 `docs/search-agent-v1.md` 及其他稳定架构文档的命名
- `test/article-analysis-runtime.test.js` 增加 Skill 边界断言

## 验证

- `node --test test/article-analysis-runtime.test.js`

## 遗留

- 文件名仍是 `docs/search-agent-v1.md`，避免打断现有引用。
- 资料搜索插件以后再设计。
