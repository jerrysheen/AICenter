# B站贴链接抓 AI 中文字幕

## 目标

在信息页「B站」筛选提供贴链接入口。用户粘贴 `bilibili.com/video/BV...`、分享文案或 `b23.tv/BV...` 后，用已登录采集 Chrome 打播放器接口，只取 `ai-zh`。没有就返回「没有」，不回退普通字幕、ASR 或音频。

对照由环境变量定位的旧仓 `skills/pull-bilibiliInfo`：只参考 Chrome + 字幕接口这一段并在 `packages/connectors/src/bilibili/` 内重新适配，不迁 UP 列表、音频和 Whisper。

## 决定

- 页面仍读统一 FeedItem，不增加 B 站专用卡片。
- `POST /api/v1/feed/bilibili` 走 Route → Feed Service → Connector；原始播放器字段不入库。
- 成功结果写入 SourceAccount `bilibili:imports`、Capture、ContentItem，重启后仍在。
- `feed.bilibili.sync` 已注册，供后续关注同步复用同一 Connector。
- Cookie 留在采集 Chrome；不把 Cookie 返回 API。
- 当时采集 Chrome 使用仓库内 `.ai-data/chrome-profile` + 9222。启动参数只用 `about:blank`，禁止把视频 URL 交给日常 Chrome。X 拉完不再 `Browser.close`。

## 改动

- `packages/connectors/src/bilibili/`：Chrome CDP、ai-zh 选择、FeedItem 映射
- `packages/contracts/src/index.js`：`parseBilibiliFeedQuery` / `parseBilibiliImportInput`
- `packages/domain/src/feed-service.js`：B 站来源账号与 import/transcript 落库
- `apps/web`：B站工具条贴链接；Worker / Connector Registry 注册 handler
- 测试：链接解析、只认 ai-zh、没有、API 落库、Job 注册

## 验证

- `npm run check`：相关测试通过。
- 登录采集 Chrome 后对 `BV1cwtN6sEDr` 抓取 `ai-zh`，Gemini 只做 Markdown 排版；`P2x view` 等听写原文保留。Capture.metadata 存字幕原文，卡片展示整理后的正文。

## 后续

- 关注 UP：`list` 快速入库标题，字幕任务异步更新
- Web 长时间抓取改为只入队 Worker，GET 只读缓存
