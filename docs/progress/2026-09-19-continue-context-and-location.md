# 2026-09-19 上一任务分段与刷新回会话

## 目标

继续做带过来的上一任务看起来像乱码；刷新后当前问答或任务详情不见了。

## 决定

- continue 正文仍是「上一任务 / 上一结果 / 继续指令」。乱码不是编码，是列表把整段嵌套上一任务当了主题。
- Domain 解析最后一段继续指令；页面列表主题、详情目标和「上一任务」面板都用解析结果，不再铺整段 body。
- `setView` 当时写下 `ai-center.last-location`。问答会话本就在 SQLite；刷新或鸿蒙重开先靠 URL hash，没有 hash 再读这笔记录。

## 验证

`npm test -- test/work-package.test.js`
