# X 视频整理接上转写

2026-10-21。Miles Cranmer 那条 `2111105654211608847`（3336 秒）整理失败，日志是 `x-video 整理没有完成：transcribe is not a function`。任务把 `deps.geminiTranscribe` 交给转写，Worker 装配时没有传入这个函数。

现在这个函数接到 #194 的 `executeAudioTranscription`。调用时不传入 `transcribe` 或 `fileTranscribe`，所以不会直接打到旧的 `createGeminiAudioTranscriber`。先走 `gemini-3.5-transcribe-live`，只有 Live 失败才用 `gemini-3.5-transcribe`，文件转写每天仍停在 24 次。长音频的切段也留在这一层：按每分钟 20000 token 切开，3336 秒会分成多段，每一段都短于 Live 的 10 分钟会话。密钥只读 `GEMINI_API_KEY` 到 `GEMINI_API_KEY5`，以及 `AI_CENTER_GEMINI_KEY_ENVS` 里点名的环境变量，不写进代码。

以前因为 `transcribe is not a function` 记成失败、当天被拦住的条目，下一轮会清掉这次失败再转写，不另占当天名额。

不新增 migration。当前 schema 仍是 95。下一号是 96。空号仍是 63、79、80、82。不要重建数据库。需要重启 Worker。页面没有改，Web 不用为这项重启。
