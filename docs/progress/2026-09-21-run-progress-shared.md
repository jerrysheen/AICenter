# 2026-09-21 问答与任务共用步骤展示

任务和问答都是同一条 Run：权限不同，步骤形状应对齐。

## 决定

- 页面执行记录共用 `renderRunProgress`：历史步折叠，当前步展开。
- 工作包 `steps.jsonl` 投影为 `AgentRunProgressStep[]`，挂在 trace.`timeline`。账本文件不改。
- 派发仍是本机 Cursor CLI。换成 Harness Host 剖面是下一步，不在本轮拆 CLI。

## 验证

- `node --test test/work-package.test.js`
