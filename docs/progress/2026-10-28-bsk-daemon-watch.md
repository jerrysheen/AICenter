# BrowserSkill daemon 掉线后拉起来

日期：2026-10-28

## 线上

上海时间大约 14:44 起，X 关注、X 推荐和雪球订阅同步失败。日志是 `ensure daemon is running: automatic daemon startup is disabled (BSK_AUTO_START=0)`。这几路 `added=0`，一小时大约 50 次。信息树小时刊期从大约 34 个根掉到大约 5 个，有的刊期 `root=0`、`inputIds=0`。Web 和 Worker 还在，媒体 RSS 仍在入库。只有走浏览器的来源停了。

## 原因

`BSK_AUTO_START=0` 是原定开关：Worker / Web 每次调用 `bsk` 都不许 CLI 自己把 daemon 拉起来。启动器负责 `bsk daemon start --foreground --daemon-idle 7d --session-idle 30m`。

启动器只在自己这次拉起的进程句柄上看到退出，打一行警告后把句柄丢掉，不再启动。已经在跑、被复用的 daemon（包括单独手动启动的）根本没有句柄，退出后也无人查看。Chrome 守护只补扩展宿主，daemon 不在时 `bsk status` 失败，Chrome 进程还在就什么也不做。同步任务于是每 5 分钟再失败一次，handler 正常返回，任务看起来完成了，时间线仍是空的。

这不是要把 `BSK_AUTO_START` 改成 1。那会让每条 CLI 用 BrowserSkill 自己的方式偷启，参数和进程都不归启动器管。

## 决定

- CLI 仍强制 `BSK_AUTO_START=0`，调用方传入的环境盖不掉。
- 显式拉起仍是同一条命令：`daemon start --foreground --daemon-idle 7d --session-idle 30m`。
- 启动器窗口大约每 15 秒看一次状态。自己拉起的进程退出，或复用的 daemon 已经不在，就再拉起。两次启动至少隔 20 秒。`.ai-data/bsk-daemon.lock` 避免和 Worker 同时各拉一只。
- Worker 在 Windows 上做同一件事。自动部署只重启 Worker、不重新加载启动器脚本时，这条仍然生效。开会话时如果错误是 daemon 不在，先拉起并再试一次；扩展还没连上就不是重启 daemon 的理由。
- `AI_CENTER_BSK_DAEMON_WATCH=0`（或 `false` / `off` / `no`）关掉两边的看守。默认开。`AI_CENTER_BSK_DAEMON_CHECK_SECONDS` 至少 5，默认 15。进程环境盖过 Instance `.env`，再盖过仓库 `.env`。
- 不改页面，不新增 migration。当前 schema 仍是 97。下一号是 98。空号仍是 63、79、80、82。不要重建数据库。

## 验证

`node --test test/bsk-daemon.test.js`

`pwsh -NoLogo -File scripts/bsk-daemon.tests.ps1`

本机没有 Windows 上的 BrowserSkill daemon，没有真的拉起 `bsk.exe`。

线上确认：`bsk --json status` 有 `pid`，`browsers` 不少于 1。随后 X / 雪球同步日志里 `added` 大于 0。把 daemon 停掉后，15 秒量级应再出现进程，而不是整小时 `added=0`。

## 重启

需要重启 Worker。自动部署重启 Worker 后，Worker 里的看守就会装上。启动器窗口里的同一段检查要重新运行 `scripts/start-ai-center.ps1` 才生效，这也会重启 Web 和 Worker。只重启 Web 不够。页面不用重载。
