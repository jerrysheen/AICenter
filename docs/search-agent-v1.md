# Article Analysis Skill

历史名称：Search Agent V1。产品入口仍是「文章阅读」。
内部 Job：`ai.article.analyze`。

本文描述的是一个 **Article Analysis Skill**：Instruction + Domain Tool Scope + Output Goal。它不是第二个 Agent，也不是 DSH `skill-filesystem` 里的可发现 Skill 文件。生产上由 `ai.article.analyze` **明确调用**同一套 DeepSeek Harness；Harness 自己 reasoning / tool calling，再回调 AI Center Domain Tools。公开互联网仍是内置 `web_search` / `web_fetch`：`elucid-grok` 时搜索走 Grok 原生搜索，fetch 仍是 HTTP，不加 `web_read`。专用搜索插件以后再设计，当前不要另起循环，也不要打开 `@deepseek-ai/dsh-tool-skill`。

实现入口与输入字段见 `docs/article-analysis-v1.md`。阅读框架的 Prompt 来源见 `packages/runtime/src/article-analysis/article-analysis-skill.js` 与 `knowledge/research/frameworks/article-analysis.md`。

## 1. 定位

Article Analysis Skill 解决的是一个很简单的问题：

> 给它一份我还没仔细看的材料，让 AI 先读懂，再决定应该怎么展开、要不要查资料，最后给我一份可以直接阅读的分析。

程序不负责把文章编译成知识数据库结构，也不规定必须有几个 Concept、Mechanism 或 Claim。

边界是：

| 谁 | 负责 |
|---|---|
| 程序 | 提供原文、阅读框架、Tool、运行约束、进度、保存结果 |
| AI | 理解材料、判断 Knowledge / News / Mixed、决定是否检索、组织最终回答 |

最终结果是 Markdown，不是 JSON Artifact。

## 2. 总体架构

```text
AI Center Job（ai.article.analyze）
    │
    ▼
Article Analysis Skill
  Instruction + knowledge.search/get + Markdown 输出目标
    │
    ▼
DeepSeek Harness（同一套 agentRuntime.run）
    │
    ├── knowledge.search   ← Domain Tool
    ├── knowledge.get      ← Domain Tool
    ├── web_search         ← Harness 基建
    └── web_fetch          ← Harness 基建
    │
    ▼
Markdown Analysis
    │
    ▼
AiRun
```

入口仍是独立 Job：

```text
POST /api/v1/article-analysis/runs
    → ai.article.analyze
    → ArticleAnalysisRunner
    → articleAnalysisSkillInvocation()
    → agentRuntime.run({ taskInstruction, allowedToolIds, ... })
    → AiRun
```

它没有自己的 Tool Loop，也没有 Knowledge / News 程序分支。真正的模型循环、Tool Calling、预算、并发和 Tool 结果回填全部复用现有 `agentRuntime.run()`（生产上是 Harness 适配器）。Knowledge / News / Mixed 只是同一次 Run 内部的分析框架。

## 3. 为什么这样设计

旧实现曾经走过：

```text
Route
→ Knowledge Decompose / News Extract
→ 固定 JSON Schema
→ Parser
→ Evidence Pipeline
→ Artifact
```

这会把「读文章」变成「填数据库表」，带来三个问题：

1. AI 被固定字段限制，不能根据文章自然展开。
2. 大 JSON 容易截断、校验失败和整包 repair。
3. 程序开始替 AI 决定「什么值得搜索、怎么理解」，形成第二套专家系统。

V1 冻结后的原则是：

> 分析框架属于 Prompt；执行边界属于 Runtime；理解与检索决策属于 AI。

不要再把分析框架翻译成大型程序 Schema。

## 4. 阅读框架

### Knowledge

当材料的主要价值是可长期复用的概念、机制、方法、论证或思考框架时，按 Knowledge 阅读。

重点是自然回答：

- 它在解决什么问题
- 作者的核心结论是什么
- 哪些概念最关键
- 核心机制如何工作
- 概念和结论之间是什么关系
- 作者为什么得到这些结论
- 哪些是原文明说，哪些是合理推导
- 哪些地方仍没有解释清楚
- 什么问题值得继续追

不要机械摘要，也不要为了模板补不存在的栏目。

如果已有本地知识能帮助连接认知，可以调用 `knowledge.search` / `knowledge.get`。

