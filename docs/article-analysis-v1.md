# Article Analysis 入口

稳定设计以 `docs/search-agent-v1.md` 为准。本文只记当前实现入口、输入字段和 API，不再单独定义阅读框架或 Workflow。

产品入口是问答页「文章阅读」和阅读页「分析」。内部 Job 是 `ai.article.analyze`。这是 Article Analysis Skill 的当前落地：同一套 Harness 上的明确调用，不是第二条 Agent Runtime。

```text
POST /api/v1/article-analysis/runs
  → ai.article.analyze
  → 读取 Source
  → articleAnalysisSkillInvocation()
  → agentRuntime.run({ taskInstruction, allowedToolIds, enableAuxiliarySearch: false })
  → AiRun.outputText
```

普通 `ai.agent.run` 入口保持不变。

## 输入

`source.type = reference | inline`

- reference：服务端读取 `content-item` / `inspiration` / `post`
- inline：`title` 最长 1000，`body` 1–200000 字，可选 `sourceUrl` / `publishedAt`

不要塞进普通 `CreateAgentRunInput.message`。

## API

```text
POST /api/v1/article-analysis/runs → { ok, runId, sessionId }
GET  /api/v1/article-analysis/runs/:id
```

进行中返回 `status` + `stage` + `progress`。完成后加 `aiRunId` 和可读 `outputText`。不返回 Artifact JSON。

`AiSession.kind = article-analysis`。`AiRun.taskType = article-analysis.reader.v1`。`outputText` 上限 40,000 字。Skill 实现是 `packages/runtime/src/article-analysis/article-analysis-skill.js`。
