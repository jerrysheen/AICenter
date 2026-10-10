# 2026-10-10 本机信任收紧

本机 desktop 不再只看 loopback 和两个 Cloudflare 头。请求必须同时来自 loopback、不带代理头、Host 是本机名加端口，并且写操作不是跨站来源。拿不准就按公网设备或未配对处理。可选 `AI_CENTER_TUNNEL_PORT` 上的连接一律按公网处理。

带 `Origin` 或 `Sec-Fetch-Site` 的写请求若不是 `application/json` 则返回 415。没有这两个头的本机脚本和旧版 CLI 回调仍可写入。网页 `api()` 本来就带这个头。鸿蒙薄壳原生请求只有健康检查 GET。部署时最好没有任务在跑。

本机任务详情对尚无派发 Job 的待领取任务显示「派发」，任务列表显示「派发全部 (N)」。两者都调用 `notify`。

`runtime/restart`、工作包 `notify` / `retry`、X 点赞、媒体源启停，以及 `media/probe` 的 `run: true`，改为只允许本机。`continue` 仍允许设备追加记录，派发只在本机执行。`media/bodies` 的 `repair: true` 原本就会拒绝非本机。前端在非本机时隐藏重启、重新派发和 X 点赞，任务提交不再调用 `notify`。

`@deepseek-ai/dsh-web-fetch-http` 0.1.6-alpha.2 已在连接前拒绝回环、私网和链路本地地址，并拦住指向这些地址的重定向。这次没有再包一层抓取器。Harness 进程不要配置 HTTP 代理，否则非字面量主机名会绕过它自己的 DNS 校验。

`DELETE /devices/:id` 仍只在本机调用。撤销后下一次 HTTP 为 401，已连接的 SSE 会马上结束。已配对设备还不能在外面撤销另一台设备。名称恰好是 `perf-audit (box curl)` 的测试设备会在迁移 50 中被撤销。
