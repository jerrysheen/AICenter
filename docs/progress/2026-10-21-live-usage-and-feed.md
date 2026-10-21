# Live 转写用量、关注信息流和文章作者

2026-10-21。Cranmer 那期 `2111105654211608847:1`（3336 秒）在 11:39 到 12:11 有 12 次 Live 调用，正文没有写回。

这 12 次是 WebSocket，不会进 `model_usage_index`。3336 秒按每分钟 20000 token 切成 7 段，大约 500 秒一段。某一段连接失败会再试，其余段被取消，所以次数可以到 12，而不是 7。会话 setup 带了 `responseModalities: TEXT`。这个字段会压住最终的 `inputTranscription`，上游仍把会话算一次。本地等到 `turnComplete` 超时后把已经收到的文本丢掉，`onSegment` 不会写整理记录。

现在 Live 地址不再带 `?key=`。密钥只放在 WebSocket 握手的 `x-goog-api-key` 头里。日志和异常仍只留类别，不留地址和密钥。每次 Live 调用按现有用量格式写入 `model_usage_index`：先 `pending`，成功是 `succeeded`，失败是 `failed`，取消是 `interrupted`。只存密钥后四位。setup 不再带 `responseModalities`。音频已经送完并且收到最终转写时，即使没有 `turnComplete` 也留下这段文本。

信息流「全部」只列出挂在 `x:home:following` 上的帖。Cranmer 那条搜得到、作者页也有，是因为来源不是关注流，后一次同步还会把关注来源写掉。现在关注来源不会被空来源或另一次同步清掉。`scripts/repair-x-following-feed.mjs` 把这类帖挂回去，不改标题，也不另建整理任务。先 `--dry-run`。搜索结果带上已保存的译文预览，和作者页一样显示「以下是演讲全文：」，不再只在搜索里标「暂未翻译」。文章页打开时用已经在手里的帖子先画出作者，正文区域写「正在读取正文…」。

不新增 migration。当前 schema 仍是 95。下一号是 96。空号仍是 63、79、80、82。不要重建数据库。需要同时重启 Web 和 Worker，浏览器再加载一次。这一集不用重新整理，也不要改标题。服务器上先看会动哪些帖：`node scripts/repair-x-following-feed.mjs --dry-run`。确认后再去掉 `--dry-run`。
