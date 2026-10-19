# 2026-10-19 YouTube 播客

V1 按博主抓取 YouTube 上金融和 AI 方向的播客。有人工字幕或自动生成的原语种字幕就用字幕；没有字幕时下载音频，切块后走现有的 Gemini 语音转写，转写完删除音频。摘要走现有的 Gemini 文本调用，不用 jev。摘要不是中文时只用 Gemma 26B（`gemma-4-26b-a4b-it`）翻译。总开关默认关闭。这些内容不进小时报，单独在信源目录展示。

正文整理见 `2026-10-19-youtube-podcast-article.md`。默认用 Gemma 26B 翻译池，失败时缺的段可以改用现有 Gemini Flash。已经是中文的字幕只整理。豆包不是默认。标题、摘要和关键句仍只用 Gemma 26B。

migration 86 `youtube_podcasts` 只建 `youtube_podcast_episodes` 和 `youtube_podcast_channels`。migration 87 `youtube_podcast_backfill` 只给 `youtube_podcast_channels` 加 `backfilled_at`、`backfill_attempts`、`backfill_failed_at`。空号仍是 63、79、80、82。不要重建数据库。需要同时重启 Web 和 Worker。

## 服务器上要装

Windows 上需要 `yt-dlp` 和 `ffmpeg`，并且都能在 PATH 里运行 `--version`。

```powershell
powershell -File scripts/ensure-yt-dlp.ps1
node scripts/ensure-yt-dlp.mjs
```

安装脚本先用 winget：`yt-dlp.yt-dlp` 和 `Gyan.FFmpeg`。winget 不在，或装完当前终端仍找不到命令时，再执行 `python -m pip install -U "yt-dlp[default]"`。检测脚本打印 `{"ytDlp":true,"ffmpeg":true}` 才算就绪。`ffmpeg` 必须有。不用安装 Deno。

`yt-dlp` 必须是 **2025.11.12 或更新**。采集会传 `--js-runtimes node:<当前 node 可执行文件>`，旧版会报 `no such option`，本轮直接停，原因是 `yt-dlp-outdated`，不计入尝试次数。每轮开始先跑 `yt-dlp --version`。二进制不在 PATH 上时，把 `AI_CENTER_YT_DLP` 设成绝对路径，例如 `C:\Tools\yt-dlp.exe`。`data` 所在磁盘至少留 512MB，不够就跳过这一集的音频下载。

上线前在服务器上手动冒烟，确认元数据和一条字幕会写成文件，并且能下音频。不要加 `--dump-single-json`，那个开关默认是模拟模式，字幕和 `info.json` 都不会落盘。也不要一次请求 `zh-Hans`、`zh-Hant`、`ja` 或 `.*-orig`：英文节目的 `zh-Hans` 是自动翻译，会 HTTP 429，第一条失败时 `.vtt` 和 `.info.json` 都不会生成；`.*-orig` 会一次匹配二十几种语言。把下面的视频换成任意公开视频：

```text
mkdir %TEMP%\yt-smoke
yt-dlp --js-runtimes node --skip-download --write-info-json -o "%TEMP%\yt-smoke\%(id)s.%(ext)s" -- "https://www.youtube.com/watch?v=jNQXAC9IVRw"
```

打开生成的 `.info.json`，看 `language`、`subtitles`（人工）和 `automatic_captions`。再只下一轨。`language` 是 `en-US` 这类英文、且没有人工原语种字幕时：

```text
yt-dlp --js-runtimes node --skip-download --write-auto-subs --convert-subs vtt --sub-langs "en-orig" -o "%TEMP%\yt-smoke\%(id)s.%(ext)s" -- "https://www.youtube.com/watch?v=jNQXAC9IVRw"
```

中文节目有人工 `zh` 时，把这一条换成 `--write-subs --sub-langs "zh"`。主语言取 `en-US` 的 `en` 这一段。第一条必须生成 `.info.json`。第二条只应多出一个 `.vtt`。然后再确认音频：

```text
yt-dlp -f bestaudio -x --audio-format wav --js-runtimes node -o "%TEMP%\yt-smoke\%(id)s.%(ext)s" -- "https://www.youtube.com/watch?v=jNQXAC9IVRw"
```

