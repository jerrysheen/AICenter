# 任务改为独立 Cursor session

## 目标

这个对话不再当工人。每条灵感任务由 Worker 经 Cursor Connector 开独立 session，做完自己上报。

## 决定

- Worker 拉起本机 Cursor CLI（`agent -p --force --trust --workspace`），做完退出。
- 本机需安装 CLI 并 `agent login` 一次；不把 API Key 写进产品路径。
- CLI 用 `claimedBy=cursor-session` 自己上报。

## 验证

- `test/work-package.test.js`：notify 产生 dispatch job；handler 开假 session 并写回完成状态
- 本机 `agent.cmd login` 之后：Worker 拉起 CLI，工作包自己 complete，job 结束，`#inspire/tasks` 显示已完成 / 已回写
  - `e67a6a7c-…` → `CLI通路已通`
  - `5215df84-…` → `第二波CLI已通`（约 40s，`restartRequired=not_required`）
- Windows 不要 `spawn(agent.cmd)`；走 `powershell -File cursor-agent.ps1`。登录前的包会 `spawn EINVAL`。
