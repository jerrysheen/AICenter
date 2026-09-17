# 信息流简易翻译

## 目标

卡片上能一键把正文译成中文。不接 Grok，不覆盖原文。

## 决定

- 配置了 `GEMINI_API_KEY` 时走 Google AI Studio `generateContent`；失败再 DeepL，再 Google 公开接口。
- **不使用** Elucid / `ELUCID_GROK_API_KEY`（那是 Codex Grok 专用）。
- 没有 Key 时回退 Google 公开 `translate.googleapis.com` 接口（无密钥、可能限流）。
- 译文只显示在卡片上，不写入 Capture / ContentItem。按正文去重，已译过的帖子不再请求。
- 见 `docs/progress/2026-09-16-gemini-translate.md`。

## 申请 DeepL

在 DeepL 免费 API 创建 Auth Key，写入未提交的 `.env`：`AI_CENTER_DEEPL_API_KEY=`。