如果材料依赖重要的外部事实，也允许调用 Harness 内置 `web_search` / `web_fetch` 核验；Knowledge 不等于禁止联网。本地循环回退才使用 Domain `web.search`。

### News

当材料的主要价值来自新事件、新数据、新声明、新产品、新政策或其他「变化」时，核心问题是：

> What changed?

先解释：

- 发生了什么
- 谁做了什么
- 哪些信息真正重要

再区分：

- 来源直接陈述的事实
- 某个人 / 机构的说法
- 作者判断
- 因果推论
- 预测

只对会改变整体理解的关键事实做外部核验，不要把每句话都拆成 Claim。

Evidence 必须来自 Tool Result，不能把模型训练记忆伪装成已搜索事实。

### Mixed

一篇材料可以同时含 News 和 Knowledge。由模型自己判断主线，同时保留另一部分，而不是看到「今天 / 发布 / 新产品」就自动判成 News。

例如一篇新发布的技术文章：

- News：「今天发布了新架构」
- Knowledge：「新架构怎么工作、为什么这样设计」

主线可能是机制，发布只是事件；也可能反过来。这发生在同一次 Harness Run 里，不要先单独请求分类。

## 5. Tool 边界

Article Analysis Skill 当前只看得到：

```text
knowledge.search
knowledge.get
web_search   ← Harness 基建，始终可用
web_fetch    ← Harness 基建，始终可用
```

明确不暴露：

```text
holdings.*
market.*
assets.*
feed.*
taxonomy.list
memory.save
```

原因不是这些 Tool「不能用」，而是第一版文章阅读不需要它们。

### Tool 使用原则

- Tool 是能力，不是固定流程。
- 模型可以不调用任何 Tool。
- Knowledge 不要求一定查知识库。
- News 不要求每个 Claim 都搜。
- 公开互联网可用不代表必须联网。
- Tool 失败时尽量基于已有材料继续，并明确证据不足。
- 本地 Knowledge FTS 查询在进入 SQLite `MATCH` 前必须转义，模型生成的 `non-autoregressive`、`C++` 等普通文本不能被当成 FTS 语法。

## 6. 执行器复用方式

Article Analysis Skill 只在通用 `agentRuntime.run()` 上做一次明确调用（生产执行器是 Harness）：

```js
agentRuntime.run({
  message: articleText,
  ...articleAnalysisSkillInvocation(agentRuntime),
})
```

展开后等价于：

```js
agentRuntime.run({
  message: articleText,
  taskInstruction: ARTICLE_ANALYSIS_SKILL_INSTRUCTION,
  allowedToolIds: [
    'knowledge.search',
    'knowledge.get',
  ],
  webMode: 'always',
  enableAuxiliarySearch: false,
})
```

Skill 本质就是这三项：Instruction、Domain Tool Scope、Output Goal。不要设计 Skill class / registry / lifecycle，也不要把 DSH 的 skill 工具打开给文章阅读。

两个通用扩展点：

- `taskInstruction`：在同一个 Harness Run 上切换任务认知框架。
- `allowedToolIds`：收窄本任务可见的 Domain Tool Table。

这两个能力不属于文章阅读私有逻辑，以后其他专用任务也可以复用。

### Auxiliary Search

Skill 显式使用：

```text
enableAuxiliarySearch = false
```

因此普通 Ask Agent 的豆包补充检索 sidecar 不会自动在文章分析末尾追加「补充资讯」。

Skill 的外部事实通过 Harness 内置 `web_search` / `web_fetch` 进入主模型上下文，由主模型自己综合。Domain allowlist 只有 `knowledge.search` / `knowledge.get`。本地循环回退才把 Domain `web.search` 加进 allowlist。

## 7. Job 与进度

Job stage 只保留：

```text
queued
running
completed
failed
```

不要再创建：

```text
route
news-extract
knowledge-decompose
verification-review
```

细节由统一 Trace 展示：

```text
开始阅读材料
正在等待模型
准备联网搜索 / 准备读取知识库
正在联网搜索 / 正在读取知识库
已获取结果
正在整理回答
分析完成
```

Article Runner 每 10 秒写一次等待心跳；40 秒后显示「模型响应较慢，仍在等待」。

模型单次请求 8 分钟是灾难保护上限，不是正常目标时间。

Worker 自己继续用 Job lease / heartbeat 保证长任务在等待模型时不被误回收。