有 wav 后把整个目录删掉。`config/youtube-podcasts.json` 缺失时，日志写明路径，页面只显示「配置缺失」，不会悄悄当成空名单。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `AI_CENTER_YOUTUBE_PODCASTS` | 关 | `1` / `true` / `on` / `yes` 才跑。其他值或不设置都不跑。 |
| `AI_CENTER_YOUTUBE_PODCASTS_AT` | `07:00` | 每天一次，`HH:MM`。写错时改用 07:00，Worker 仍能启动。 |
| `AI_CENTER_YOUTUBE_PODCASTS_TIMEZONE` | `Asia/Shanghai` | 上面时刻的时区。 |
| `AI_CENTER_YOUTUBE_PODCASTS_INTERVAL_MS` | `8000` | 两次外部请求之间的间隔，1000–120000。 |
| `AI_CENTER_YOUTUBE_PODCASTS_ROUND_LIMIT` | `24` | 每轮最多探测多少个视频，1–80。 |
| `AI_CENTER_YOUTUBE_PODCASTS_TRANSCRIBE_MINUTES` | `90` | 每轮转写音频的分钟上限。本轮还没转过时，第一集可以超出这个数。已经转过之后再超出，记 `transcribe-budget`，下一轮再试。 |
| `AI_CENTER_YOUTUBE_PODCASTS_EPISODE_MINUTES` | `180` | 可选。单集转写上限。更长的记 `transcribe-too-long` 并跳过，不再每天重探。 |
| `AI_CENTER_YOUTUBE_PODCASTS_MAX_RUNNING_MS` | `10800000` | 可选。Worker 允许这一轮最多跑 3 小时。进程内的截止时间比它早 10 分钟，最短 1 分钟，好让子进程先停干净。 |
| `AI_CENTER_YOUTUBE_PODCASTS_SUMMARY_MODEL` | 空 | 可选。摘要模型。空着就用现有的 Gemini 摘要模型。 |
| `AI_CENTER_YOUTUBE_PODCASTS_LOOKBACK` | `2` | 每个频道第一次只留下最近几集，1–5。 |
| `AI_CENTER_YOUTUBE_COOKIES` | 空 | 可选的 Netscape cookies 文件。默认不传给 yt-dlp。 |
| `AI_CENTER_YT_DLP` | `yt-dlp` | 可执行文件名或路径。 |

转写和摘要继续用已有的 `GEMINI_API_KEY` 到 `GEMINI_API_KEY5`，密钥轮换和额度冷却不变。`AI_CENTER_JEV_ENABLED=false` 不影响这一路。

## 增减频道

改 `config/youtube-podcasts.json`，然后同时重启 Web 和 Worker。

- `kind: "channel"` 配 `handle`，用 `https://www.youtube.com/feeds/videos.xml?channel_id=`。有 `channelId` 就直接用，不再打开频道页。没有时才解析一次，写进 `youtube_podcast_channels`。现有频道都已经写上核对过的 `channelId`。
- `kind: "playlist"` 只抓这个播放列表，不抓整个频道。Odd Lots 必须保持播放列表 `PLe4PRejZgr0OJbRzA6nWybYiThLJd_ouz`。
- 同一博主的多个频道放在同一个 `creators[].id` 下，并用 `role` 标 `video` 或 `audio`。硅谷101 的视频版和音频版共用 `valley101`。
- `prefer: "zh"` 只留中文原版。张小玺的英文配音版会在同一期里被丢掉。
- `language` 只在 `info.json` 没有 `language` 时兜底。硅谷101、张小玺和大佬透镜是 `zh`。英文频道是 `en`。视频语言仍为空、且自动字幕里只有一条 `*-orig` 时，就下这一条。
- 删掉一个博主后，已经入库的集仍留在库里，页面会排在配置列表后面。

## 怎么跑

Worker 在开关打开时注册 `youtube.podcasts.sync`，默认每天北京时间 07:00。开关关闭时日程仍写入，但是 `enabled: false`，不会发请求。

手动触发（开关必须先打开，Worker 必须在跑）：

```text
node --env-file=.env scripts/youtube-podcasts-run.mjs
```

本机或已配对设备的页面上有「检查新的一集」，对应 `POST /api/v1/youtube-podcasts/sync`，权限是 operator。只读令牌不能调用。开关关闭时页面写「未开启」，接口返回 409。已经排队或正在跑则不再入队。

每轮一行：

```text
[worker] youtube-podcasts discovered=N subtitles=N transcribed=N failed=N skipped=N transcribeUnavailable=N stopped=- reasons=-
```

