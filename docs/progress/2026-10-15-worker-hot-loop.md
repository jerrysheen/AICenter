# Worker 主线程空转、租约重入队和迁移竞态

2026-10-15 部署 `99dc71b` 之后，Worker 单核约 100% CPU，没有 TCP 连接。4 条 Gemma 翻译在 `model_usage_index` 里是 `pending`，请求没有发出去。翻译和快照任务停在 `running`。领取计时器仍大约每秒响一次，所以主线程不是纯同步死循环。

## 1. 配额等待变成 1ms 轮询

`createGemmaTranslationRouter` 的 `admit()` 在 `repository.reserve` 返回的 `retryAt` 已经过去时，等待 `Math.max(1, retryAt - now)`。时钟每往前 1ms 就再做一次 SQLite 预约，直到第一次尝试的 61 秒截止。补译遇到 `budget-deferred` 还会在同一次尝试里再等最多 4 次。几条翻译任务一起跑就把一个核占满，已经发出的请求得不到事件循环，所以没有 TCP，用量一直是 `pending`。

现在计算出的等待不足 250ms 时立刻抛 `budget-deferred`，`retryAt` 取当前时间加 250ms。连续 8 次调用了等待、时钟却没有真正走过 250ms，也抛同样的错误。更远的配额窗口仍在截止时间之内按原间隔等待。

同一批改动里，转写准入本来就至少等 200ms。调用次数上限和换密钥循环没有按 1ms 重试的轮询。

## 2. 租约过期让同一次尝试跑两遍

翻译任务租约过期时，恢复逻辑把 `attempt_count` 减 1，并删掉这次 `job_attempts`。下一次领取拿到同一个尝试号。旧执行的 `touchJob`、`completeJob`、`failJob` 对得上新的领取。`releaseSuperseded` 和恢复逻辑把任务从 `inFlight` 拿掉，但旧执行还在跑，于是同一条任务在本进程里跑两次，Gemma 被打两次。

现在本进程正在执行、并且还没到运行时限的任务不重新入队。尝试行改成 `abandoned`，不删除，`attempt_count` 保持不变。少掉的那一次额度加在 `max_attempts` 上，所以租约中断仍不占 4 次尝试，下一次领取用新的尝试号。从 `inFlight` 拿掉时中止旧执行，完成和失败对不上被中止的那次。超过运行时限仍记 `WorkerRunTimeout` 并让出名额，包括本进程还挂着的那次。

## 3. 启动补漏扫太久

`translation-gap-fill` 一轮可以扫到 5000 行。生产上 `scanned=4803` 用了大约 7 分钟，而且整段是同步的，启动期间主线程让不出来。

现在媒体和订阅各最多扫 400 行。每一页之前 `setImmediate` 让出一次。游标留给下一轮（默认 5 分钟）继续。

## 4. 同时启动时的迁移冲突

Web 和 Worker 一起打开数据库时，两边都看到某个 `schema_migrations.version` 还没有，然后都执行 `INSERT`。后一个撞上 `UNIQUE constraint failed: schema_migrations.version`，进程退出。

现在每条迁移使用 `BEGIN IMMEDIATE`，在事务里再查一次版本。已经有人写入就提交并跳过。插入用 `INSERT OR IGNORE`。不新增 migration。

## 5. 日志

文件日志仍按天写在实例 `<dataDirectory>/logs`，未设置 `AI_CENTER_LOG_DIR` 时 Worker 就是这个目录。stdout 和 stderr 同时镜像到原来的流，监护脚本能看到输出。管道已经积压时才停掉这一路镜像，避免停掉的读取器把进程堵住。

## 重启

需要同时重启 Web 和 Worker。不新增 migration，不要重建数据库。
