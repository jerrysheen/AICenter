# 单源时限，以及 bsk 启动前先 prepare

2026-10-16 #124 把等锁、会话启动和 X 收获收进单源 90 秒。部署后每一次 X / 雪球同步都失败，错误是 `request is not prepared or the daemon restarted; prepare a new request before starting`。#126 把 #124 整段回退。这次把时限改动重新接上，并补上 bsk 0.3.2 要求的 prepare。

## 核对

仓库里的 `externaltools/bsk.exe` 是 bsk 0.3.2（见 `externaltools/README.md`）。帮助字符串和错误字符串是从这只二进制里读出来的，没有在本机执行它。

`bsk session request` 的帮助摘要是 `Inspect, claim, or cancel a recoverable start request`。参数表里有长选项 `--prepare`、`--claim`、`--cancel`，三者互斥；都不带时，动作是 `status`。`session start --request-id` 的帮助是 `Recoverable request token: <expiry-unix-ms>:<UUID>. Valid for at most ten minutes`。

daemon 字符串写明：`request is not prepared or the daemon restarted; prepare a new request before starting`，以及 `action must be status, prepare, cancel, or claim`。不带 `--request-id` 的普通 `session start` 不走这条路径。

这些字符串和 `cli-v0.3.2` 的 `session request` 实现一致。请求表只活在 daemon 进程内存里。

## prepare、claim、cancel

令牌格式是 `<expiry-unix-ms>:<UUID>`。过期时间必须落在接下来的 10 分钟里，否则 `request expired or admission deadline exceeds ten minutes; use a new request_id`。我们用 `Date.now() + 9 分钟`，给时钟偏差留出余量。

- `bsk --json session request <id> --prepare`：在 daemon 里记下这条请求，状态是 `prepared`。不开窗口。
- `bsk --json session start --request-id <id> ...`：只接受已经 prepare 过的 id。状态从 `prepared` 到 `starting`，成功后是 `ready`。同一个 id、同一组参数再启动，返回已有结果，不另开窗口。参数不同则拒绝。
- `bsk --json session request <id> --claim`：调用方确认要留下这个窗口。状态从 `ready` 变成 `active`。不 claim 的话，daemon 在令牌到期时取消这条请求，并关掉它自己创建的那个窗口。会话锁默认可以占 15 分钟，所以启动成功后立刻 claim。已经 claim 的会话改走原来的 session idle，不因为这 10 分钟到期被关。
- `bsk --json session request <id> --cancel`：只取消这一次启动请求。还没开始就留下关闭的墓碑，之后的 start 不能再把同一个 id 打开。已经开始的，等创建结束，再只停止这条请求自己的会话；浏览器、创建时间和 Agent Window 对不上就不动，避免短 session id 被复用后误关。
- 不带上述旗标的 `bsk --json session request <id>` 只查询状态。

`prepare` 或 `start` 只要出错就取消这一次 request，不只是超时。返回里没有 `state`，或 `state` 不是 `prepared` / `active`，也算失败。claim 失败时，先 cancel，再对这次拿到的 `sessionId` 执行 `session stop`，限时 5 秒，报错忽略。还没有 session id 的失败只 cancel。不发 `session list`，也不按 `--name` 停会话。Web 和 Worker 共用一个 daemon，按 `x.home` 停会关掉另一路还在用的窗口。

## daemon 重启

请求表不落盘。重启之后：

- 旧的 prepare 作废。对原 id 再 `session start --request-id` 会得到上面那句错误，并且不开窗口。
- 令牌还没过期时，可以重新 `--prepare`，这是一条新的空记录，不会把旧窗口找回来。
- 对未知但未过期的 id 发 `--cancel`，会写一条关闭墓碑，迟到的 start 不能打开窗口。不会按名字关会话。
- 对未知 id 发 `--claim`，返回 `start request not found`。
- 查询未知 id：没过期是 `unknown`，过期是 `closed`。

每次 `startSession` 都新造一个 id，先 prepare，再 start，成功后 claim。不把 id 留到下一次进程。daemon 若在 prepare 和 start 之间重启，这一次失败，下一轮用新 id 再 prepare。

## 时限

和 #124 相同，这里不重复展开。单源仍是 90 秒，硬帽仍是 120 秒。等锁、启动和 X 收获都算在这 90 秒里，最后 15 秒留给写条目。`onContentReady` 在订阅同步里不等待。

不新增 migration。不要重建数据库。需要同时重启 Web 和 Worker。
