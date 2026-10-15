# 2026-10-12 分类失败原因、补跑和 Worker 日志

23:30 这一轮（22:00 槽）阅读分类 18 次都是 `batch=10 fallback=0`，其中 9 次 `outcome=error`，日志里没有状态和错误信息。KEY2 失败 3 次，不是只有这一把 key。调用记录多于日志行。信息树 46 次里 8 次失败，没有 `MAX_TOKENS`，也不是 `kind=parse`。两个主任务大约 14 分钟，小时任务本身没有因为总时限被掐掉，刊期是 partial，58 条还没处理。Web 日志还在写，Worker 标准输出停在 23:44:18，错误输出停在 23:35:02，23:46 任务仍在跑。

## 分类失败

这 9 次不是配额（配额会记 `budget-deferred`），也不是 JSON 解析失败（解析失败会是 `fallback=1`）。10 条分类结果远小于 4096 的输出上限。9 次失败大约 9×90 秒，和两个任务合计约 14 分钟相符：当时单次调用上限是 90 秒，成功的很快返回，失败的是调用超时或上游错误，但日志只写了 `outcome=error`。

单次上限改为 180 秒，与浓缩调用一致。非配额失败再换下一把已配置的 key 试一次，然后整批记为失败并延后，不拆成逐条。配额仍走完所有 key，并且不占用这一次换 key。只配置一把 key 时不打第二次。

每次 `agentRuntime.run` 在 `finally` 里写一行，成功或失败都会留下。字段是 `batch`、`fallback`、`key`、`outcome`、`status`、`name`、`model`、`latencyMs`、`inputBytes`。失败再加 `body` 和 `message`。`outcome=timeout` 表示中止、超时。密钥会先脱敏。

用量观察器对同一次调用还会各写一条 `request` 和 `turn`，内部重试会再多一条 `request`。所以用量行数仍可能多于这一行分类日志。分类日志按一次 `run` 计，不再少行。

## 58 条未处理

刊期 `pendingCount` 是还没变成信息节点的来源数。9 个失败批是 90 条分类，不会正好是 58。58 主要是 23:30 发布时仍在 `information-not-ready` 的来源：信息准备一次一条，这一轮还没轮到它们。

另外两类也不会在这一小时里再被看见：

- 分类失败写入 `failed` 或 `budget-deferred` 之后，小时任务仍返回成功，不会再排同小时任务。下一轮定时处理的是最新的已结束小时。
- 文章整理打开时，准备完成后的补编槽是每小时第 30 分。23:30 之后新准备好的材料要等到下一小时的 :30，而不是这一小时内。

现在：分类里出现 `classification-failed` 或 `budget-deferred` 时，约 60 秒后再排一次该小时的 `report.hourly.extract`。已经排队的同小时任务不重复排。这次补跑带 `followUp=classification-deferred`，跑完不再连环补。只是还攒着、尚未送出的短批不触发补跑。过了本小时的准备槽之后，新准备好的材料在 60 秒后补进该小时；槽还没到时仍等到槽上。失败阶段不是缓存命中，补跑会重新分类。

## 浓缩失败

失败行本来就有 `kind`、`status`、`name`、`message`、`body`、`model`、`key`、`inputBytes`、`inputChars`、`finish`。这 8 次不是输出截断，也不是解析失败，模块契约和分包大小不改。原因打在 stderr。Worker 的错误管道先停，所以错误日志里看不到这 8 行。Node 现在把 stderr 追加到 `worker.error.yyyy-MM-dd.log`。

## Worker 日志停写

Web 和 Worker 用的是同一个日志泵，但 stdout、stderr 各有一个读取器。读取回调抛错，或底层读取被当成结束，只会停那一路。Worker 浓缩时 stderr 更密，错误日志先停；标准输出还能再写一会儿。dsh 子进程的标准流是自己的管道，不继承 Worker 的标准输出。共用写线程如果死掉，两个文件会一起停，这次不是。

Node 在 `AI_CENTER_LOG_DIR` 和 `AI_CENTER_LOG_NAME` 下用追加写入 `worker.out.yyyy-MM-dd.log` 与 `worker.error.yyyy-MM-dd.log`（Web 同理）。日期放在文件名里，不长期占着文件句柄。终端里仍打印。标准流不是终端时不再写管道，停掉的读取器不能把管道灌满并堵住进程。启动脚本仍排空管道并写下启动标记，同时把上述两个环境变量传给进程。
