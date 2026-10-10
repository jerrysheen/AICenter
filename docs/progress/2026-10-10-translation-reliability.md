# 翻译可靠性

官方信息流在 Gemma 500 或 Worker 重启（任务租约过期）后一直显示「正在翻译…」。翻译任务失败没有记到条目上，页面画完进行中之后也不再刷新。

## 决定

- 翻译任务最多 4 次。失败写入 `feed_translation_failures`（migration 50），退避 1 秒起、指数增加、单次不超过 5 分钟。次数用尽后 `next_retry_at` 为空，状态停在失败。成功译文会清掉失败记录。
- 配额等待（`budget-deferred`）仍按 `retryAt` 延期，不改成这套短退避。
- 信息流读取失败状态：标题用原文，官方条目标明「暂未翻译」。进行中仍显示「正在翻译…」。这不是前端超时改文案。
- 调用翻译前先用小时报信息节点的中文标题，以及相同原文哈希的已有译文。不改小时报生成。
- 入库标题和摘录解码 HTML 实体，并去掉视频播放器残留文字。
- Gemma 上游失败在 Worker 日志写状态码和响应体，密钥打成 `[redacted]`。不改模型名或密钥配置。

## 验证

见 `test/translation-reliability.test.js`。`npm run syntax` 与 `npm test` 对照 main 基线。
