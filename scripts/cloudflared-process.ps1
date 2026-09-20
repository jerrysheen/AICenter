$script:AiCenterRoot = Split-Path -Parent $PSScriptRoot
$script:CloudflareRuntime = Join-Path $script:AiCenterRoot '.ai-data\cloudflare'
$script:CloudflareTokenPath = Join-Path $script:CloudflareRuntime 'tunnel.token'
$script:CloudflareConfigPath = Join-Path $script:CloudflareRuntime 'config.yml'
$script:CloudflaredKnownPaths = @(
  "$env:ProgramFiles\cloudflared\cloudflared.exe",
  "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
  "$env:LOCALAPPDATA\cloudflared\cloudflared.exe"
)

function Get-CloudflaredCommand {
  $command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if ($command -and $command.Source -notmatch '\\WindowsApps\\') {
    return $command.Source
  }
  foreach ($candidate in $script:CloudflaredKnownPaths) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return $null
}

function Test-CloudflaredInstalled {
  return [bool](Get-CloudflaredCommand)
}

function Initialize-CloudflareRuntime {
  New-Item -ItemType Directory -Path $script:CloudflareRuntime -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $script:AiCenterRoot '.ai-data\logs') -Force | Out-Null
  return $script:CloudflareRuntime
}

function Read-CloudflaredToken {
  if ($env:CLOUDFLARE_TUNNEL_TOKEN) {
    $fromEnv = [string]$env:CLOUDFLARE_TUNNEL_TOKEN
    if ($fromEnv.Trim()) { return $fromEnv.Trim() }
  }
  if (-not (Test-Path -LiteralPath $script:CloudflareTokenPath -PathType Leaf)) { return $null }
  $raw = (Get-Content -LiteralPath $script:CloudflareTokenPath -Raw -ErrorAction SilentlyContinue)
  if (-not $raw) { return $null }
  $token = $raw.Trim()
  if (-not $token) { return $null }
  return $token
}

function Save-CloudflaredToken([string]$Token) {
  $value = [string]$Token
  if (-not $value.Trim()) { throw 'Tunnel token 为空。' }
  Initialize-CloudflareRuntime | Out-Null
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [IO.File]::WriteAllText($script:CloudflareTokenPath, $value.Trim() + [Environment]::NewLine, $utf8)
  $acl = Get-Acl -LiteralPath $script:CloudflareTokenPath
  $acl.SetAccessRuleProtection($true, $false)
  $current = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $access = New-Object Security.AccessControl.FileSystemAccessRule(
    $current,
    'FullControl',
    'Allow'
  )
  $acl.AddAccessRule($access)
  Set-Acl -LiteralPath $script:CloudflareTokenPath -AclObject $acl
}

function Get-CloudflaredService {
  Get-Service -Name 'Cloudflared','cloudflared' -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-CloudflaredProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue
}

function Test-CloudflaredRunning {
  if ((Get-CloudflaredService).Status -eq 'Running') { return $true }
  return @((Get-CloudflaredProcesses)).Count -gt 0
}

function Test-CloudflaredConfigured {
  if (-not (Test-CloudflaredInstalled)) { return $false }
  if (Read-CloudflaredToken) { return $true }
  return Test-Path -LiteralPath $script:CloudflareConfigPath -PathType Leaf
}

function Start-AiCenterCloudflaredProcess {
  param(
    [string]$OutLog,
    [string]$ErrorLog
  )
  if (-not (Test-CloudflaredConfigured)) {
    throw 'cloudflared is not configured on this host.'
  }
  if (Test-CloudflaredRunning) {
    return $null
  }
  Initialize-CloudflareRuntime | Out-Null
  $token = Read-CloudflaredToken
  $argumentList = if ($token) {
    @('tunnel', '--no-autoupdate', 'run', '--token-file', $script:CloudflareTokenPath)
  } else {
    @('tunnel', '--config', $script:CloudflareConfigPath, '--no-autoupdate', 'run')
  }
  $process = Start-Process -FilePath (Get-CloudflaredCommand) `
    -ArgumentList $argumentList `
    -WorkingDirectory $script:CloudflareRuntime `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrorLog `
    -PassThru
  Start-Sleep -Milliseconds 800
  $process.Refresh()
  if ($process.HasExited) {
    throw "cloudflared exited after start. See $ErrorLog"
  }
  return $process
}
