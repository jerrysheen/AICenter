# 问答文末来源脚注

状态：已实施。不改 Runtime 循环、不新增领域。

## 问题

Agent 已经会通过用户 `references`、`feed.search` / `knowledge.search` / `knowledge.get`、`web.search`、持仓看板等产生 `ai_run_context_refs`。问答页目前只把 `origin=selected` 画在提问下方，点击只打开预览对话框，不跳到灵感 / 知识 / 社媒原文。Tool 命中完全不展示。模型正文里的 Markdown 链接也不是本地资源跳转。

用户问「今天社媒算力 tag 有哪些新闻」这类题时，即使检索或 tag 命中了本地帖，回答末尾也看不到可点回去的条目。

## 目标

一次问答完成后，在**该回答文末**列出本次真正 ref 到的来源。点击进入对应页面或详情，而不是再搜一遍。

来源只来自已落库的 `AiRunContextRef`，禁止模型在正文里编造资源 ID，也禁止前端解析模型 Markdown 当引用。

## 非目标

- 不在本轮做按 tag 检索工具（目录中的具体 tag 仍走后续 tag 查询需求）。
- 不做文内角标 `[1]` 与正文对齐高亮。
- 不把 Tool 原始 data 回给页面。
- 不新增 Reference 领域或新表。

## 现有协议（沿用）

- 用户指定：`CreateAgentRunInput.references` → Context Service `resolveReferences()` → `origin=selected`。
- 工具读取：`feed.search`、`knowledge.*`、`context.build`、`web.search`、`holdings.*`、`market.*`、`memory.save` 成功结果 → `origin=tool`。
- 形状：`resourceType + resourceId + revision? + label + asOf? + origin`。
- Tag 本身不是资源。以后按 tag 滤信息流时，命中项仍以 `content-item` 出现在脚注。

## 页面行为

1. 回答 Markdown 渲染结束后，追加一块「来源」，不属于模型正文。
2. 合并本轮 `selected` 与 `tool`，按 `resourceType + resourceId`（知识再加 `revision`）去重；`selected` 优先。
3. 分组顺序：信息 / 灵感 / 知识 / 回答 / 网页 / 持仓与市场。没有的组不渲染。
4. 每条展示类型名 + `label`（截断到现有 chip 长度）。`selected` 可标「你指定」。
5. 点击走统一 `openContextRef(ref)`，见下表。打不开则 toast，不跳死链。
6. 条数上限 24；超出只显示「另有 N 条检索命中未展开」，不把 15 次 `feed.search` 全铺开。
7. 进行中 / 失败的回答不画脚注。历史会话读回同一套 refs。

提问下方已有的用户引用 chip 可保留，表示「带着这些问」；文末是「回答用过的来源」。两端重复的 selected 条目，文末仍出现以便从答案跳转。

## 跳转

| resourceType | 点击 |
|---|---|
| `content-item` | 打开该条信息流详情（现有 `openPost`）。本地无卡片则按 `resourceId` 拉一条再打开。 |
| `post` | 打开手工帖详情。 |
| `inspiration` | 切到灵感并滚到 / 打开该条。本轮若还没有按 ID 打开的入口，一并补上，不新造 hash 协议也可以。 |
| `knowledge-revision` | 切到知识并打开该文档当前或指定 revision。文件框架（如 `finance.framework.tech_growth`）同样打开知识详情，不暴露路径。 |
| `ai-run` | 打开该回答所在会话。 |
| `web-result` | 仅 `http`/`https` 时新开外部链接；`resourceId` 就是 URL。 |
| `holdings-board` | 打开资产 / 持仓页。 |
| `market-board` | `overview` → 股票总览；`global` → 全球资产。 |
| 未知类型 | 不渲染或禁用 + toast。 |

不在新窗口打开本地页面。

## 契约与分层

- 会话详情 API 已返回 exchanges 的 refs 时，前端直接用；缺 label 时用类型名兜底，不为此加字段。
- 若详情现在过滤掉 `origin=tool`（`exchangeRefs` 只留 selected），改为把 tool refs 一并交给文末，不改写入路径。
- `web-result` 已约定不持久化搜索原文；脚注只跳 URL。
- 不让模型写「来源」小节。若模型自己写了类似列表，不去重、不拦截，脚注仍以 refs 为准。

## 验收

- 用户引用一条灵感再提问：文末有该灵感，点击回到灵感原文。
- 工具 `feed.search` 命中社媒：文末有信息条目，点击打开该帖。
- 工具读取知识 / 分析框架：文末有知识，点击打开文档。
- `web.search` 命中：文末有网页标题，点击打开外部 URL。
- 未引用、未检索到本地资源时：无「来源」块。
- `npm run check`。

## 后续（本轮不做）

- Agent 按 tag catalog 过滤信息流后，脚注自然带上命中的 `content-item`。
- 把「读取过」收成「正文实际用到」需要模型侧引用标记，另开需求。
- 鸿蒙壳跟进同一跳转，Web 先做。
