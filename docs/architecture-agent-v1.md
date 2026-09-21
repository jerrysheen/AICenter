# AI Center Agent 架构

当前冻结版本：**Single Agent + Runtime Guardrails + Jev Quality Observer（Prior / Evidence Gate / Reviewer）**。

实现细节仍以 `docs/architecture-modules-v1.md` 与 `packages/contracts/src/agent.js` 为准。本文冻结职责划分，不另建 Intent Router、Planner 或多 Agent。

文章阅读是 **Article Analysis Skill**（产品入口「文章阅读」，Job `ai.article.analyze`）：复用同一套生产执行器（DeepSeek Harness），由 Job 明确注入阅读框架 Instruction 和 Domain Tool 可见范围。它不是第二个 Agent，不进入普通问答 Job，也不改变本文的 Ask Agent 冻结。资料搜索以后做成 Harness 插件。设计见 `docs/search-agent-v1.md`。

## 一句话定义

Agent 负责思考和探索，Runtime 负责执行与确定性边界，Tool 提供感知与行动能力，Jev 负责置信与质量信号。**Jev 不指挥 Agent 想什么，也不裁剪 Tool Table。**

## 1. 元框架：把「做事、约束、反思」拆开

这套架构的目标不是手写一条复杂的 Agent 工作流，而是建立一个简单、可扩展的认知系统。最核心的拆分是三件事：

| 层 | 谁 | 做什么 |
|---|---|---|
| 做事 | Agent | 自己判断该不该查、查什么、查完是否继续、最后怎么回答 |
| 约束 | Runtime | 控制工具可见性、Schema、权限、预算、并发、超时和来源真实性 |
| 反思 | Jev | Prior 观察首轮工具必要性；Evidence Gate 给检索结果置信分；Reviewer 复盘整条轨迹 |

因此，AI Center 不再依赖大量 if/else、Intent Router 或固定 Planner 来规定「某种问题必须走某条链路」。问题解决逻辑尽量留在 Agent；确定性的安全和工程规则留在 Runtime。

## 2. 当前整体结构

```text
用户问题
   │
   ▼
┌───────────────┐
│ Single Agent  │  ← 判断：要不要查、查什么、是否继续
└───────┬───────┘
        │ Tool Call
        ▼
┌───────────────┐
│    Runtime    │  ← 规则：权限 / Schema / 预算 / 并发 / 超时 / Final Guard
└───────┬───────┘
        │
        ▼
      Tools      ← Domain：持仓 / Knowledge / Feed / 市场 / 官方源 / 写入
                 ← Harness 基建：web_search / web_fetch
        │
        └──────────────→ Observation 回到 Agent → 继续判断 → 最终回答

Jev：
  Prior（做前：要不要调用）
  Evidence Gate（做中：这结果能不能用）
  Reviewer（做后：整个过程合理吗）
```

## 3. 四个核心角色

### 3.1 Agent：唯一的问题解决主体

- 每轮拿到用户问题、会话历史、已解析的引用、当前时间和当前可见 Tool Table。
- 自己决定直接回答，还是调用一个或多个 Tool；拿到结果后自己决定是否继续。
- 当前默认不是多 Agent，也没有前置 Intent Router 或 Planner Agent。
- 核心原则：链路由模型负责，不把业务推理重新写死在 Runtime。

### 3.2 Runtime：确定性的世界规则

- 决定哪些 Tool 当前可见，并校验 Tool 输入 / 输出契约。
- 负责 Tool 调用总预算、模型调用预算、并发、超时、错误隔离。
- 负责来源和最终回答的确定性 Guardrail，例如不能声称「已联网」却没有真实 `web.search` / `web.fetch` 记录。
- 负责把 Harness 官方 Session 事件与 Tool Gateway 结果转换为 provider-neutral 的运行进度。该投影供 API / SSE / UI 使用，不反向影响 Agent 决策，也不把 DSH 原始事件或文件格式提升为产品 Contract。
- Runtime 不负责替 Agent 选择工具。
- Runtime 还负责 **调用方能力剖面**：本次 Run 是 `device-operate` 还是 `desktop-host`。可见 Tool、dsh profile、Session 复用都按该剖面收口。公网已配对不等于本机编码权限。规则见 `docs/public-access-security.md`。

### 3.3 Tool：Agent 感知和作用于 AI Center 的接口

可以把 Tool 理解为 Agent 的「感官和手」。新增雪球、Polymarket、链上数据、邮件、日历或本地知识，本质上是增加能力，而不是重新设计一条 Agent 工作流。

