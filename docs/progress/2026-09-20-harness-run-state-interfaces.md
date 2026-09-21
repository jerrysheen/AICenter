# Harness Run 状态接口收口

## 目标

切换到冻结 DeepSeek Harness 后，不再让产品页面依赖本地 Runtime 的假事件格式，也不读取 DSH 私有 JSONL / Query SQLite。保留 AI Center 的 Job、AiRun、HTTP 与 SSE Contract，把 Harness 官方 Session 通知投影成可跨进程查询的应用状态。

## 决定

- `dsh-base` 已包含 Session persistence、checkpoint、projection、query 与 compaction 基建，不重复安装或复制。
- 当前 SDK 只暴露 `initialize`、`session/prompt`、`shutdown` 和 Session/Subagent 通知；`dsh-session-query-sqlite` 不作为产品状态 API。
- `POST /api/v1/agent/runs` 继续只创建 SQLite Job；Worker 执行 Harness。
- Worker 消费真实嵌套 `session.event.data`、`session.status` 与 Tool Gateway 结果，生成 provider-neutral Trace。
- V28 新增 `agent_run_events`。事件写入与 `runtime.agent-run.progressed.v1` Outbox 同事务完成。
- `GET /api/v1/agent/runs/:id` 返回 `status / phase / revision / updatedAt / progress / result / error`；原 `job` 暂留作 Web 兼容字段。
- 前端订阅 `runtime.agent-run.progressed.v1` 后立即刷新状态；800ms 轮询继续作为兜底。
- 完成后的问答通过 AiRun `sourceId=jobId` 回读进度并折叠展示运行记录；Agent Job 与 Work Package 都以创建子记录的方式支持「重新做」，不改写原轨迹。
- 产品 `AiSession.id` 不再直接作为 DSH 物理 Session ID；同一 Worker 内映射复用，重启后换新 Harness Session 并从 prior turns 重建，避免 persisted Session `already exists`。

## 改动

- 修复 Harness `tool/call` / `tool/result` 的真实 SessionEvent 结构解析。
- 实时 projector 保持 step round 与 callId 关联；同名并发 Tool 通过 Tool ID + 规范化 input 关联 Gateway 完成结果。
- Tool 完成详情来自 AI Center Tool Gateway，不从模型可见的 Harness 渲染文本反解。
- Agent Trace 同时保留本地 JSONL 审计副本和 SQLite 查询投影；Web 优先读取 SQLite。
- 新增正式的 Agent Run phase / status view Contract，并给 Article Analysis view 增加相同的 `phase / revision / updatedAt`。
- Work Package `open` 不再伪装成运行中；只有 `claimed` 显示 CLI 动态行，完成/失败任务可用 `/retry` 创建带 parent trace 的新任务。

## 验证

- `npm run typecheck:contracts`
- `node --test test/contracts.test.js test/article-analysis-runtime.test.js test/harness-runtime.test.js test/agent.test.js test/event-stream.test.js`
- 真实结构测试覆盖 `event.data`、`session.status`、Tool Gateway 结果补全。
- HTTP 测试覆盖 SQLite 进度投影、`phase`、`revision` 与 Outbox progress 事件。
- 真实本机接口验证已观察到 `queued → model → tool → model → completed`，Tool 为 `holdings.get`，完成详情来自 Gateway。
- 重启后的同会话「重新做」已从 `already exists` 修复为成功完成；历史 Session API 返回原 Job 的 8 步运行记录，终态无 active step。
- 联网问答验证通过 `web.search`、Evidence Gate、SSE progress 事件；文章阅读验证通过 `queued → running → completed` 与终态回溯。
- 任务详情把上一任务/结果/过程改为默认折叠，当前执行记录使用等宽 CLI 风格；`open` 不显示假思考，完成/失败任务显示「重新做」。
- 问答运行中只展开最后一个 active step，此前步骤收进「之前 N 步」；同一 `AiSession` 的多个后台 Job / AiRun 统一渲染在一个 conversation 容器内，继续提问呈现为下一轮对话。
- 进度轮询会重建 DOM；「之前 N 步」的展开状态现在按 runId 保存在前端 Set 中，轮询后不再自动收回。当前进度不再挑任意残留 active step，而是固定展示服务端返回的最后一条进度。
- 问答输入栏增加阅读态：`#ask-thread` 向下滚动后从约 97px 收成 44px，隐藏模式/联网/研究工具，只保留单行输入与发送；点击输入后恢复约 107px 和完整工具栏。手机端同步把回答区底部预留从 132px 降到 64px。

## 遗留

- `job` 兼容字段待前端完全迁移到产品 DTO 后删除。
- 官方 SDK 没有 mid-turn cancel；当前不新增伪取消接口。
- 真机 / 真实 DeepSeek 回合仍需人工观察 SSE 更新频率与长文章 heartbeat。

## 当日运行审计

- 当日 12 个初始 Job 中 11 completed、1 failed；唯一失败是接口验证期间暴露的 persisted DSH Session 撞名，修复后同会话 rerun 已成功。
- 当日正式 Work Package「分类器 tag 标签」完成，11 个步骤、状态一致、无乱码。
- 一次正式 Ask 出现额外的无效 `knowledge.search` 调用，但成功 Tool 与最终回答仍完成；后续 Tool failure 投影改为保留官方 result reason，不再只显示「工具失败」。
- Article Analysis 历史 exchange 原先没有回填 `jobId`，导致运行记录和 rerun 缺失；已让 `article-analysis` 与普通 `agent-run` 都通过 `sourceId=jobId` 回溯。
- Provider Health 原记录约 70 小时未刷新；手动 healthcheck 后 Worker / Browser 均为 healthy。健康检查目前仍是显式 Job，不是自动定时探活。
- 「根据文章线索找对应推文」Run 实际在约 101 秒后完成；搜索前 20 秒已返回，Evidence Gate 阻塞约 84 秒造成前端观感卡死。Evidence Gate 现在有默认 15 秒总时限，超时按既有 fail-open 规则放行原始检索结果。
- 该 Run 后端完成后前端仍可能保留旧 pending card：`loadAskSession()` 原先只追加服务端 pending，没有清理该会话中已结束的浏览器内存 Job。现在每次读取会话都以服务端 pending 集合对当前 session 做收敛，漏 SSE / 单次轮询失败后也能自愈。
- 同一会话改为一个 `.ask-conversation` 后，容器的 `overflow:hidden` 与 flex shrink 把 2048px 回答压成 788px，外层错误地认为没有可滚动内容。现在 conversation 使用 `flex: 0 0 auto; overflow: visible`，`#ask-thread` 实测 `clientHeight=800 / scrollHeight=2060`，可正常下滑。
