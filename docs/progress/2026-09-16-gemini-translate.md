# 信息流 Gemini 翻译

## 目标

一键把英语、韩语正文译成简体中文。不接 Elucid / Codex Grok。

## 决定

- Elucid 专用 Grok Key 环境变量为 `ELUCID_GROK_API_KEY`，只给 `启动-Codex-Grok.bat` 用。
- 翻译按 Google AI Studio JS 入门：读 `GEMINI_API_KEY`（或官方别名 `GOOGLE_API_KEY`），调用 `models/{model}:generateContent`，请求头 `x-goog-api-key`。
- 不装 `@google/genai` SDK。批量翻译先走豆包 JSONL 信封；合法 JSON 齐了立刻结束。豆包挂起不自动改走 Gemini。仅格式验收失败才回退一次 Gemini 批量。`AI_TRANSLATE_JSONL=0` 时才走 Gemini / DeepL / Google。
- 去重：服务端按条目 ID + 正文哈希写入 SQLite `feed_item_translations`（V11），电脑和手机读同一份；页面 localStorage 只作本机加速。桌面打开 X 信息流时，会把本机已有译文补写到服务端。
- X 时间线点「翻译」从最新未译的非中文推文一次处理最多 30 条（Gemini 批量 JSON）。已全部翻译则不发请求。卡片同时显示原文和译文。
- 单条翻译请求带条目 `id`，批量翻译写库后随 `GET /api/v1/feed/x` 的 `item.translation` 下发。

## 使用注意

重启 Web 后再用手机打开信息流。若译文是更早只存在浏览器里的，先在电脑打开一次 X 时间线以上传。

## 配置区分

| 用途 | 环境变量 | 服务商 |
|---|---|---|
| Codex Grok | `ELUCID_GROK_API_KEY` | Elucid 专用 |
| 信息流翻译 | `GEMINI_API_KEY` | Google AI Studio |
| 翻译备选 | `AI_CENTER_DEEPL_API_KEY` | DeepL |
