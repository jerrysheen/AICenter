# 2026-10-19 YouTube 播客

V1 按博主抓取 YouTube 上金融和 AI 方向的播客。有人工字幕或自动生成的原语种字幕就用字幕；没有字幕时下载音频，切块后走现有的 Gemini 语音转写，转写完删除音频。摘要走现有的 Gemini 文本调用，不用 jev。摘要不是中文时只用 Gemma 26B（`gemma-4-26b-a4b-it`）翻译。总开关默认关闭。这些内容不进小时报，单独在信源目录展示。

migration 86 `youtube_podcasts` 只建 `youtube_podcast_episodes` 和 `youtube_podcast_channels`。空号仍是 63、79、80、82。不要重建数据库。需要同时重启 Web 和 Worker。

## 服务器上要装

Windows 上需要 `yt-dlp` 和 `ffmpeg`，并且都能在 PATH 里运行 `--version`。

```powershell
powershell -File scripts/ensure-yt-dlp.ps1
node scripts/ensure-yt-dlp.mjs
```

安装脚本先试 winget（`yt-dlp.yt-dlp`、`Gyan.FFmpeg`），不行再试 `pip install -U yt-dlp`。检测脚本打印 `{"ytDlp":true,"ffmpeg":true}` 才算就绪。二进制不在 PATH 上时设置 `AI_CENTER_YT_DLP` 为完整路径。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `AI_CENTER_YOUTUBE_PODCASTS` | 关 | `1` / `true` / `on` / `yes` 才跑。其他值或不设置都不跑。 |
| `AI_CENTER_YOUTUBE_PODCASTS_AT` | `07:00` | 每天一次，`HH:MM`。 |
| `AI_CENTER_YOUTUBE_PODCASTS_TIMEZONE` | `Asia/Shanghai` | 上面时刻的时区。 |
| `AI_CENTER_YOUTUBE_PODCASTS_INTERVAL_MS` | `8000` | 两次外部请求之间的间隔，1000–120000。 |
| `AI_CENTER_YOUTUBE_PODCASTS_ROUND_LIMIT` | `24` | 每轮最多探测多少个视频，1–80。 |
| `AI_CENTER_YOUTUBE_PODCASTS_TRANSCRIBE_MINUTES` | `90` | 每轮转写音频的分钟上限。超出的记 `transcribe-budget`，下一轮再试。 |
| `AI_CENTER_YOUTUBE_PODCASTS_LOOKBACK` | `2` | 每个频道第一次只留下最近几集，1–5。 |
| `AI_CENTER_YOUTUBE_COOKIES` | 空 | 可选的 Netscape cookies 文件。默认不传给 yt-dlp。 |
| `AI_CENTER_YT_DLP` | `yt-dlp` | 可执行文件名或路径。 |

转写和摘要继续用已有的 `GEMINI_API_KEY` 到 `GEMINI_API_KEY5`，密钥轮换和额度冷却不变。`AI_CENTER_JEV_ENABLED=false` 不影响这一路。

## 增减频道

改 `config/youtube-podcasts.json`，然后同时重启 Web 和 Worker。

- `kind: "channel"` 配 `handle`，用 `https://www.youtube.com/feeds/videos.xml?channel_id=`。频道 id 从频道页解析一次，写进 `youtube_podcast_channels`。
- `kind: "playlist"` 只抓这个播放列表，不抓整个频道。Odd Lots 必须保持播放列表 `PLe4PRejZgr0OJbRzA6nWybYiThLJd_ouz`。
- 同一博主的多个频道放在同一个 `creators[].id` 下，并用 `role` 标 `video` 或 `audio`。硅谷101 的视频版和音频版共用 `valley101`。
- `prefer: "zh"` 只留中文原版。张小玺的英文配音版会在同一期里被丢掉。
- 删掉一个博主后，已经入库的集仍留在库里，页面会排在配置列表后面。

## 怎么跑

Worker 在开关打开时注册 `youtube.podcasts.sync`，默认每天北京时间 07:00。开关关闭时日程仍写入，但是 `enabled: false`，不会发请求。

手动触发（开关必须先打开，Worker 必须在跑）：

```text
node --env-file=.env scripts/youtube-podcasts-run.mjs
```

本机页面信源目录里「YouTube 播客」右上角也有「检查新的一集」，对应 `POST /api/v1/youtube-podcasts/sync`。这条只接受本机，不进只读令牌。开关关闭返回 409。已经排队或正在跑则不再入队。

每轮一行：

```text
[worker] youtube-podcasts discovered=N subtitles=N transcribed=N failed=N skipped=N stopped=- reasons=-
```

遇到 YouTube「不是机器人」或 HTTP 429，本轮停在当前视频，不把它标成完成，原因写进 `stopped` 和 `reasons`。下一轮从这里继续。找不到 `yt-dlp` 同样停本轮。

## 过滤和文字

发现走 RSS，不翻频道页。时长、直播状态和字幕用 `yt-dlp --dump-single-json`。只要时长至少 20 分钟（配置里的 `minDurationSec`，默认 1200）。Shorts、标题里的切片和预告、正在直播和直播预告都丢掉。

去重两层：全局按 `videoId`；同一博主里，标题相近且时长差在 3 分钟或 8% 以内的，视为同一集。视频版优先于音频版，中文原版优先于配音。第一次每个频道只保留最近 1–2 集（探测窗口比这个多几条，避免短片占掉名额）。频道没探测完不会标成已回溯，避免把后面的集提前标成跳过。

文字来源记在抓取元数据和页面上：`subtitle-manual`（人工字幕）、`subtitle-auto`（原语种自动字幕）、`gemini-transcribe`（语音转写）。页面上分别写成人工字幕、自动字幕、语音转写。完整文字稿在内容正文，摘要在 `summary`。作者 id 是 `youtube:<博主 id>`，硅谷101 两个频道算同一个作者。发布时间用 RSS 的上传时间。`provider` 为 `youtube`。

小时报候选看到 `provider=youtube` 直接排除。主信息流查询也不包含这个 provider。

## Gemini 用量

首批 11 个频道大约每周 20 集，平均一天 3 集左右。多数频道有字幕，只有摘要一次 `generateContent`。按大约八成有字幕估算：每周约 16 次摘要、4 集转写。转写按现有额度切块，大约每 8 分钟一段；一集 50 分钟大约 6 次。一周合计大约 40 次 Gemini 调用，一天常态大约 6 次。张小玺中文原版经常没有字幕，新的一集会吃掉转写额度；每轮转写默认不超过 90 分钟，多出来的下一轮再做。摘要已经是中文时不调用 Gemma。偶发英文摘要大约每周 0–5 次 Gemma 26B。

## 上线

1. 装好 `yt-dlp` 和 `ffmpeg`，跑 `node scripts/ensure-yt-dlp.mjs`。
2. 需要时再设 `AI_CENTER_YOUTUBE_COOKIES`。默认不要设。
3. 部署后同时重启 Web 和 Worker。migration 86 在启动时自己加上。不要重建数据库，不要删已有 migration。
4. 确认开关仍是关的，日志里不应出现对外请求。准备试跑时再设 `AI_CENTER_YOUTUBE_PODCASTS=1`，再次同时重启 Web 和 Worker。
5. 手动入队：`node --env-file=.env scripts/youtube-podcasts-run.mjs`。入口在信源目录「社媒」，紧挨着 B 站。列表不显示标签和分享。
