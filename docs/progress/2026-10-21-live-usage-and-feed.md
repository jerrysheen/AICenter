# Live 转写用量、关注信息流和文章作者

2026-10-21。Cranmer 那期 `2111105654211608847:1`（3336 秒）在 11:39 到 12:11 有 12 次 Live 调用，正文没有写回。

这 12 次是 WebSocket，不会进 `model_usage_index`。3336 秒按每分钟 20000 token 切成 7 段，大约 500 秒一段。某一段连接失败会再试，其余段被取消，所以次数可以到 12，而不是 7。会话 setup 带了 `responseModalities: TEXT`。这个字段会压住最终的 `inputTranscription`，上游仍把会话算一次。本地等到 `turnComplete` 超时后把已经收到的文本丢掉，`onSegment` 不会写整理记录。

现在 Live 地址不再带 `?key=`。密钥只放在 WebSocket 握手的 `x-goog-api-key` 头里。日志和异常仍只留类别，不留地址和密钥。每次 Live 调用按现有用量格式写入 `model_usage_index`：先 `pending`，成功是 `succeeded`，失败是 `failed`，取消是 `interrupted`。只存密钥后四位。setup 不再带 `responseModalities`。音频已经送完并且收到最终转写时，即使没有 `turnComplete` 也留下这段文本。

信息流「全部」只列出挂在 `x:home:following` 上的帖。Cranmer 那条搜得到、作者页也有，是因为来源不是关注流。`scripts/repair-x-following-feed.mjs` 只把真正该在关注源下的帖挂回去：作者在作者页已经关注，或者捕获上有 following 标记（`homeFeed`、`feed`、`sourceInput.feed`，或来源账号的 `sourceInput.feed`）。推荐页里还没关注的作者、作者页来源（`x:author:`、`x:profile:`、`x:user:`，或来源标记为 author / profile）、搜索来源（`x:search`），以及 `x_video_posts` 或 `xVideo.own` 的视频帖，都不挪。不改标题，也不另建整理任务。

正式挪动之前，脚本把每条的 `capture_id` 和原来的 `source_account_id` 写进 `data/x-following-repair-backup-时间.json`。这个文件在 `data/` 下，不进 Git。回滚读这份备份，按捕获 id 把来源改回去，不经过 `saveCapture`。先 `--dry-run`。确认后再去掉 `--dry-run`。要还原时：`node scripts/repair-x-following-feed.mjs --rollback data/x-following-repair-backup-时间.json`。

原先的 upsert 只要当前来源是关注源，后来的同步就不能改。这样会把误放进去的陌生帖锁在「全部」里。现在只有作者已关注，或标记写明来自 following，后续同步才留在关注源。空的 `source_account_id` 仍然不会把已有来源清掉。陌生帖下一次带着别的真实来源写入时会离开关注源。从关注时间线同步进来的帖会写上 `homeFeed: following`，以后改写正文时这个标记还留着。

搜索结果带上已保存的译文预览，和作者页一样显示「以下是演讲全文：」，不再只在搜索里标「暂未翻译」。文章页打开时用已经在手里的帖子先画出作者，正文区域写「正在读取正文…」。

不新增 migration。当前 schema 仍是 95。下一号是 96。空号仍是 63、79、80、82。不要重建数据库。需要同时重启 Web 和 Worker，浏览器再加载一次。这一集不用重新整理，也不要改标题。服务器上先看会动哪些帖：`node scripts/repair-x-following-feed.mjs --dry-run`。确认后再去掉 `--dry-run`。
