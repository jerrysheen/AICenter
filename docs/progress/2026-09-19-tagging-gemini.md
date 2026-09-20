# 粗筛 Tag 改走 Gemini

## 目标

豆包网页被翻译和打 Tag 频繁打开会挂掉。自动任务整条改回 Gemini；本地任务包留给 Cursor，不再用豆包网页扛批量。

## 决定

- Worker 默认 `taggingPort` 改为 `createGeminiTagPort`，调用 Gemini `generateContent`。
- Web / Worker 不再为自动任务创建豆包 Connector。豆包网页只留手动 CLI。
- Domain 落盘默认 `model=gemini`。页面 Contract 仍只读 Tag 结果，不暴露供应商。

## 验证

`npm test -- test/gemini-tag.test.js test/tagging.test.js`。重启 Worker 后，抓取或手动打 Tag 不再打开豆包页。
