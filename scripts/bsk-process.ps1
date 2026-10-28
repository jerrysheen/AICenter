$script:AiCenterRoot = Split-Path -Parent $PSScriptRoot
$script:BundledBsk = Join-Path $script:AiCenterRoot 'externaltools\bsk.exe'

function Get-AiCenterBskPath {
  if ($env:AI_BSK_PATH -and (Test-Path -LiteralPath $env:AI_BSK_PATH -PathType Leaf)) {
    return $env:AI_BSK_PATH
  }
  if (Test-Path -LiteralPath $script:BundledBsk -PathType Leaf) {
    return $script:BundledBsk
  }
  return $null
}

function Test-AiCenterBrowserCommand([string]$CommandLine) {
  if (-not $CommandLine) { return $false }
  $normalized = $CommandLine.Replace('/', '\').ToLowerInvariant()
  $bskPath = (Get-AiCenterBskPath)
  $bundled = $script:BundledBsk.Replace('/', '\').ToLowerInvariant()
  $matchesBinary = $normalized.Contains('\externaltools\bsk.exe') -or
    ($bskPath -and $normalized.Contains($bskPath.Replace('/', '\').ToLowerInvariant())) -or
    $normalized.Contains($bundled)
  return $matchesBinary -and $normalized.Contains('daemon') -and $normalized.Contains('start')
}

function Get-AiCenterBrowserProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name = 'bsk.exe'" -ErrorAction SilentlyContinue |
      Where-Object { Test-AiCenterBrowserCommand ([string]$_.CommandLine) })
}

function Stop-AiCenterBrowserProcesses {
  $instances = @(Get-AiCenterBrowserProcesses)
  foreach ($instance in $instances) {
    Write-Host "Stopping Browser daemon PID $($instance.ProcessId)..." -ForegroundColor Yellow
    Stop-Process -Id ([int]$instance.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  if ($instances.Count -gt 0) {
    Start-Sleep -Milliseconds 700
  }
}

function Get-AiCenterBrowserStatus {
  $bsk = Get-AiCenterBskPath
  if (-not $bsk) { return $null }
  $previous = $env:BSK_AUTO_START
  $env:BSK_AUTO_START = '0'
  try {
    $output = & $bsk --json status 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $output) { return $null }
    return ($output | Out-String | ConvertFrom-Json)
  } catch {
    return $null
  } finally {
    if ($null -eq $previous) {
      Remove-Item Env:BSK_AUTO_START -ErrorAction SilentlyContinue
    } else {
      $env:BSK_AUTO_START = $previous
    }
  }
}

function Start-AiCenterBrowserDaemon {
  param(
    [string]$OutLog,
    [string]$ErrorLog
  )
  $bsk = Get-AiCenterBskPath
  if (-not $bsk) {
    throw '找不到 externaltools\bsk.exe'
  }
  return Start-Process -FilePath $bsk `
    -ArgumentList @('daemon','start','--foreground','--daemon-idle','7d','--session-idle','30m') `
    -WorkingDirectory $script:AiCenterRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrorLog `
    -PassThru
}

function Wait-AiCenterBrowserDaemon([int]$TimeoutSeconds = 20) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $status = Get-AiCenterBrowserStatus
    if ($status -and $status.pid) { return $status }
    Start-Sleep -Milliseconds 400
  } while ([DateTime]::UtcNow -lt $deadline)
  return $null
}

function Test-AiCenterBskDaemonWatchEnabled {
  param([string]$Value = '')
  $trimmed = if ($null -eq $Value) { '' } else { $Value.Trim().ToLowerInvariant() }
  if (-not $trimmed) { return $true }
  return @('0', 'false', 'off', 'no') -notcontains $trimmed
}

function Get-AiCenterBrowserDaemonCheckSeconds {
  param([string]$Raw = '')
  $trimmed = if ($null -eq $Raw) { '' } else { $Raw.Trim() }
  if (-not $trimmed) { return 15 }
  $parsed = 0
  if (-not [int]::TryParse($trimmed, [ref]$parsed) -or $parsed -lt 5) { return 15 }
  return $parsed
}

function Test-AiCenterBrowserDaemonHasField($Status, [string]$Name) {
  if ($Status -is [System.Collections.IDictionary]) { return $Status.Contains($Name) }
  return @($Status.PSObject.Properties.Name) -contains $Name
}

function Test-AiCenterBrowserDaemonUp($Status) {
  if (-not $Status) { return $false }
  $pidValue = 0
  if ($Status.pid -and [int]::TryParse([string]$Status.pid, [ref]$pidValue) -and $pidValue -gt 0) { return $true }
  if ($Status.daemonConnected -eq $true) { return $true }
  if ((Test-AiCenterBrowserDaemonHasField $Status 'browsers') -or (Test-AiCenterBrowserDaemonHasField $Status 'sessions') -or $Status.daemon_version) {
    return $true
  }
  return $false
}

function Get-AiCenterBrowserDaemonAction {
  param(
    $Status,
    [bool]$DaemonProcessRunning = $false,
    [bool]$StartInFlight = $false,
    [datetime]$LastStartUtc = [datetime]::MinValue,
    [datetime]$NowUtc = [datetime]::UtcNow,
    [int]$RestartGapSeconds = 20,
    [bool]$WatchEnabled = $true
  )
  if (-not $WatchEnabled) {
    return [pscustomobject]@{ Action = 'none'; Reason = 'disabled' }
  }
  if (Test-AiCenterBrowserDaemonUp $Status) {
    return [pscustomobject]@{ Action = 'none'; Reason = 'up' }
  }
  if ($DaemonProcessRunning -or $StartInFlight) {
    return [pscustomobject]@{ Action = 'wait'; Reason = 'starting' }
  }
  if ($LastStartUtc -gt [datetime]::MinValue -and $NowUtc -lt $LastStartUtc.AddSeconds($RestartGapSeconds)) {
    return [pscustomobject]@{ Action = 'wait'; Reason = 'backoff' }
  }
  return [pscustomobject]@{ Action = 'start'; Reason = 'down' }
}

function Read-AiCenterBskDaemonEnvFile {
  param([string]$Path)
  $found = @{}
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $found }
  $wanted = @{
    AI_CENTER_BSK_DAEMON_WATCH = $true
    AI_CENTER_BSK_DAEMON_CHECK_SECONDS = $true
  }
  foreach ($line in @(Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
    if ($line -match '^\s*#') { continue }
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }
    $name = $Matches[1]
    if (-not $wanted.ContainsKey($name)) { continue }
    $raw = $Matches[2].Trim()
    if ($raw.Length -ge 2) {
      $quote = $raw[0]
      if (($quote -eq '"' -or $quote -eq "'") -and $raw[$raw.Length - 1] -eq $quote) {
        $raw = $raw.Substring(1, $raw.Length - 2)
      }
    }
    $found[$name] = $raw
  }
  return $found
}

function Get-AiCenterBskDaemonWatchSettings {
  param(
    [hashtable]$ProcessEnvironment = @{},
    [hashtable]$InstanceEnvironment = @{},
    [hashtable]$RepositoryEnvironment = @{}
  )
  $merged = @{}
  foreach ($name in @('AI_CENTER_BSK_DAEMON_WATCH', 'AI_CENTER_BSK_DAEMON_CHECK_SECONDS')) {
    foreach ($source in @($RepositoryEnvironment, $InstanceEnvironment, $ProcessEnvironment)) {
      if ($source -and $source.ContainsKey($name) -and "$($source[$name])".Trim()) {
        $merged[$name] = "$($source[$name])".Trim()
      }
    }
  }
  return [pscustomobject]@{
    Enabled = Test-AiCenterBskDaemonWatchEnabled ([string]$merged['AI_CENTER_BSK_DAEMON_WATCH'])
    CheckSeconds = Get-AiCenterBrowserDaemonCheckSeconds ([string]$merged['AI_CENTER_BSK_DAEMON_CHECK_SECONDS'])
  }
}

function Enter-AiCenterBskDaemonStartLock {
  param([string]$Path)
  if (-not $Path) { return $true }
  $directory = Split-Path -Parent $Path
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  if (Test-Path -LiteralPath $Path) {
    $ageSeconds = 0
    try {
      $ageSeconds = ([DateTime]::UtcNow - (Get-Item -LiteralPath $Path).LastWriteTimeUtc).TotalSeconds
    } catch {
      $ageSeconds = 0
    }
    if ($ageSeconds -lt 60) { return $false }
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  }
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$PID)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    $script:bskDaemonLockStream = $stream
    return $true
  } catch {
    return $false
  }
}

function Exit-AiCenterBskDaemonStartLock {
  param([string]$Path)
  if ($script:bskDaemonLockStream) {
    try { $script:bskDaemonLockStream.Dispose() } catch { }
    $script:bskDaemonLockStream = $null
  }
  if ($Path) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  }
}