只有 `yt-dlp` 退出码不是 0、并且 stderr 的 `ERROR:` 行里出现人机验证或 HTTP 429，才因这两件事停止本轮。stderr 里的 `yt-dlp: error:` 或 `no such option` 也停止本轮，不计入尝试次数。视频简介里的「429」不会停轮。RSS 和频道页只在状态码不是 2xx 时做这个判断。请求超过 15 秒按这一条失败，不停止整轮。Gemini 或 Gemma 的 429 和额度错误也不计入尝试次数，直接停止本轮。当前这一集不写完成，下一轮从这里继续。找不到 `yt-dlp` 同样停本轮。

探测分两步。第一步只用 `--skip-download --write-info-json`，不写字幕。时长、直播状态、`language`、人工 `subtitles` 和 `automatic_captions` 都从 `<视频 id>.info.json` 读。第二步只下一条：人工中文或人工原语种优先，否则下 `<主语言>-orig`（`en-US` 对上 `en-orig`）。不传 `--dump-single-json`，也不传 `zh-Hans`、`zh-Hant`、`ja` 或 `.*-orig`。字幕这一步的 `ERROR:` 行如果是 HTTP 429，仍停止本轮。stdout 上限 16MB，stderr 仍是 256KB。`info.json` 解析失败或没有时长时记 `failed` / `probe-parse`，不会当成短片永久跳过。

Worker 允许这一轮跑满 `AI_CENTER_YOUTUBE_PODCASTS_MAX_RUNNING_MS`（默认 3 小时）。进程内截止时间早 10 分钟。到点后结束 `yt-dlp` 和它拉起的 ffmpeg：Windows 用 `taskkill /T /F`，其他系统结束进程组。手动再入队时，上一轮已经停干净，不会两轮同时写同一个音频文件。音频放在实例 `tmp/youtube-podcasts` 下的独立目录，文件名带视频 id，转写完连同 `.part` 一起删除。Worker 启动时清掉这个目录；目录正被占用时只记日志，不因此拒绝启动。下载前如果剩余空间不足 512MB，就跳过这一集。

## 过滤和文字

发现走 RSS，不翻频道页。时长、直播状态和字幕写在工作目录的 `.info.json` 和 `.vtt` 里，不使用 `--dump-single-json`。只要时长至少 20 分钟（配置里的 `minDurationSec`，默认 1200）。Shorts、标题里的切片和预告、正在直播和直播预告都丢掉。

去重两层：全局按 `videoId`；同一博主里，标题相近且时长差在 3 分钟或 8% 以内的，视为同一集。视频版优先于音频版，中文原版优先于配音。第一次每个频道只保留最近 1–2 集（探测窗口比这个多几条，避免短片占掉名额）。频道还没成功列出过 `/videos` 时，用 yt-dlp `--flat-playlist` 读最近 30 条，和 RSS 按 videoId 取并集：标题和发布时间以 RSS 为准，播放列表补上时长。有发布时间的按从新到旧排；没有时间戳的留在 `/videos` 原来的位置，避免被排到最后后让首次回溯截掉。探测窗口跑完才写 `backfilledAt`，以后不再列，哪怕这一轮没有正片入库。已经回溯过的频道这次同样只探测最近的窗口，多出来且库里还没有的记 `lookback`。已经有记录的集不改，避免把入库的正片覆盖成跳过。窗口没跑完（人机验证、429、截止时间或达到本轮探测上限）不写这个时间，也不算失败，下一轮重新列。列出失败才计入次数，同一天（Asia/Shanghai）不再试，下一天再试，最多 3 次。人机验证或 HTTP 429 不计入这 3 次。播放列表频道不走这一步。频道没探测完不会标成已回溯，避免把后面的集提前标成跳过。

文字来源记在抓取元数据和页面上：`subtitle-manual`（人工字幕）、`subtitle-auto`（原语种自动字幕）、`gemini-transcribe`（语音转写）。页面上分别写成人工字幕、自动字幕、语音转写。完整文字稿在内容正文，摘要在 `summary`。作者 id 是 `youtube:<博主 id>`，硅谷101 两个频道算同一个作者。发布时间用 RSS 的上传时间。`provider` 为 `youtube`。

小时报、信息流列表、窗口查询、搜索和研究召回都显式排除 `provider=youtube`，不依赖质量规则碰巧挡住。作者页按 id 读取时放行这些条目，所以 YouTube 标签下能看到已入库的集。

