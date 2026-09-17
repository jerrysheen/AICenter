# 第一条投资框架 Knowledge：科技成长公司分析

## 目标

把「高增长是否创造耐久经济价值」沉淀成给 Agent 用的结构化框架，而不是给人看的解释文章。这是仓库里第一条 `type: framework` 的投资判断 Knowledge。

## 决定

- Knowledge = How to think；Source / 行情 / Web = What is true now；LLM = 把 How 套到 What 上。
- 第一版只用 Markdown + front matter + 目录内文本搜索。不引入 RAG、Vector DB、Intent Router、Knowledge Agent 或 Workflow。
- 不把 Local Files 的 `list_directory` / `read_file` 暴露给模型。Agent 仍然只看到已有的 `knowledge.search` / `knowledge.get`。
- 文件知识与 SQLite 知识文档共用这两个工具；文件命中按语义 ID 返回，结果里不出现路径。
- 人看的长解释以后进 `notes/`，不进 `knowledge/`。易过期数字（某公司当前 ARR）不得写入框架正文。

## 第一条条目

- 文件：`knowledge/finance/frameworks/tech-growth-company.md`
- ID：`finance.framework.tech_growth`
- 分析链：Demand → Monetization → Unit Economics → Scale Efficiency → Growth Quality → Capital Efficiency → Operating Leverage → Valuation
- 优先信号：ARR↑↑、毛利↑、单位成本↓、利用率↑、资本效率↑

## 改动

- FileKnowledgePort 实现：`packages/connectors/src/local-knowledge-files.js`（本机目录适配，不是独立 MCP 进程；职责与「scoped local files search/read」相同）。
- Knowledge Service 在 search 时把文件命中排在 SQLite 命中前面；`get` 先按语义 ID 读文件。
- Web / Worker 组装时注入该 Port，根目录为仓库 `knowledge/`。
- Agent System Prompt 与 Tool budget 增加短规则：可能用到本地稳定认知时先 search，只取相关条目，当推理框架而不是当前事实。

## 验证

- `npm run check`
- `test/file-knowledge.test.js`：中文查询命中该框架、结果不含路径、Service 合并检索。

## 后续

- 行业条目（如 `finance.industry.ai_model`）与概念条目（如 `finance.concepts.arr`）按同样格式追加。
- 知识量到成千上万条后再替换 `knowledge.search` 内部实现；工具名不变。
- 知识库页面仍列 SQLite 文档；文件框架暂不进入该列表。
