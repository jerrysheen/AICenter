param(
  [string]$Token = '',
  [switch]$InstallService,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cloudflared-process.ps1')

function Write-Step([string]$Message, [string]$Color = 'Cyan') {
  Write-Host $Message -ForegroundColor $Color
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-CloudflaredBinary {
  if ((Test-CloudflaredInstalled) -and -not $Force) {
    Write-Step "已找到 cloudflared：$(Get-CloudflaredCommand)" 'Green'
    return
  }

  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw '未找到 cloudflared，且本机没有 winget。请先安装 Cloudflare 官方 Windows 包，再重新运行本脚本。'
  }

  Write-Step '正在用 winget 安装 Cloudflare.cloudflared。'
  & $winget.Source install --id Cloudflare.cloudflared -e --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0 -and -not (Test-CloudflaredInstalled)) {
    throw "winget 安装 cloudflared 失败（exit $LASTEXITCODE）。"
  }

  if (-not (Test-CloudflaredInstalled)) {
    throw 'cloudflared 已安装，但当前终端还看不到可执行文件。请新开一个 PowerShell 后再运行本脚本。'
  }
  Write-Step "cloudflared 已就绪：$(Get-CloudflaredCommand)" 'Green'
}

$runtime = Initialize-CloudflareRuntime
Install-CloudflaredBinary

if ($Token) {
  Save-CloudflaredToken $Token
  Write-Step "已把 Tunnel token 写入本机 $script:CloudflareTokenPath（未进入 Git）。" 'Green'
} elseif (Read-CloudflaredToken) {
  Write-Step "本机已有 Tunnel token：$script:CloudflareTokenPath" 'Green'
} else {
  Write-Step "还没有 Tunnel token。在 Cloudflare Zero Trust 建好 Named Tunnel 后，把 token 写入：`n  $script:CloudflareTokenPath" 'Yellow'
}

if ($InstallService) {
  $saved = Read-CloudflaredToken
  if (-not $saved) {
    throw '没有可用的 Tunnel token，无法安装 Windows 服务。先用 -Token 传入，或写入 .ai-data/cloudflare/tunnel.token。'
  }
  if (-not (Test-Administrator)) {
    throw '安装 cloudflared Windows 服务需要管理员 PowerShell。'
  }
  $cloudflared = Get-CloudflaredCommand
  Write-Step '正在安装 cloudflared Windows 服务。'
  & $cloudflared service install $saved
  if ($LASTEXITCODE -ne 0) {
    throw "cloudflared service install 失败（exit $LASTEXITCODE）。"
  }
  Write-Step 'cloudflared 服务已安装。' 'Green'
}

Write-Host ''
Write-Step '本机基建已就绪。接下来只能由你在 Cloudflare 控制台完成：' 'Cyan'
Write-Host @'
  1. 把一个域名加到 Cloudflare DNS。
  2. Zero Trust → Networks → Tunnels 创建 Named Tunnel。
  3. Public Hostname 只写一个精确主机名，Service 填 http://127.0.0.1:8787。
  4. 把 token 写入 .ai-data/cloudflare/tunnel.token（不要发到聊天或 Git）。
  5. 未提交的 .env 填写 AI_CENTER_PUBLIC_URL=https://那个主机名
  6. 开发阶段运行 scripts\start-cloudflared.ps1；长期使用再加 -InstallService。

不要用 Quick Tunnel，也不要把 Tunnel 指到 Worker、Search 或其他本机端口。
'@
Write-Host "运行时目录：$runtime"
