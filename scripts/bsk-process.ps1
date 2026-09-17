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