| 能力类型 | 例子 |
|---|---|
| 个人 / 本地状态 | `holdings.get`、`assets.get`、`user.method.get` |
| 知识与信息流 | `knowledge.search`、`knowledge.get`、`feed.search`、`feed.tag.search` |
| 公开互联网 | Harness 内置 `web_search` / `web_fetch`（基建，不经 Domain Gateway） |
| 官方事实 | `static.signals.list` → `official.source.get` |
| 写入 | `taxonomy.list` → `memory.save` |

`ToolRegistry` 是 Domain Tool 的唯一入口。公开互联网由 Harness 内置 `web_search` / `web_fetch` 提供，不经 Gateway。Domain Tool 只能调用 Domain Service 或 Connector，不能直接 SQL。

给 Harness 模型的参数说明走 `toDefineToolParameters`，不是把 Zod JSON Schema 原样交给 DSH。有 default 的字段对模型是可选的；`pattern` 等 DSH 不收的约束必须写进 `description` / `examples`。典型例子：`knowledge.search` 的 `taxonomy` 可省略，合法值是点分 key（`domain.investment`），不是 `finance` 或 `domain:finance`。契约与投影规则见 `docs/architecture-modules-v1.md`。

### 3.4 Jev：元认知 / 质量信号层

Jev 不拥有路由权、工具执行权或回答权。它回答置信问题；Runtime 决定这些信号如何落地。

- **T0 Prior**：在执行前，根据用户问题和 Tool Table，判断哪些 root-capable Tool 可能是完成任务所必需的。默认 **shadow**，只写 Trace。
- **Evidence Gate**：对经 Gateway 的检索 Tool Result（`knowledge.search` / `feed.search` / `feed.tag.search`）进入模型 Context 之前打分。Harness 内置 web 结果不经过这道门，由 Jev Reviewer 从 Session 轨迹观察。
- **Run Reviewer**：执行结束后，只看脱敏后的 Audit Projection 和 Evidence Gate 汇总分，评价 coverage、relevance、evidence、sequence、efficiency、completion。
- Prior 不裁剪 Tool Table。Evidence Gate 不限制搜索次数，只阻止垃圾检索污染后续推理。
- Jev 失败不会让问答失败。

## 4. Jev 看什么，不看什么

为了让质量层能观察流程但不过度读取用户数据，Tool Result 会先转成 Audit Projection。

```text
真实 Tool Result
   │
   ▼
Audit Projection
- tool / role / dependsOn
- success
- outcome: found / empty-valid / unavailable / failed / partial
- resultUtility: empty / weak / usable / strong
- resultCount / warningCount / duration / errorCode
   │
   ▼
Jev Reviewer
```

Reviewer 不读取持仓数量、成本、资产金额、知识正文、官方正文等敏感或大体量 Tool data。它评的是「流程有没有走对」，不是「最终答案内容是否正确」。

Evidence Gate 是单独的中间层：它必须看到检索条目的标题、URL 和摘要，否则无法判断 Monkeytype / 股票页 / 官网新闻是否构成证据。它不读取持仓、资产金额或官方全文，也不理解整篇文章、不拆 Claim。

`empty-valid` 表示查询成功、资源不存在，是有效的缺席证据，不是失败，也不是「存在内容」。`partial` 的 utility 是 usable，不能标成 strong。

## 5. Root-capable 与明确 Follow-up

当前质量层只把「技术上明确依赖前一步输出」的 Tool 视为 Follow-up。其他 Tool 默认可以作为 T0 root-capable 候选。

| Root-capable（可首轮调用） | 明确 Follow-up（依赖前一步结果） |
|---|---|
| `holdings.get` / `holdings.rank` | `official.source.get` ← `static.signals.list` |
| `knowledge.search` | `knowledge.get` ← `knowledge.search` |
| `taxonomy.list` | `memory.save` ← `taxonomy.list` |
| `web.search` / `web.fetch` / `static.signals.list` | |
| `feed.*` / `market.*` / `assets.get` / `context.build` … | |

这张 role / dependency 表目前只是 Jev 质量层的临时元数据。长期应该收敛到 Tool Registry metadata，避免维护第二份 Tool 目录。

## 6. Jev 如何帮助后续改进 Agent

这里的「微调」首先是广义的 Agent 改进，而不是一上来训练模型权重。Jev 的核心价值是把大量真实历史运行变成可筛选、可复盘的数据。

```text
大量真实 Agent 历史轨迹
        │
        ▼
Jev Prior + Reviewer 打分 / 标签
        │
        ├── 正常样本
        └── 值得复盘的异常样本
                 │
                 ▼
          找稳定错误模式
                 │
      ┌──────────┼──────────┐
      ▼          ▼          ▼
  Prompt      Tool 描述    Runtime / Contract
  调整         调整         确定性修复
      └──────────┬──────────┘
                 ▼
           再跑真实样本验证
                 │
                 ▼
只有当错误长期稳定且确实属于模型行为 → 再考虑真正的模型微调
```

