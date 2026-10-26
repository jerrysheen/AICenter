# Live 转写按实时送帧，过稀不再算成功

## 目标

Gemini Live 整段标成成功，但字数只覆盖音频的一小段。Cranmer `2111105654211608847:1` 是样例：7 段 Live 都是 succeeded，合计大约 3816 字 / 3336 秒。同库其它长视频也只有大约每秒 1 到 2 个字。这一轮不重跑这一集。

## 决定

根因在送帧。`audio-transcribe-live.js` 用文件接口的每分钟 20000 token 计算下一帧要等多久。500 秒音频大约 16000 token，48 秒就送完，大约 10 倍实时。Live 近实时消化，多出来的被丢掉。各段 `inputTokens` 大约 1500 到 2200，期望大约是 `500 × 32 = 16000`。结果仍标 succeeded，所以不会进 `createGeminiAudioTranscriber`。

发送间隔改成音频时长的 1.1 倍实时，落在 1.0 到 1.2 之间。传入更快的倍数也会被夹在这个区间。每分钟 token 只在额度比实时更紧时把间隔再拉长，不再单独决定间隔。500 秒一段大约要 455 秒送完，仍短于 Live 的 10 分钟会话。

切段仍用 `planAudioTranscription` 的每分钟额度。3336 秒还是大约 500 秒一段、一共 7 段。续跑按起止时间对齐，改段长会让已经写下的分段对不上，下一轮会整段重转。这一轮不改段长，也不重跑 Cranmer。

一段在下面任一情况算 Live 失败，错误类别是 `live-sparse`：

- 用量里的 `inputTokens` 低于这段估计的一半。用量已经达到一半时，字数少不单独判失败，避免静音被当成丢音频。
- 没有用量，并且这段至少 30 秒、去掉首尾空白后少于每秒 3 个字。

`live-sparse` 先按同一套实时速度再转一次。第二次仍失败，才走原来的文件转写。文件转写每天仍停在 24 次。其它 Live 失败不先空转这一次，直接走原来的回退。

`turnComplete` 超时后，已经收齐并且不过稀的最终转写仍留下。只有中间结果，或者最终文本过稀，整段不算成功。

日志只写 `live-sparse` 这一类，不写密钥、`Authorization` 或连接地址。不新增 migration。当前 schema 仍是 96。下一号是 97。空号仍是 63、79、80、82。不要重建数据库。

需要重启 Worker。页面没有改，Web 不用为这项重启。

## 改动

- `packages/connectors/src/audio-transcribe-live.js`：实时送帧、过稀判定、超时不把残缺文本标成功。
- `packages/runtime/src/audio-transcription-job.js`：`live-sparse` 先再试一次 Live，再进入文件转写。
- `packages/domain/src/audio-transcription.js`：注明段长仍按额度，不跟着送帧速度变。
- `test/audio-transcribe-live.test.js`：送帧速度、过稀、超时和文件回退。

## 验证

不调用线上接口，不使用真实密钥。

```text
node --test test/audio-transcribe-live.test.js test/audio-transcription.test.js test/x-video-transcribe.test.js
npm run check
```

500 秒、16000 token 的发送时刻大约是 455 秒，不是按 20000 token 每分钟算出的大约 48 秒。额度收紧到每分钟 1000 token 时，间隔改由额度决定。1 秒音频在假时钟上大约走 0.91 秒；每分钟只允许 32 token 时大约走 60 秒。

`inputTokens` 为 1800、估计 16000 判过稀。用量够了但只有「嗯」不判过稀。没有用量、60 秒只有「hi」判过稀。`turnComplete` 超时且只有几个字，或只有 interim，抛 `live-sparse`，用量记失败。超时但最终文本和用量都够，仍返回原文。

任务层：第一次 `live-sparse`、第二次返回完整文本时不调用文件转写。两次都过稀时调用文件转写，警告里只有类别。假的 Live 套接字返回 `promptTokenCount: 2` 时，会话打开两次，然后文件转写接上，结果里没有密钥。

## 遗留

已经落库的稀疏转写不会自动重转。Cranmer 这一集按要求不重跑。新的长视频在 Worker 重启后按实时速度转写。
