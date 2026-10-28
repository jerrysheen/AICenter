$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bsk-process.ps1')

function Assert-Equal($Actual, $Expected, [string]$Label) {
  if ($Actual -ne $Expected) {
    throw "$Label expected [$Expected] but got [$Actual]"
  }
}

Assert-Equal (Test-AiCenterBskDaemonWatchEnabled '') $true 'watch defaults on'
Assert-Equal (Test-AiCenterBskDaemonWatchEnabled '0') $false 'watch off'
Assert-Equal (Test-AiCenterBskDaemonWatchEnabled 'off') $false 'watch off word'
Assert-Equal (Test-AiCenterBskDaemonWatchEnabled '1') $true 'watch explicit on'
Assert-Equal (Get-AiCenterBrowserDaemonCheckSeconds '') 15 'default interval'
Assert-Equal (Get-AiCenterBrowserDaemonCheckSeconds '30') 30 'custom interval'
Assert-Equal (Get-AiCenterBrowserDaemonCheckSeconds '1') 15 'interval floor'

$up = Get-AiCenterBrowserDaemonAction -Status ([pscustomobject]@{ pid = 9; browsers = @() }) -WatchEnabled $true
Assert-Equal $up.Action 'none' 'up daemon'
Assert-Equal $up.Reason 'up' 'up reason'

$extension = Get-AiCenterBrowserDaemonAction -Status ([pscustomobject]@{ pid = 9; browsers = @() })
Assert-Equal $extension.Action 'none' 'missing extension is not a daemon restart'

$down = Get-AiCenterBrowserDaemonAction -Status $null -NowUtc ([datetime]::Parse('2026-10-28T06:44:00Z'))
Assert-Equal $down.Action 'start' 'dead daemon'
Assert-Equal $down.Reason 'down' 'dead reason'

$starting = Get-AiCenterBrowserDaemonAction -Status $null -DaemonProcessRunning $true
Assert-Equal $starting.Action 'wait' 'process already starting'
Assert-Equal $starting.Reason 'starting' 'starting reason'

$recent = [datetime]::Parse('2026-10-28T06:44:00Z')
$backoff = Get-AiCenterBrowserDaemonAction -Status $null -LastStartUtc $recent -NowUtc $recent.AddSeconds(5) -RestartGapSeconds 20
Assert-Equal $backoff.Action 'wait' 'restart gap'
Assert-Equal $backoff.Reason 'backoff' 'backoff reason'

$later = Get-AiCenterBrowserDaemonAction -Status $null -LastStartUtc $recent -NowUtc $recent.AddSeconds(21) -RestartGapSeconds 20
Assert-Equal $later.Action 'start' 'gap elapsed'

$disabled = Get-AiCenterBrowserDaemonAction -Status $null -WatchEnabled $false
Assert-Equal $disabled.Action 'none' 'kill switch'
Assert-Equal $disabled.Reason 'disabled' 'kill switch reason'

$repo = Join-Path ([IO.Path]::GetTempPath()) ('ai-center-bsk-env-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $repo | Out-Null
$envFile = Join-Path $repo '.env'
Set-Content -LiteralPath $envFile -Value @(
  '# BSK_AUTO_START=1',
  'AI_CENTER_BSK_DAEMON_WATCH="0"',
  'AI_CENTER_BSK_DAEMON_CHECK_SECONDS=45'
) -Encoding ascii
$fromFile = Read-AiCenterBskDaemonEnvFile $envFile
$settings = Get-AiCenterBskDaemonWatchSettings -RepositoryEnvironment $fromFile -ProcessEnvironment @{ AI_CENTER_BSK_DAEMON_CHECK_SECONDS = '20' }
Assert-Equal $settings.Enabled $false 'file disables watch'
Assert-Equal $settings.CheckSeconds 20 'process interval wins'
$override = Get-AiCenterBskDaemonWatchSettings -RepositoryEnvironment $fromFile -ProcessEnvironment @{ AI_CENTER_BSK_DAEMON_WATCH = '1' }
Assert-Equal $override.Enabled $true 'process can turn the watch back on'
Remove-Item -LiteralPath $repo -Recurse -Force

$lockDir = Join-Path ([IO.Path]::GetTempPath()) ('ai-center-bsk-lock-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $lockDir | Out-Null
$lock = Join-Path $lockDir 'bsk-daemon.lock'
if (-not (Enter-AiCenterBskDaemonStartLock -Path $lock)) { throw 'first lock should be acquired' }
if (Enter-AiCenterBskDaemonStartLock -Path $lock) { throw 'second lock should wait' }
Exit-AiCenterBskDaemonStartLock -Path $lock
if (-not (Enter-AiCenterBskDaemonStartLock -Path $lock)) { throw 'lock should be free after release' }
Exit-AiCenterBskDaemonStartLock -Path $lock
Set-Content -LiteralPath $lock -Value 'stale' -Encoding ascii
(Get-Item -LiteralPath $lock).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(-5)
if (-not (Enter-AiCenterBskDaemonStartLock -Path $lock)) { throw 'stale lock should be replaced' }
Exit-AiCenterBskDaemonStartLock -Path $lock
Remove-Item -LiteralPath $lockDir -Recurse -Force

Write-Output 'bsk-daemon tests passed'
