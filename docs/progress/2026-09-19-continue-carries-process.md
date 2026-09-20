# 2026-09-19 继续任务带上上一轮全过程

## 目标

继续做不能只把上一句对话再问一遍。新 session 必须带着上一轮的 goal、progress 和 steps。

## 决定

- Cursor CLI 仍是一次性进程，continue 另开工作包，不 resume 上一轮进程。
- Domain 正文改为「上一任务 / 上一目标 / 上一进展 / 上一步骤 / 上一结果 / 继续指令」。
- 新目录落下 `parent-trace.json`；`GET /trace` 的 `parentTrace` 是这份快照。
- 新 goal 用继续指令，不把嵌套全过程整段当目标。

## 验证

`npm test -- test/work-package.test.js`
