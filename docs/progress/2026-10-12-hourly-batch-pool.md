# 2026-10-12 小时分类攒批与日志

21:00 这一小时 77 条材料用了 56 次阅读分类，平均约 1.4 条/次。调用次数少于材料数，所以不是整批解析失败后再逐条重打（那样调用次数会多于未缓存材料）。信息准备仍是一条一个任务，每准备成功就补一次小时任务。每次小时任务只给还没分类的新材料打分，常见就是 1–2 条，于是每批都没凑满。

## 分类

同一小时里未分类的材料跨来源、跨这次到达攒在一起。凑满 `AI_CENTER_READING_CLASS_BATCH`（默认 10）才调用。不够一批时不调用，也不写入失败阶段，下一次小时任务仍会看见它们。这一小时没有还会变成信息节点的待处理来源时，才把剩下的短批发出去。`information-not-ready` 和可重试的准备失败继续等待；只剩 `needs-content` 这类终态时不等。`AI_CENTER_READING_CLASS_BATCH=1` 仍是一条一次，马上调用。

缓存、阶段键和页面字段不变。配额耗尽仍不拆成逐条。只含一条时，若模型按单条提示返回一个对象，按这一条收下。对象里的 `domainTagIds: []` 不再被切成空数组。多条却只返回一个对象时，仍整批回退到逐条。

每次模型调用写一行：

```text
[worker] reading-class batch=10 fallback=0 key=KEY2
[worker] reading-class batch=1 fallback=1 reason=parse-failure key=-
```

`fallback=1` 的原因是 `parse-failure`、`missing-idx`、`invalid-output` 或 `duplicate-idx`。配额或上游失败的那一次是 `fallback=0`，并带 `outcome=budget-deferred` 或 `outcome=error`，不会再记逐条回退。`key` 只保留 `KEY`、`KEY2` 这种后缀。

## 浓缩失败

13/58 约两成失败与上面的分类调用不是同一批。浓缩仍按 Tag 分组，输入按 12000 字节拆开，Google 小时输出上限默认 4096。分组大时，输入没超字节预算，模块 JSON 仍可能被输出上限截断，修一次 JSON 之后还是解析失败。上游 4xx/5xx 和 180 秒执行超时也会落在这 13 次里。这次没有改分批大小、超时或模块字段，因为这 13 次没有按原因拆开。

失败行在原有字段上增加 `key`、`body`、`inputChars`、`finish`。`status`、`model`、`inputBytes` 继续保留。`body` 是上游响应或校验失败时的回答片段，先脱敏再截断。密钥不入库、不进这行。刊期和模块契约不变。

## 日志停写

Web 停在 22:13:56，Worker 更早停在 18:09，两个进程的 PID 都还在，所以不是同一次午夜换文件。`start-ai-center.ps1` 用重定向读子进程输出，在收到一行时直接写文件。这个回调一旦抛错，.NET 就不再继续读管道。管道写满后，Node 还能活着，但再写 stdout/stderr 会堵住，日志就停了。按日打开的文件句柄也不会跟着日期换到新文件。

现在读管道的回调只把行放进有上限的队列，写文件在单独线程里做。队列满了就丢掉一行旧的，不堵住子进程。写失败会关掉并重新打开文件，再试一次。文件名里的日期变了，就改写到当天的 `web.out.yyyy-MM-dd.log` / `worker.out.yyyy-MM-dd.log`（错误日志同样）。打开时允许其他程序读、写、删除。

## 重启

分类和浓缩日志在 Worker 里。日志泵在启动脚本进程里，只重启 Worker 不会换掉已经编译的写入器。需要重新跑 `start-ai-center.ps1`，让 Web 和 Worker 一起被拉起。`AI_CENTER_HOURLY_DISABLED=1` 时小时任务仍然不会运行。