因此，Jev 分数不是「训练目标本身」，而更像历史数据的质量索引和问题挖掘器。重点关注错误轨迹为什么出错，而不是追求一个漂亮的平均分。

## 7. 当前应该观察的指标

- **T0 root Tool precision / recall**：Prior 有没有高质量识别首轮必要工具。
- **多余 Tool 率**：已经足够却仍继续搜索或重复调用。
- **漏 Tool 率**：任务需要某个能力但 Agent 没有调用。
- **失败后乱搜率**：Tool 失败 / unavailable 后是否出现无目的补搜。
- **weak → strong 合理升级率**：候选信息不足时，是否正确升级到更权威证据。

当前不要只看 Agent Quality 的平均总分。总分用于快速筛查，真正有价值的是具体失败模式。

## 8. 当前明确不做的事情

- 不在 Agent 前面增加一个手写 Intent Router。
- 不默认拆成 Planner / Researcher / Executor 多 Agent。
- 不让 Jev Prior 裁剪 Tool Table。
- 不因为 Jev 低分直接阻断问答；Evidence Gate 失败时放行原检索结果。
- 不把 Tool 选择逻辑重新写成大量规则。
- 不把 Process Quality 误当成最终答案正确性。
- 不把 Evidence Gate 做成 Claim Extraction / Evidence Pipeline / 第二套 Article Reviewer。
- 不靠限制搜索次数来保证认知质量。
- 不把「已配对」当成 Host 编码权限；不让公网 Ask 复用带 bash / 写盘 / subagent 的 dsh Session。
- 不把 DeepSeek Harness 的 `danger-full-access` 作为产品默认，也不从公网页面切换 Permission 预设。

## 9. 当前冻结状态

| 模块 | 状态 |
|---|---|
| Single Agent | 已确认：唯一决策主体 |
| Runtime | 确定性约束，不做 Router。生产执行器是冻结 DeepSeek Harness；本地循环仅测试/回退 |
| Tool Registry | 统一能力入口；Harness 只通过 Gateway 回调，不直连 SQLite |
| Jev Prior | shadow；T0 root necessity |
| Jev Evidence Gate | enforce；检索结果进 Context 前打分并过滤 |
| Jev Reviewer | Process Quality；可看 Evidence Gate 汇总分 |
| Follow-up Prior | Observation-1 未实现 |
| 真实评估 | 下一步积累 30–100 条 |
| Advisory | 暂不开启 |
| Harness | 生产默认。Ask 与文章阅读共用冻结 `dsh-base`；公开互联网是内置 `web_search` / `web_fetch`；Domain Tool 走 Gateway。主模型只看 `AI_CENTER_HARNESS_PROVIDER`（DeepSeek 官方或 Elucid Grok）。`elucid-grok` 时搜索走 Grok 原生 `web_search`，fetch 仍是 HTTP。`device-operate` 保持 Host 工具关闭。资料搜索以后做成插件。Node 22.14 通过 `packages/harness/src/dsh-entry.js` 启动（补 `import.meta.main` 与 `node:zlib` zstd 导出）。 |
| 运行进度 | Harness `session.event` / `session.status` + Tool Gateway 是执行事实来源；AI Center SQLite 保存脱敏只读投影并通过 Outbox/SSE 通知页面。产品 GET 不读取 DSH 私有 JSONL/Query DB。 |
| 调用方能力 | 已确认：配对使用产品，桌面才驱动 Host 作用。工作包记录可从已配对设备创建；`work-package.dispatch` 与手动重启只允许 `desktop-host`。当前实现尚未完全收口，以 `docs/public-access-security.md` 为目标。 |

## 最终定位

当前 AI Center Agent = **一个负责思考和探索的 Single Agent + 一个负责确定性边界的 Runtime + 一组可插拔 Tool + 一个给出置信与质量信号的 Jev 层**。执行、约束、评价彼此分离。

AI Center **不是** Agent Framework。通用循环、Session 压缩、Retry、Permission 已经收敛到冻结的 DeepSeek Harness；这就是现在的 `AgentRuntime`。本地自研循环只留给测试注入 fake LLM，或显式 `AI_CENTER_AGENT_RUNTIME=local`。AI Center 继续拥有领域数据、Tools、Skills、JEV、UI 和产品 Job。当前 Skill 是明确调用（例如 Article Analysis：Instruction + Domain Tool Scope + Output Goal），不是 DSH `skill-filesystem` 上的可发现 Skill 目录。资料搜索等专用能力以后通过 Plugin / Provider / Seam 加在这套执行器上，而不是修改或 fork core，也不另建第二套 Runtime。Harness Permission 预设管的是本机编码 Agent 的 sandbox / 审批；公网授权仍由 AI Center 的调用方能力平面决定。
