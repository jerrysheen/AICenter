# 订阅同步按来源各自推进

2026-10-16 生产上 `feed.subscriptions.sync` 最后一次完整成功是 09:20:15。之后几乎每一轮都跑到大约 10 分钟，被下一轮标成 `WorkerInterrupted: 新的订阅同步开始，上一轮仍未结束`。24 小时里失败 103 次。X 的帖子还在写入，雪球大 V 最后一条停在 08:54。日志里没有雪球 cookie 或 401/403。

根因是一轮任务按顺序抓所有到期订阅。默认顺序是 X 关注、X 推荐，然后才是雪球关注、精选和 7x24。X 主页在已有历史 id 时最多滚 20 轮，再对截断帖、长文、每条有回复的帖各开一次页面，没有整路截止时间，一轮经常超过 10 分钟。条目在 `refreshPersistedSource` 里先落库，所以中断前 X 已经写入。任务发现自己不再是当前轮次就返回，雪球还没开始。`releaseOpenSubscriptionLeases` 把没做完的订阅，包括这条慢的 X，重新设成到期，下一轮又从 X 开始。中断信号没有传进浏览器会话，会话锁最长还能再占 15 分钟。

`media.index.enrich` 不是雪球停更的直接原因。它和同步共用默认并发 1 的队列，也没有单任务预算，全局大约 45 分钟才记 `WorkerRunTimeout`，正文抓取在任务行失败后仍可能占着浏览器锁。

现在每分钟的 `feed.subscriptions.sync` 只列出到期订阅，并为每条入队 `feed.subscription.sync`。已经排队或正在跑的不再入队。子任务只领取自己这一条，`claimSubscription` 带回 `leaseUntil`。完成、失败和推迟都带 `WHERE next_sync_at = leaseUntil`。旧任务在浏览器锁上等到超时之后再写，不会盖掉新一轮的 `next_sync_at`。父任务信号已经中止时不再回写。默认时限 90 秒，用 `AI_CENTER_FEED_SYNC_SOURCE_TIMEOUT_MS` 调整，范围 15 秒到 3 分钟。到时如果已经有条目，按这条订阅的间隔完成，进度留下；一条都没有则 5 分钟后重试，不推到整个刷新间隔。新的一分钟不取消仍在跑的分发或单源任务，也不释放租约。日志是 `[worker] feed-sync source=… feed=… subscription=… status=… durationMs=… added=…`。X 和雪球在截止后停止继续滚动、长文和评论，返回已经拿到的条目。雪球的打开页面、检查登录、翻页和评论都把本次命令收成 `min(30 秒, 剩余时间)`，剩余不足 1 秒就不再发。BrowserSkill 的 `evaluate` / `fetchJson` 只认 `timeoutMs`，不接受 AbortSignal，进行中的那一次命令会跑到这次传入的时限为止。

`media.index.enrich` 的软预算默认 4 分钟（`AI_CENTER_MEDIA_ENRICH_BUDGET_MS`，30 秒到 6 分钟）。到点把剩余 `externalIds` 再入队，跳过这一轮后面的翻译。连续交出最多 10 次（`hop`），第 11 次不再入队。硬上限默认 8 分钟（`AI_CENTER_MEDIA_ENRICH_MAX_RUNNING_MS`，1 分钟到 30 分钟）。

Worker 启动仍放弃正在跑的两类同步任务并释放租约，因为进程已经不在。排队中的 `feed.subscription.sync` 保留。

不新增 migration。不要重建数据库。需要同时重启 Web 和 Worker。
