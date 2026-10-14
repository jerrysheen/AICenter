# 日常 Chrome 不算第二只浏览器

日期：2026-10-14

## 线上

采集浏览器是用户平时的 Chrome。用户目录是 `C:\Users\<user>\AppData\Local\Google\Chrome\User Data`，也就是 `%LOCALAPPDATA%\Google\Chrome\User Data`。进程启动时没有 `--user-data-dir`。目录里有 `Default`、`Profile 1`、`Profile 2`。

启动器原先只在命令行里查找 `--user-data-dir`。这只日常 Chrome 对不上，扩展又还没连上时，就会再往同一目录拉起一只。

## 决定

- `AI_CENTER_SCRAPE_CHROME_PROFILE_DIRECTORY` 有值时，拉起参数是 `--user-data-dir` 加上 `--profile-directory=<值>`，其余仍是 `--no-first-run`、`--no-default-browser-check`、`about:blank`。不打开调试端口。
- 配置的用户目录和 `%LOCALAPPDATA%\Google\Chrome\User Data` 相同（忽略大小写和末尾斜杠）时，没有 `--user-data-dir` 的 `chrome.exe` 算这个目录已经在用。
- 命令行带 `--type=` 的是子进程，不参与判断。子进程即使写了用户目录也不算浏览器已打开；主进程在，就不另开。
- 没有 `--user-data-dir` 的日常 Chrome 不算仓库 `.ai-data\chrome-profile` 已在运行。未设置用户目录时，拉起目录仍是仓库里的那份。

## 验证

`pwsh -NoLogo -File scripts/scrape-browser.tests.ps1`。

## 重启

重新运行 `scripts/start-ai-center.ps1`。不新增 migration。不要重建数据库。
