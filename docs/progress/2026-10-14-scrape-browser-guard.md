# 采集浏览器掉线后由启动器拉起

日期：2026-10-14

## 线上

10-13 22:00 到 10-14 09:29，采集浏览器没开着。X 与雪球每次抓取失败，错误是 `no browser is currently connected`（雪球 318 次，X 217 次）。没有新内容入库，启动器窗口也没有告警。用户手动打开浏览器后恢复。

## 连接方式

抓取不启动 Chrome，也不走 CDP。Worker 通过 BrowserSkill：`externaltools/bsk.exe daemon start --foreground --daemon-idle 7d --session-idle 30m`。`BSK_AUTO_START=0`。扩展连到 daemon；`bsk --json status` 的 `browsers` 为空就是 `no_browser_connected`。会话用 `bsk session start`，Instance 的 `AI_CENTER_BROWSER_ID` 只是已连接实例的 id，不是 Chrome 用户目录。没有调试端口，不恢复 9222。

产品曾经拥有的专用目录是仓库 `.ai-data\chrome-profile`（只打开 `about:blank`）。2026-09-17 拆除 CDP 后，JS 不再读这个目录，启动器只拉 daemon。

## 决定

- 启动时：daemon 起来之后，若扩展未连接且该用户目录的 `chrome.exe` 不在运行，用同一目录拉起 Chrome。参数是 `--user-data-dir`、`--no-first-run`、`--no-default-browser-check`、可选 `--profile-directory`、`about:blank`。
- 默认目录是 `<仓库>\.ai-data\chrome-profile`。登录态若在别的 Profile，设置 `AI_CENTER_SCRAPE_CHROME_USER_DATA`。可执行文件可用 `AI_CENTER_SCRAPE_CHROME`。
- 已连接，或命令行里已有这份用户目录，就不另开进程。目录前缀更长的路径不算同一目录。
- 守护循环默认每 60 秒查一次。连续 3 次仍没有浏览器，且进程不在，再拉起，并在启动器窗口打一行。进程还在但扩展没连上时不另开。
- `AI_CENTER_SCRAPE_BROWSER_MISS_LIMIT` 至少为 1，`AI_CENTER_SCRAPE_BROWSER_CHECK_SECONDS` 至少为 5。这两个值和路径从进程环境或 Instance / 仓库 `.env` 读取，不打印其他键。
- Ctrl+C 不关闭这只 Chrome。找不到 Chrome 时警告一次，不挡住 Web / Worker。
- 不改页面，不加「最后更新」。不新增 migration。

## 验证

`pwsh -NoLogo -File scripts/scrape-browser.tests.ps1`。决策、路径边界、`.env` 合并和 dry-run 回调在 Linux 上的 PowerShell 7.5 通过。本机没有 Windows Chrome，没有真的拉起浏览器。

## 重启

重新运行 `scripts/start-ai-center.ps1`。守护循环在这个窗口里；只重启 Worker 不会装上这段检查。重新运行启动器也会重启 Web 和 Worker。
