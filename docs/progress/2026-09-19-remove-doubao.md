# 去掉豆包脚本与 Connector

## 目标

手动 CLI 和网页 Connector 已无自动任务在用。整段删掉，避免再被当成翻译/标注入口。

## 决定

- 删除 `scripts/ask-doubao.mjs`、`ask-doubao-jsonl-envelope.mjs`、`ask-doubao-translate-jsonl.mjs`。
- 删除 `packages/connectors/src/doubao/` 及对应测试。
- Web / Worker 翻译和粗筛 Tag 继续走 Gemini；缺 Key 回退 DeepL / Google。
- SQLite 里已有的 `doubao-jsonl` 译文和 `doubao-web` Tag 行保留，不重跑、不删库。

## 验证

`npm test -- test/translate.test.js test/tagging.test.js test/gemini-tag.test.js`。`npm run syntax` 不再检查豆包文件。
