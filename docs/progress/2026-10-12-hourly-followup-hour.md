# 2026-10-12 补跑小时和浓缩调用日志

00:30 这一轮处理的是 23:00。阅读分类 6 次都是 10 条，没有逐条回退，也没有超时。1 次 `HarnessModelError` 换 key 后成功，最慢 98.5 秒。刊期是 partial，10 条还没处理。Worker 日志已经能持续写。随后出现的 60 秒补跑 `e597eda1` 的 `hourStart` 是 20:00，不是 23:00。

## 补跑小时

定时任务没有指定 `hourStart` 时，会先生成刚刚结束的那一小时，再从更早的 23 个小时里挑一个还要处理的小时回补。23:00 的 10 条是刊期上的 `information-not-ready`，分类本身已经成功，所以分类延后计数是 0。回补到的 20:00 阅读快照里仍有 `classification-failed`，旧逻辑就把补跑排给了 20:00。

补跑小时现在只取这次任务自己的主小时：调用里写了 `hourStart` 就用它，否则用返回的第一份刊期。回补小时上的旧分类失败不再成为这张补跑的目标。主小时出现分类失败或配额延后时，原因是 `classification-deferred`。主小时刊期 `pendingCount>0` 时，原因是 `edition-pending`。两种情况只排一张任务。这张补跑自己再跑时不再排下一张。

## 浓缩调用

用量里 6 条对应 3 次 `tree-hourly` 调用，因为同一次调用会各记 `request` 和 `turn`。三次都是 `gemini-3.1-flash-lite`，约 20 秒内失败，输入输出都是 0 token。同一窗口的 Gemma 翻译收到上游 500 INTERNAL。这是上游 5xx 或拒绝，不是输出截断，也不是 JSON 解析。Worker 日志里没有 `tree-hourly` 行，是因为原来的失败行写在 stderr，前缀也不是 `tree-hourly`，用量记录又不带状态和响应。

每次小时浓缩的 `runBounded` 都在 `finally` 里用 `console.log` 写一行：

```text
[worker] tree-hourly kind=model-5xx status=500 message=... body=... model=gemini-3.1-flash-lite key=KEY inputBytes=... finishReason=OTHER latencyMs=... outcome=error
```

`body` 先脱敏，再留前 300 字。`console.log` 走标准输出，Node 按日日志把它追加到 `worker.out.yyyy-MM-dd.log`。

已配置至少两把 Google key 时，非配额失败（包括 500/503）换下一把 key 再试一次，然后才换模型或结束。配额仍可以走完其余 key，并且不占用这一次换 key。只配置一把 key，或没有走 Google key 列表时，500/503 仍按原来的次数重试当前模型。模块输出契约不变。
