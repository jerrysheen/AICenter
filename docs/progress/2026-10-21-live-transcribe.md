# 语音转写改走 Live

## 目标

`gemini-3.5-transcribe` 每天只有 25 次，TPM 也已经超过 10K。YouTube 和 X 长视频的转写改走 RPD 不限的 Live 模型，默认 `gemini-3.5-transcribe-live`。只有 Live 失败时才回到原来的文件转写。

## 决定

模型名在配置里。`AI_CENTER_AUDIO_TRANSCRIBE_LIVE_MODEL` 默认 `gemini-3.5-transcribe-live`。`AI_CENTER_AUDIO_TRANSCRIBE_MODEL` 默认 `gemini-3.5-transcribe`，只给回退用。

Live 把 16 位 PCM 切成大约 100 毫秒一帧，通过一条 Live 会话按顺序送上去。发送速度按每秒 32 token、每分钟 20000 token 拉开，不把一整段在同一瞬间打满。多声道先合成单声道。连接地址和密钥不写进日志，报错里的密钥会抹掉。

Live 失败以后，这一段再按非 Live 的 10K TPM 切开，本地每天停在 24 次，留给限额 25 次里的一次余量。按太平洋日计算。不改走其他计费服务。

不新增 migration。当前 schema 是 95。下一号是 96。空号仍是 63、79、80、82。不要重建数据库。

需要重启 Worker。页面没有改，Web 不用为这项重启。
