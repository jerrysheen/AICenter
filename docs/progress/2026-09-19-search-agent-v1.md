# 2026-09-19 Search Agent V1 设计落盘

## 目标

把已验收的 Article Reader 写成稳定设计：Search Agent V1。

## 决定

* Search Agent 不是搜索引擎，也不是第二套 Runtime。它是同一个 AgentRuntime + 文章阅读框架 + 受限 Knowledge/Web Tool。
* 分析框架属于 Prompt，执行边界属于 Runtime，理解与检索决策属于 AI。
* 稳定文档是 `docs/search-agent-v1.md`。`docs/article-analysis-v1.md` 只保留入口和 API。

## 验证

* 设计与当前实现一致：`ai.article.analyze`、`article-analysis.reader.v1`、三 Tool、关闭 Auxiliary Search、Markdown `AiRun`、FTS 转义、40k 输出上限。
