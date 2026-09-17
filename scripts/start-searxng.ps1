param(
  [ValidateRange(1, 65535)]
  [int]$ListenPort = 8888,
  [switch]$WaitForHealth
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'searxng-process.ps1')

if (-not (Test-SearxngInstalled)) {
  throw "Web Search 尚未安装。请先运行：powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\setup-searxng.ps1`""
}

$logDirectory = Join-Path $script:AiCenterRoot '.ai-data\logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

if (Wait-SearxngHealth -ListenPort $ListenPort -TimeoutSeconds 1) {
  Write-Host "Search Worker 已在运行  http://127.0.0.1:$ListenPort/" -ForegroundColor Green
  return
}

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $ListenPort -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
  throw "端口 $ListenPort 已被其他程序占用；未停止任何进程。"
}

$process = Start-AiCenterSearchProcess `
  -OutLog (Join-Path $logDirectory 'search.out.log') `
  -ErrorLog (Join-Path $logDirectory 'search.error.log')

if ($WaitForHealth) {
  $process.Refresh()
  if ($process.HasExited) {
    throw "Search Worker 启动后退出，请查看 $(Join-Path $logDirectory 'search.error.log')"
  }
  if (-not (Wait-SearxngHealth -ListenPort $ListenPort)) {
    throw "Search Worker 在时限内没有通过健康检查，请查看 $(Join-Path $logDirectory 'search.error.log')"
  }
}

Write-Host "Search Worker 已启动 PID $($process.Id)  http://127.0.0.1:$ListenPort/" -ForegroundColor Green
