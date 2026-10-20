# X 长视频整理

2026-10-20。信息流里抓到的 X 帖如果带视频，时长达到门槛就进入和 YouTube 播客共用的整理队列。引用帖里的视频也算。同一个视频只整理一次。短视频记为跳过，不占名额，详情仍是原来的帖子。

转写不用字幕，也不读取 cookies。公开的 syndication 信息里取最低码率的 `video/mp4`，只允许 `https://video.twimg.com/`。先抽出单声道 16 kHz WAV，再交给现有的 Gemini `gemini-3.5-transcribe`。临时的 mp4 和 wav 用完就删。每个分块带上开始时间。说话人只有在转写结果里出现时才保留。

翻译和整理复用 YouTube 的 Gemma 管线：先去重，再按说话人或句末切段，Gemma 26B 翻译，Flash 只补缺段。正文按时间顺序写谁说了什么，开头仍是原来的导读。标题在正文完成后由 Gemma 根据正文来写。同一段失败 3 次写成失败。X 视频不走豆包。整理结果写在视频表里，不覆盖帖子正文。

每天的整理名额仍是 `AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY`（默认 4）。X 另外有自己的上限，避免首页一下子涌进很多长视频，把播客队列挤掉。一条一条补录只受共用名额限制，不受这个 X 上限限制。YouTube 先占用当天名额，X 用剩下的。

文章页在这条 X 帖的详情里读中文长文。「原帖」打开 X。阅读位置沿用文章页已有的记录。排队、失败和名额已满的提示与 YouTube 相同。作者页点开同一条详情。播客页不加 X 入口，那里只放配置好的 YouTube 博主。

环境变量：

- `AI_CENTER_X_VIDEO_ARTICLE`：默认打开。`0` 关闭。
- `AI_CENTER_X_VIDEO_ARTICLE_MINUTES`：时长门槛，默认 15，范围 1 到 180。
- `AI_CENTER_X_VIDEO_ARTICLE_DAILY`：X 每天自动整理的上限，默认 1，范围 0 到 4。

migration 93 `x_video_articles` 只新增 `x_video_articles` 和 `x_video_posts`。当前 schema 是 93。下一号是 94。空号仍是 63、79、80、82。不要重建数据库。需要同时重启 Web 和 Worker，浏览器再加载一次。

一条 56 分钟的视频大约 7 次 Gemini 转写（每段最多 500 秒）。Gemma 26B 大约每 1.1 万字一段，每段一次翻译、一次整理，再加上开头导读和标题。英文讲座大约 8 到 14 次。某一段 Gemma 失败时，这一段才改用现有 Flash。
