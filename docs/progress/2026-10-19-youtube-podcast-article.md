# 2026-10-19 YouTube 播客正文

单集「展开全文」原来把 YouTube 字幕原样放在 `<pre>` 里：英文，大约每 2 到 3 秒一行时间戳。15 集里有 12 集是自动字幕，下一行会重复上一行的后半句。摘要仍由 Gemini 生成，这次只换正文。

正文默认走仓库里现有的 Gemma 翻译池，模型是 `gemma-4-26b-a4b-it`，只打 Google 官方 `generativelanguage.googleapis.com`。不新接计费服务，代码里不读写密钥。Gemma 在配额窗口里失败时先停下来，下一轮只补缺的段。除此之外的失败，缺的那一段可以改用现有的 Gemini Flash（`gemini-3.1-flash-lite`，仍是官方 endpoint）。豆包网页还留着，但要显式设置 `AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_ENGINE=doubao`，不是默认。标题、摘要和关键句仍只用 Gemma 26B，不走 Flash，也不走豆包。

## 开关

总开关 `AI_CENTER_YOUTUBE_PODCASTS` 仍要打开。正文开关是 `AI_CENTER_YOUTUBE_PODCASTS_ARTICLE`，默认关闭。关闭时新集仍把原字幕放进正文，和以前一样。

打开后，每天最多处理 `AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_DAILY` 集，默认 2，允许 1 到 8。计数按 Asia/Shanghai 的日历日，从这一集真正开始整理时算起。同一天重启会接着做已经开始的集，不重复占名额。已经整理完、原字幕没变的集会跳过，所以重复跑是安全的。已入库的 ready 集也走这个限额回补。开关打开后去重稿会写进 `content_item.body`，中途失败时信息流里显示的是去重稿而不是原始字幕。

英文标题和摘要里的英文关键句不看这个开关。每轮用 Gemma 补译，默认最多 8 条，环境变量是 `AI_CENTER_YOUTUBE_PODCASTS_TITLE_DAILY`（1 到 30）。

## 整理方式

1. 本地去掉自动字幕的滚动重复。比较不区分大小写，重叠至少约 12 个字符，或至少两个词，并且落在词边界上。对不上的行整句保留，人工字幕的词不会被删。时间戳只留在说话人切换，或距离上一次标记大约 45 秒的位置。
2. 按句末或 `>>` 说话人切换切开。默认每段不超过 `AI_CENTER_TRANSLATION_CHUNK_CHARS`，和 Gemma 翻译池一样，默认 1500，允许 400 到 2400。不按时钟硬切。最后一段可以短一些。`Mr.` 和小数不会被当成句号。
3. 按顺序处理每一段。先看原文语言：汉字已经够多，就不再翻译，原文直接当作译文，`provider` 记为 `source`。英文段交给 Gemma 26B 译成简体中文，`provider` 记为 `gemma`；这一次 Gemma 失败且不是配额窗口时，改用 Gemini Flash，`provider` 记为 `flash`。译完一段就写入 `article_state`。每一段同时记下 `calls.gemma` 和 `calls.flash`，抛出的那一次也算。要点摘要另记 `summaryProvider` 和 `summaryCalls`。已经译完的段不再发送。调用走现有翻译池：同密钥间隔、每分钟请求和每日上限都由这个池拦住。遇到 `budget-deferred` 就停掉这一轮，进度留着，下一轮只补缺的段。
4. 每一段都有译文之后，再让 Gemma 排版。每一段译文收成一个带中文主题的小节，时间可以写在主题后面，例如 `## 利率路径（00:12:03）`，也可以不写。只有时间的标题，例如 `## 00:00:00`，会用这一节的第一句改成主题。保留发言人和关键数据。然后用各节标题写开头的要点摘要。一篇文章拼成「要点」加这些小节。排版同样遵守配额窗口，缺的小节或还没写成的要点才会再请求。已经整理完、但有中文段被译成英文，或小标题只剩时间的集，下一轮会修好这些段，已经正确的英文段不重译。修复期间页面仍显示原来的文章，完成后再替换。
5. 同一段最多尝试 3 次。Gemma 在配额窗口之外失败时，这一段改用现有 Gemini Flash 再要一次正文。Flash 也失败，就留下去重稿，`article_status` 为 `pending`，页面标「待整理」。用尽次数后当天不再撞这一集，第二天再试。
6. 显式 `AI_CENTER_YOUTUBE_PODCASTS_ARTICLE_ENGINE=doubao` 时，仍用已有的豆包网页客户端：同一对话逐段发送，没确认发出的可以重发，已经发出但没读到回复的只重读。这不是默认。未登录或页面改版会停掉当天剩下的豆包整理。

## 页面和数据

整理完成的正文按 Markdown 显示小标题、段落和发言人，替换原来的「展开全文」。原字幕不再显示。原字幕仍在 `youtube_podcast_episodes.source_transcript`，用来重跑。

不新增 migration。分段译文、小节和要点都写在 migration 89 的 `article_state` 里。当前 schema 仍停在 91。不要重建数据库。需要同时重启 Web 和 Worker，浏览器再加载一次。

## 另外三处

- 标题以前只在整篇摘要不像中文时才翻译。中文摘要配英文 `titleZh` 会留在页面上，例如 Odd Lots · Don Wilson。现在标题本身不是中文就单独交给 Gemma。摘要里的英文关键句同样处理。摘要提示也要求标题和关键句用简体中文。
- `transcribe is not a function` 已在主线修复：一轮开始会确认转写函数，缺失时不下载音频，有字幕的集照常入库。曾经因为这句错误被跳过的集，下一轮会再收一次。
- Gemini 摘要遇到 HTTP 503、500、429、配额或连接超时，会在同一次摘要调用里换密钥重试。默认再试 3 次，环境变量 `AI_CENTER_INVESTOR_DIGEST_SUMMARY_RETRIES`，范围 0 到 6，间隔 1 秒、2 秒、4 秒，上限 8 秒。同一次调用仍失败，才给这一集加一次尝试；满 3 次改为跳过，下一轮不再自动收。这次不改这条策略，也不清已有的尝试次数。
