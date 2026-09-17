# 问答答案 Markdown

## 目标

问答会话里的模型回答按 Markdown 展示，而不是把 `**`、`##`、表格源码直接铺在页面上。

## 决定

- 只在答案区渲染，不改提问原文。
- 支持标题、表格、有序/无序列表（含缩进嵌套）、加粗、行内代码；原文 HTML 一律转义。
- 解析放在 `apps/web/public/markdown.js`，Web 与 Harmony 共用，不引入额外依赖。

## 验证

- `node --test test/markdown.test.js`
- 浏览器打开已有「个人资产分析」会话，确认总盘表格和列表不是源码。
