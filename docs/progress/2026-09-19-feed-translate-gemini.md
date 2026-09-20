# 信息流翻译改回 Gemini

## 目标

豆包网页翻译不稳定、偏慢。信息流整条翻译通道改回 Gemini，不再先发 JSONL 信封。

## 决定

- `createTranslateService` 不再接入 `DoubaoAskQueue` / JSONL 翻译口。
- 批量走 Gemini `generateContent`；单条失败再 DeepL / Google。
- Web Composition Root 不再为翻译创建豆包 Connector。Tag 与 CLI 问答仍用 Worker / 脚本里的豆包队列。
- 页面 Contract 仍只读 `translatedText`，不暴露供应商。

## 验证

`npm test -- test/translate.test.js test/domain-services.test.js`。重启 Web 后再拉或补翻译，新译文 `engine` 为 `gemini`。