自动字幕只下与视频主语言一致的那一条 `*-orig`（`en-US` 对上 `en-orig`，不会把 `ar-orig` 也当成原语种）。不下载自动翻译的 `zh-Hans`、`zh-Hant` 或 `ja`。原视频地址一律用 `watch?v=`，并放在 `--` 后面交给 yt-dlp。超过 6 万字的文字稿分段摘要后再合并。摘要模型可用 `AI_CENTER_YOUTUBE_PODCASTS_SUMMARY_MODEL` 单独指定。配置文件缺失时，页面只写「配置缺失」，不带服务器路径。

## Gemini 用量

首批 12 个频道大约每周 20 集，平均一天 3 集左右。多数频道有字幕，只有摘要一次 `generateContent`。按大约八成有字幕估算：每周约 16 次摘要、4 集转写。转写按现有额度切块，大约每 8 分钟一段；一集 50 分钟大约 6 次。一周合计大约 40 次 Gemini 调用，一天常态大约 6 次。张小玺中文原版经常没有字幕，新的一集会吃掉转写额度；每轮转写默认不超过 90 分钟，多出来的下一轮再做。摘要已经是中文时不调用 Gemma。偶发英文摘要大约每周 0–5 次 Gemma 26B。

## 试跑之后

没有字幕时，下载音频之前先确认转写函数和 Gemini 密钥。一轮开始先做这一次检查。密钥或转写器不可用就打一条警告，这一轮 `audioDisabled`：有字幕的集照常入库；要转写的集不下载音频，记 `failed` / `transcribe-unavailable`，尝试次数不加，然后继续下一集。轮到一半才发现不可用（例如密钥刚被吊销）也一样，不停止整轮。`transcribeUnavailable` 记下这种集的数量。以前 `executeAudioTranscription` 没有收到 `transcribe`，会在整集音频下完之后才抛 `transcribe is not a function`，并且整轮停住。

频道页的 15 秒限制以前从发出请求就开始，响应头到达后读正文仍算在同一段里，正文超时也没有收成「频道页超时」。现在响应头和正文各有 15 秒。配置里写了 `channelId` 的频道不再请求频道页。大佬透镜是第 12 个频道。

Dwarkesh 这类频道的 RSS 最新条目可能全是切片。补录只看有没有成功列出过视频，不看库里有没有 `ready`。全被去重成 `skipped` 的音频频道，或者转写一直失败的频道，补录窗口跑完之后就停。已经回溯过的频道也不会把 `/videos` 里最多 30 条都拿去探测。flat-playlist 的 `timestamp` 经常是空的，这些条目保持 `/videos` 从新到旧的顺序，不因为 `publishedAt` 为 0 被排到末尾。

## 上线

1. 装好 `yt-dlp`（≥ 2025.11.12）和 `ffmpeg`，不要装 Deno。跑 `node scripts/ensure-yt-dlp.mjs`，并确认 `yt-dlp --version` 不低于 2025.11.12。`data` 所在磁盘至少留 512MB。
2. 可选环境变量：`AI_CENTER_YOUTUBE_PODCASTS_EPISODE_MINUTES`（默认 180）、`AI_CENTER_YOUTUBE_PODCASTS_MAX_RUNNING_MS`（默认 3 小时）、`AI_CENTER_YOUTUBE_PODCASTS_SUMMARY_MODEL`（默认沿用现有 Gemini 摘要模型）。需要时再设 `AI_CENTER_YOUTUBE_COOKIES`。默认不要设。
3. 部署后同时重启 Web 和 Worker。migration 86 和 87 在启动时自己加上。87 只加列。不要重建数据库，不要删已有 migration。
4. 确认开关仍是关的，日志里不应出现对外请求。准备试跑时再设 `AI_CENTER_YOUTUBE_PODCASTS=1`，再次同时重启 Web 和 Worker。
5. 手动入队：`node --env-file=.env scripts/youtube-podcasts-run.mjs`。入口在信源目录「社媒」，紧挨着 B 站。列表不显示标签和分享。开关打开后先跑一轮，确认长节目的 `durationSec` 是实际分钟数，不是 0，也没有被记成 `short`。有字幕的集日志里 `subtitles>0`，`transcribed` 应接近 0，几乎不走语音转写。
