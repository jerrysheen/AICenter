# 问答两层：AI 记录 + 新会话

## 目标

把问答从「当前页一次性聊天」改成两层结构：第一层是可回溯的 AI 记录，第二层是具体会话（打开旧问答继续，或点 + 开新问答）。灵感加工等其他 AI 处理也进入同一记录列表。

## 决定

- Knowledge 拥有 `AiSession`；`AiRun` 归属于会话，并补上提问原文 `inputText`。
- 继续旧会话时，Runtime 带上该会话最近若干轮问答；工具仍读取**当前**知识库、信息流和持仓。
- 灵感加工记录可打开回看，不在该条上继续问答；新问答统一从 + 进入。
- V12 回填已有 `ai_runs`：普通问答各成一条记录，同一灵感的加工归到同一会话。

## 改动

- Contract：`AiSession`、`AiSessionExchange`；`CreateAgentRunInput.sessionId`；`AiRun.sessionId` / `inputText`。
- Migration V12：`ai_sessions`，`ai_runs.session_id`、`input_text`。
- Knowledge Repository / Service：创建、列表、详情、会话历史。
- API：`GET /api/v1/agent/sessions`、`GET /api/v1/agent/sessions/:id`；`POST /api/v1/agent/runs` 返回 `sessionId`。
- 页面：`#ask` 记录列表，`#ask/new` 新问答，`#ask/<id>` 旧会话。

## 验证

- `npm run check` 通过（96 tests）。
- 浏览器：`#ask` 显示 AI 记录列表；点一条进入会话并可继续提问；右上角 + 进入 `#ask/new`；侧栏「问答」回到列表。
- V14 从 `jobs.input_json.message` 回填旧问答的 `input_text`，会话详情不再显示「无提问原文」。
