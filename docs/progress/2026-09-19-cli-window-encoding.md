# 2026-09-19 CLI 窗口中文乱码

可见任务窗口标题出现「浠诲姟」，是 UTF-8「任务」被 Windows PowerShell 5.1 按系统 ANSI（GBK）读脚本。`run-cursor-cli-window.ps1` 改为码点设标题，并用 UTF-8 读提示词文件，避免提示词同样被读歪。
