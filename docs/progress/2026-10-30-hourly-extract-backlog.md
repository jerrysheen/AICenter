# 小时摘选不再堵住后面的整点

## 现象

2026-10-30 的 18、19、20 点有入库，类目小时没有刊期。近 48 小时 `report.hourly.extract` 完成约 59、失败约 79、排队约 31，同时能看到 running 停住和 `WorkerRunTimeout`。类目刊期只在这条任务的双跑路径里写。

## 原因

前台每类任务只有一个名额。排队时按优先级从高到低、同优先级按创建时间从早到晚领取。会出现这几件事叠在一起：

- 整点任务没有小时起点。`generateHourlyDigests` 会先做刚结束的小时，再做一个旧小时。类目写在这两次信息树之后。一次任务很容易顶到默认 45 分钟，记成 `WorkerRunTimeout`。超时发生在信息树里时，类目还没写。
- 调度每小时都新插一条整点任务，不看前面是不是还排着。旧任务创建更早，会先被领走。后面的整点一直等。
- 另一条小时通道上只要有任务在跑，没有小时起点的整点会被看成「同一版本」直接完成，原因是 `already-running`。这一小时不再跑，类目也不会写。
- 租约中断会把 `report.hourly.extract` 的 `max_attempts` 一直加一，并立刻重新入队。同一小时可以反复回到队列头。
- 信息树返回可重试失败时，任务抛错后再入队。失败补跑调度虽然关着，这一条任务自己仍会再打一次模型。
- 运行超时会把任务行改成 failed，并中止这一轮的信号。处理函数如果继续往下走，仍会排 follow-up。通道已经让出来，旧的一次调用还在，新的整点又开始，同一小时的模型调用叠在一起。

失败补跑调度 `report.hourly.failure-catchup` 保持关闭。缺掉的历史小时不在这次补。

## 决定

- 心跳还在、运行已超过 `AI_CENTER_HOURLY_MAX_RUNNING_MS`（默认 45 分钟）时，仍记 `WorkerRunTimeout`，清掉 running 和租约。不补尝试，不重新入队。日志是 `[worker] hourly-extract released`。
- 处理函数看到中止信号后停住：不再打信息树、不再排 follow-up、不再因为可重试失败把同一条任务送回队列。已经发出的那一次调用会自己结束。
- `report.hourly.extract` 的租约中断最多把 `max_attempts` 补到 3。再遇到租约中断记 `WorkerLeaseExpired`，状态是 failed。翻译任务的退款次数不变。更早的已结束小时若因租约中断回到队列，优先级降到 -5，不再占前台。
- `AI_CENTER_HOURLY_NO_CATCHUP` 未设置或不是 `0` 时，整点任务只把刚结束的那一小时交给 `generateHourlyDigests`。设为 `0` 后，同一次任务仍会再带一个旧小时。
- 同一条件下，可重试的浓缩失败带 `hourly-no-retry`，任务记 failed，不回到队列。日志是 `[worker] hourly-extract stop-retry`。`AI_CENTER_HOURLY_NO_CATCHUP=0` 时仍按原来的 `maxAttempts` 重试这一条。
- 已知小时的类目刊期改在信息树之前写。树抛错或超时，这一小时的类目已经落过一次，不会为了补类目再入队。
- 没有小时起点的任务，只和另一条同样没有小时起点的运行中任务重叠。一个具体小时不再把整点任务跳成 `already-running`。
- Worker 启动时，以及 `report.hourly.default` 再次到点时：排队超过一小时的整点任务取消，原因 `superseded-by-newer-hour`；小时起点早于刚结束的那一小时、优先级大于等于 0 的任务降到 -5。优先级 -1 不动。`report.hourly.failure-catchup` 不重新打开。`report.hourly.default` 仍是 `enabled=true`。

不新增 migration。当前 schema 仍是 97。下一号是 98。空号仍是 63、79、80、82。不要重建数据库。

## 验证

`node --test test/hourly-extract-backlog.test.js test/report-reliability.test.js test/report-job-failure.test.js test/hourly-category.test.js test/hourly-failure-catchup.test.js test/reading-hour.test.js test/hourly-condense-log.test.js test/translation-reliability.test.js`

超时后的小时任务是 failed，下一条可以领取。租约中断第二次不再把上限加到 4，第三次停在 failed。旧的前台小时降到 -5，超过一小时的整点排队被取消，近一小时内的整点还在。未设置 `AI_CENTER_HOURLY_NO_CATCHUP` 时整点只传入刚结束的小时，可重试失败不再入队；设为 `0` 时不注入小时起点，失败仍会入队。类目调用发生在信息树之前，树抛错不会再调一次。中止信号不会再打模型，也不会排 follow-up。`report.hourly.failure-catchup` 仍是关闭，`report.hourly.default` 仍启用。

## 部署

只需要重启 Worker。页面没有改，Web 不用为这项重启。不要打开 `AI_CENTER_HOURLY_NO_CATCHUP=0`。已经缺的小时不由这次启动补跑。

本分支已 rebase 到包含 #254 的 main。类目要点仍优先用已有中文，截断原题不作为最终 bullet。那部分代码没有在这次冲突里改写。
