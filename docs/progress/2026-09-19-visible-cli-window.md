# 任务 CLI 弹出可见 PowerShell

## 决定

Windows 上 Worker 用 `cmd /c start /wait powershell -File scripts/run-cursor-cli-window.ps1` 弹出独立窗口。提示词走临时文件。不要给 `start` 传无扩展名的标题词，否则它会当成命令。`AI_CENTER_CURSOR_CLI_HIDDEN=1` 可关掉窗口。