## 8. 输出与存储

成功结果：

```text
AiSession.kind = article-analysis
AiRun.taskType = article-analysis.reader.v1
AiRun.outputText = Markdown Analysis
```

不再保存：

- VerifiedNewsArtifact
- StructuredKnowledgeArtifact
- Concepts / Mechanisms 数组
- Claim / Evidence 状态机
- 自动 KnowledgeDocument

当前 Skill 输出 Contract 上限为 40,000 字，用来避免早期 8,000 字静默截断。

如果用户以后决定「这篇值得沉淀」，再走独立的 Knowledge 保存 / 蒸馏流程。

阅读和落库是两步。

## 9. Jev 的位置

Article Analysis Skill 不新增 Jev Router，也不另建 Article Stage Reviewer。

Skill 进入的仍是同一套生产执行器（Harness）。公开互联网走 Harness 内置 `web_search` / `web_fetch`。Jev Evidence Gate 只过滤 Gateway 上的 `knowledge.search` / `feed.search`；内置 web 由 Reviewer 从 Session 轨迹观察。

Jev 仍然不：

- 替模型判断 Knowledge / News
- 替模型选择 Tool 或限制搜索次数
- 删除 Tool
- 改写阅读结果
- 建立 Claim Extraction / Evidence Pipeline

原则是：

> Agent 思考和探索，Runtime 执行，Jev 给置信与质量信号。

## 10. 代码位置

核心实现：

```text
packages/runtime/src/article-analysis/
  article-analysis-module.js
  article-analysis-skill.js
  article-analysis-runner.js

packages/runtime/src/agent-runtime.js
packages/runtime/src/evidence-gate.js
packages/runtime/src/agent-quality.js
packages/runtime/src/local-tools.js
packages/runtime/src/tool-registry.js

packages/contracts/src/article-analysis.js
packages/domain/src/runtime-service.js

apps/web/src/routes/article-analysis-routes.js
apps/web/public/app.js
apps/worker/src/worker.js
```

阅读框架：

```text
knowledge/research/frameworks/article-analysis.md
```

测试：

```text
test/article-analysis-runtime.test.js
```

## 11. V1 停止线

以下事情不要重新加回来：

- 单独 Route LLM
- Knowledge / News 固定 JSON Schema
- Article 专用 Parser
- Article 专用 Tool Loop
- 固定 Claim → Search → Verify 状态机
- 大型 Artifact Contract
- JSON repair
- 自动写入 Knowledge
- 为文章阅读再造第二个 Agent
- Skill class / registry / lifecycle
- 打开 DSH `skill-filesystem` / `tool-skill` 来加载本文
- 先单独请求模型判断 Knowledge / News，再走程序 if/else

如果阅读质量不够，优先调整：

- 通用 Evidence Gate / 检索质量信号
- 阅读框架 / Prompt
- Tool 描述和 Tool 能力
- 模型档位
- 通用执行器能力（Harness；不要另建 Article Runtime）

不要优先增加 Workflow 分支。

## 12. 验收标准

### Knowledge 材料

应该：

```text
读取原文
→ 自然判断 Knowledge
→ 按文章内容展开
→ 可选连接本地知识 / 核验外部事实
→ 返回正常 Markdown
```

不应该出现 JSON Parse / Artifact Validation。

### News 材料

应该：

```text
理解 What changed
→ 找出真正关键的事实
→ 按需 web_search / web_fetch
→ 基于 Tool Result 判断哪些已支持、哪些未确认
→ 返回正常 Markdown
```

### 工程验收

- Domain 只暴露 `knowledge.search` / `knowledge.get`。公开互联网是 Harness 内置 `web_search` / `web_fetch`。
- 不自动启动 Auxiliary Search。
- `knowledge.search` 对 FTS 特殊字符安全。
- Progress 在长请求中持续更新。
- 最终结果能在 Article 页面和 Ask 会话中以 Markdown 回看。
- 不创建 KnowledgeDocument。
- 不返回 Artifact JSON。

## 13. 一句话定义

> Article Analysis Skill = 同一套生产执行器（Harness）上的明确调用：阅读框架 Instruction + Domain `knowledge.search` / `knowledge.get` + Markdown 输出目标。

它的目标不是把文章「结构化入库」，而是先把文章读懂、查清、讲明白。
