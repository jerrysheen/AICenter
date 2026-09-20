# 2026-09-19 Article Analysis Agent V1

## 目标

把一份未读材料读成正常 Markdown 分析。不写 Knowledge 库，不编译结构化 Artifact。

## 决定

* 保留 `ai.article.analyze` Job、Session、API、阅读页 / 问答页入口和 progress。
* Runner 改成薄 Wrapper：读 Source → `AgentRuntime.run({ taskInstruction, allowedToolIds })` → `AiRun`。
* 删除 Parser、Evidence Pipeline、固定 Route / Decompose / Verify、extract profile 和 Article 专用 JEV。
* `taskType` 统一为 `article-analysis.reader.v1`。问答页入口改名为「文章阅读」。

## 改动

* `packages/runtime/src/agent-runtime.js` 增加 `taskInstruction` / `allowedToolIds`
* `packages/runtime/src/article-analysis/`
* `packages/contracts/src/article-analysis.js`
* `apps/worker/src/worker.js`
* 问答页「文章阅读」，阅读页只渲染 Markdown

## 验证

* `test/article-analysis-runtime.test.js`
* `test/ask-research-mode-ui.test.js`
* `npm run check` 中相关子集

## 扫尾

* Knowledge FTS 对模型 query 做 quote，避免 `non-autoregressive` 一类连字符触发 `no such column`。
* Article Reader `enableAuxiliarySearch: false`，不再自动追加「补充资讯」。
* UI「正在阅读材料」；只保留 Runner 一条带字数的 `article.started`。
* `outputText` 上限改为 40k。

## 遗留

* Knowledge Hit / Compare / Distillation
* Generic Web Page Reader
* 普通 Ask Agent 调用 `article.analyze`
