param(
  [switch]$InstallService
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cloudflared-process.ps1')

if (-not (Test-CloudflaredInstalled)) {
  throw "cloudflared 尚未安装。请先运行：powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\setup-cloudflared.ps1`""
}

$token = Read-CloudflaredToken
if ($token -and -not (Test-Path -LiteralPath $script:CloudflareTokenPath -PathType Leaf)) {
  Save-CloudflaredToken $token
}
if (-not (Test-CloudflaredConfigured)) {
  throw "缺少 Tunnel token 或本机 config.yml。把 token 写入 $($script:CloudflareTokenPath)，或在 .ai-data/cloudflare/config.yml 配置 Named Tunnel。"
}

if ($InstallService) {
  if (-not $token) {
    throw '安装 Windows 服务目前只支持 dashboard token。本地 config.yml 请用 start-cloudflared.ps1 或 start-ai-center.bat 运行。'
  }
  & (Join-Path $PSScriptRoot 'setup-cloudflared.ps1') -InstallService
  return
}

$service = Get-CloudflaredService
if ($service -and $service.Status -eq 'Running') {
  Write-Host "cloudflared Windows 服务已在运行（$($service.Name)）。" -ForegroundColor Green
  return
}

if (Test-CloudflaredRunning) {
  Write-Host 'cloudflared 进程已在运行。' -ForegroundColor Green
  return
}

Initialize-CloudflareRuntime | Out-Null
$logDirectory = Join-Path $script:AiCenterRoot '.ai-data\logs'
$process = Start-AiCenterCloudflaredProcess `
  -OutLog (Join-Path $logDirectory 'cloudflared.out.log') `
  -ErrorLog (Join-Path $logDirectory 'cloudflared.error.log')

if ($process) {
  Write-Host "cloudflared 已启动 PID $($process.Id)。只应转发 http://127.0.0.1:8787。" -ForegroundColor Green
} else {
  Write-Host 'cloudflared 已在运行。' -ForegroundColor Green
}
Write-Host "日志：$(Join-Path $logDirectory 'cloudflared.out.log')"
