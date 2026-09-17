param(
  [string]$InstanceId = '',
  [string]$InstanceRoot = '',
  [Nullable[int]]$Port = $null
)

$ErrorActionPreference = 'Stop'
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$WebEntry = Join-Path $RepositoryRoot 'apps\web\src\server.js'
$WorkerEntry = Join-Path $RepositoryRoot 'apps\worker\src\worker.js'
$NodeCommand = Get-Command node.exe -ErrorAction Stop
$InstanceConfigScript = Join-Path $PSScriptRoot 'print-instance-config.mjs'
$InstanceArguments = @($InstanceConfigScript)
if ($InstanceId) { $InstanceArguments += @('--instance-id', $InstanceId) }
if ($InstanceRoot) { $InstanceArguments += @('--instance-root', $InstanceRoot) }
if ($null -ne $Port) { $InstanceArguments += @('--port', [string]$Port) }
$InstanceConfig = (& $NodeCommand.Source $InstanceArguments | ConvertFrom-Json)
if (-not $InstanceConfig) { throw 'Instance configuration could not be resolved.' }
$InstanceId = [string]$InstanceConfig.instanceId
$InstanceRoot = [IO.Path]::GetFullPath([string]$InstanceConfig.instanceRoot)
$LegacyInstanceLayout = [bool]$InstanceConfig.legacyLayout
$Port = [int]$InstanceConfig.port
if ($InstanceId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
  throw 'InstanceId must contain only letters, digits, dot, underscore, or dash (1-64 characters).'
}
$HostRuntimeDirectory = Join-Path $RepositoryRoot '.ai-data'
$RuntimeDirectory = [IO.Path]::GetFullPath([string]$InstanceConfig.runtimeDirectory)
$LogDirectory = Join-Path $RuntimeDirectory 'logs'
$HostLogDirectory = Join-Path $HostRuntimeDirectory 'logs'
$StateFile = Join-Path $RuntimeDirectory 'processes.json'
$WebOutLog = Join-Path $LogDirectory 'web.out.log'
$WebErrorLog = Join-Path $LogDirectory 'web.error.log'
$WorkerOutLog = Join-Path $LogDirectory 'worker.out.log'
$WorkerErrorLog = Join-Path $LogDirectory 'worker.error.log'
$SearchPort = 8888
$SearchOutLog = Join-Path $HostLogDirectory 'search.out.log'
$SearchErrorLog = Join-Path $HostLogDirectory 'search.error.log'
$BrowserOutLog = Join-Path $HostLogDirectory 'browser.out.log'
$BrowserErrorLog = Join-Path $HostLogDirectory 'browser.error.log'

. (Join-Path $PSScriptRoot 'searxng-process.ps1')
. (Join-Path $PSScriptRoot 'bsk-process.ps1')

function Get-ProcessByIdSafe([int]$ProcessId) {
  if ($ProcessId -le 0) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Read-InstanceProcessState {
  if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
  } catch {
    Write-Host "Ignoring unreadable instance state: $StateFile" -ForegroundColor Yellow
    return $null
  }
}

function Test-RecordedInstanceProcess($Record, [string]$ExpectedEntry) {
  if (-not $Record -or -not $Record.pid -or -not $Record.startTime) { return $false }
  $processId = [int]$Record.pid
  $owner = Get-ProcessByIdSafe $processId
  if (-not $owner) { return $false }
  if ([string]$owner.Name -ne 'node.exe') { return $false }
  $normalizedCommand = ([string]$owner.CommandLine).Replace('/', '\').ToLowerInvariant()
  $normalizedEntry = $ExpectedEntry.Replace('/', '\').ToLowerInvariant()
  if (-not $normalizedCommand.Contains($normalizedEntry)) { return $false }
  try {
    $actual = (Get-Process -Id $processId -ErrorAction Stop).StartTime.ToUniversalTime()
    $recorded = ([DateTimeOffset]::Parse([string]$Record.startTime)).UtcDateTime
    return [Math]::Abs(($actual - $recorded).TotalSeconds) -lt 2
  } catch {
    return $false
  }
}

function Stop-RecordedInstanceProcesses {
  $state = Read-InstanceProcessState
  if (-not $state) { return }
  if ($state.schemaVersion -ne 1 -or
      [string]$state.instanceId -ne $InstanceId -or
      [IO.Path]::GetFullPath([string]$state.instanceRoot) -ne [IO.Path]::GetFullPath($InstanceRoot)) {
    Write-Host 'Ignoring legacy or mismatched instance state; no process was stopped.' -ForegroundColor DarkYellow
    return
  }
  foreach ($item in @(
    @{ Name = 'Web'; Record = $state.processes.web; Entry = $WebEntry },
    @{ Name = 'Worker'; Record = $state.processes.worker; Entry = $WorkerEntry }
  )) {
    if (Test-RecordedInstanceProcess -Record $item.Record -ExpectedEntry $item.Entry) {
      Write-Host "Stopping recorded $($item.Name) PID $($item.Record.pid)..." -ForegroundColor Yellow
      Stop-Process -Id ([int]$item.Record.pid) -Force -ErrorAction SilentlyContinue
    } elseif ($item.Record -and $item.Record.pid) {
      Write-Host "Not stopping stale or mismatched recorded PID $($item.Record.pid)." -ForegroundColor DarkYellow
    }
  }
  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
}

function Assert-PortAvailable {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -eq 0) {
    return
  }

  $ownerDescriptions = foreach ($listener in $listeners) {
    $owner = Get-ProcessByIdSafe ([int]$listener.OwningProcess)
    if ($owner) {
      "PID $($owner.ProcessId): $($owner.Name) $($owner.CommandLine)"
    } else {
      "PID $($listener.OwningProcess)"
    }
  }
  throw "Port $Port is in use by another program; it was not stopped:`n$($ownerDescriptions -join "`n")"
}

function Start-HiddenLoggedProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$OutLog,
    [string]$ErrorLog
  )
  $lastError = $null
  foreach ($attempt in 1..6) {
    try {
      return Start-Process -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput $OutLog `
        -RedirectStandardError $ErrorLog `
        -PassThru
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 400
    }
  }
  throw "Cannot write log $OutLog : $($lastError.Exception.Message)"
}

function Get-ExitedProcessHint([string]$Name, [string]$LogPath) {
  $logged = @(Get-Content -LiteralPath $LogPath -ErrorAction SilentlyContinue | Where-Object { $_.Trim() })
  if ($logged.Count -gt 0) {
    return "$Name exited unexpectedly. See $LogPath"
  }
  return "$Name exited unexpectedly, but $LogPath is empty. See the instance process state at $StateFile."
}

function Stop-StartedProcess([System.Diagnostics.Process]$Process) {
  if ($null -eq $Process) {
    return
  }
  $Process.Refresh()
  if (-not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  }
}

function Stop-StartedAiCenterProcesses {
  Stop-StartedProcess $workerProcess
  Stop-StartedProcess $webProcess
}

function New-ProcessRecord([System.Diagnostics.Process]$Process) {
  if ($null -eq $Process) { return $null }
  $Process.Refresh()
  return [ordered]@{
    pid = $Process.Id
    startTime = $Process.StartTime.ToUniversalTime().ToString('o')
  }
}

function Write-InstanceProcessState {
  $state = [ordered]@{
    schemaVersion = 1
    instanceId = $InstanceId
    instanceRoot = $InstanceRoot
    port = $Port
    processes = [ordered]@{
      web = New-ProcessRecord $webProcess
      worker = New-ProcessRecord $workerProcess
    }
    startedAt = [DateTimeOffset]::Now.ToString('o')
  } | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText($StateFile, $state, [System.Text.UTF8Encoding]::new($false))
}

function Wait-ForCtrlCOrCrash {
  if (-not ('AiCenterConsoleCtrl' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class AiCenterConsoleCtrl {
  public static volatile bool StopRequested;
  public delegate bool HandlerRoutine(uint ctrlType);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetConsoleCtrlHandler(HandlerRoutine handler, bool add);
  public static readonly HandlerRoutine Handler = OnCtrl;
  static bool OnCtrl(uint ctrlType) {
    StopRequested = true;
    return true;
  }
}
'@
  }
  [AiCenterConsoleCtrl]::StopRequested = $false
  $registered = [AiCenterConsoleCtrl]::SetConsoleCtrlHandler([AiCenterConsoleCtrl]::Handler, $true)
  try {
    Write-Host ''
    Write-Host 'Keep this window open. Ctrl+C stops services; Enter starts them again in this folder.' -ForegroundColor DarkGray
    while (-not [AiCenterConsoleCtrl]::StopRequested) {
      $webProcess.Refresh()
      $workerProcess.Refresh()
      if ($webProcess.HasExited) {
        throw (Get-ExitedProcessHint -Name 'Web' -LogPath $WebErrorLog)
      }
      if ($workerProcess.HasExited) {
        throw "Worker exited unexpectedly. See $WorkerErrorLog"
      }
      if ($searchProcess) {
        $searchProcess.Refresh()
      }
      if ($browserProcess) {
        $browserProcess.Refresh()
        if ($browserProcess.HasExited) {
          Write-Host "[!] Browser host service exited. Web and Worker will keep running; see $BrowserErrorLog" -ForegroundColor Yellow
          $browserProcess = $null
        }
      }
      Start-Sleep -Milliseconds 800
    }
  } finally {
    if ($registered) {
      [void][AiCenterConsoleCtrl]::SetConsoleCtrlHandler([AiCenterConsoleCtrl]::Handler, $false)
    }
  }
}

Set-Location -LiteralPath $RepositoryRoot

while ($true) {
  $webProcess = $null
  $workerProcess = $null
  $searchProcess = $null
  $browserProcess = $null
  $searchStatus = 'skipped'
  $browserStatus = 'skipped'
  $browserOwned = $false

  try {
    if (-not (Test-Path -LiteralPath $WebEntry -PathType Leaf) -or
        -not (Test-Path -LiteralPath $WorkerEntry -PathType Leaf)) {
      throw 'Launcher files are missing. Run this from the AI-Center repo.'
    }

    if (-not (Test-Path -LiteralPath (Join-Path $RepositoryRoot 'node_modules'))) {
      throw 'Dependencies are missing. Run npm install in AI-Center first.'
    }

    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $HostLogDirectory -Force | Out-Null
    Write-Host "Checking recorded processes for instance $InstanceId..." -ForegroundColor Cyan
    Stop-RecordedInstanceProcesses
    Assert-PortAvailable

    Write-Host 'Starting Browser, Web, Worker, and Search...' -ForegroundColor Cyan
    $previousPort = $env:AI_CENTER_PORT
    $previousBrowserProvider = $env:AI_BROWSER_PROVIDER
    $previousBskAutoStart = $env:BSK_AUTO_START
    $previousBskPath = $env:AI_BSK_PATH
    $previousInstanceId = $env:AI_CENTER_INSTANCE_ID
    $previousInstanceRoot = $env:AI_CENTER_INSTANCE_DIR
    $env:AI_CENTER_PORT = [string]$Port
    $env:AI_CENTER_INSTANCE_ID = $InstanceId
    if (-not $LegacyInstanceLayout) {
      $env:AI_CENTER_INSTANCE_DIR = $InstanceRoot
    }
    if (-not $env:AI_BROWSER_PROVIDER) {
      $env:AI_BROWSER_PROVIDER = 'bsk'
    }
    $bundledBsk = Join-Path $RepositoryRoot 'externaltools\bsk.exe'
    if (-not $env:AI_BSK_PATH -and (Test-Path -LiteralPath $bundledBsk -PathType Leaf)) {
      $env:AI_BSK_PATH = $bundledBsk
    }
    $env:BSK_AUTO_START = '0'
    $existingBrowser = Get-AiCenterBrowserStatus
    if ($existingBrowser -and $existingBrowser.pid) {
      $browserStatus = 'reused'
      Write-Host "[OK] Browser daemon already running PID $($existingBrowser.pid)" -ForegroundColor DarkGray
    } else {
      try {
        $browserProcess = Start-AiCenterBrowserDaemon -OutLog $BrowserOutLog -ErrorLog $BrowserErrorLog
        $browserOwned = $true
        $ready = Wait-AiCenterBrowserDaemon
        if (-not $ready) {
          $browserStatus = 'failed'
          Write-Host '[!] Browser daemon did not become ready. See logs\browser.error.log' -ForegroundColor Yellow
        } else {
          $browserStatus = 'ok'
        }
      } catch {
        $browserStatus = 'failed'
        Write-Host "[!] Browser daemon failed to start: $($_.Exception.Message)" -ForegroundColor Yellow
      }
    }
    try {
      $webProcess = Start-HiddenLoggedProcess `
        -FilePath $NodeCommand.Source `
        -ArgumentList @("`"$WebEntry`"") `
        -WorkingDirectory $RepositoryRoot `
        -OutLog $WebOutLog `
        -ErrorLog $WebErrorLog

      $workerProcess = Start-HiddenLoggedProcess `
        -FilePath $NodeCommand.Source `
        -ArgumentList @("`"$WorkerEntry`"") `
        -WorkingDirectory $RepositoryRoot `
        -OutLog $WorkerOutLog `
        -ErrorLog $WorkerErrorLog
    } finally {
      if ($null -eq $previousPort) {
        Remove-Item Env:AI_CENTER_PORT -ErrorAction SilentlyContinue
      } else {
        $env:AI_CENTER_PORT = $previousPort
      }
      if ($null -eq $previousBrowserProvider) {
        Remove-Item Env:AI_BROWSER_PROVIDER -ErrorAction SilentlyContinue
      } else {
        $env:AI_BROWSER_PROVIDER = $previousBrowserProvider
      }
      if ($null -eq $previousBskAutoStart) {
        Remove-Item Env:BSK_AUTO_START -ErrorAction SilentlyContinue
      } else {
        $env:BSK_AUTO_START = $previousBskAutoStart
      }
      if ($null -eq $previousBskPath) {
        Remove-Item Env:AI_BSK_PATH -ErrorAction SilentlyContinue
      } else {
        $env:AI_BSK_PATH = $previousBskPath
      }
      if ($null -eq $previousInstanceId) {
        Remove-Item Env:AI_CENTER_INSTANCE_ID -ErrorAction SilentlyContinue
      } else {
        $env:AI_CENTER_INSTANCE_ID = $previousInstanceId
      }
      if ($null -eq $previousInstanceRoot) {
        Remove-Item Env:AI_CENTER_INSTANCE_DIR -ErrorAction SilentlyContinue
      } else {
        $env:AI_CENTER_INSTANCE_DIR = $previousInstanceRoot
      }
    }

    Write-InstanceProcessState

    if (-not (Test-SearxngInstalled)) {
      $searchStatus = 'missing'
    } elseif (Wait-SearxngHealth -ListenPort $SearchPort -TimeoutSeconds 1) {
      $searchStatus = 'reused'
      Write-Host '[OK] Search host service already running.' -ForegroundColor DarkGray
    } else {
      try {
        $searchProcess = Start-AiCenterSearchProcess -OutLog $SearchOutLog -ErrorLog $SearchErrorLog
      } catch {
        $searchStatus = 'failed'
        Write-Host "[!] Search failed to start: $($_.Exception.Message)" -ForegroundColor Yellow
      }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $health = $null
    do {
      $webProcess.Refresh()
      $workerProcess.Refresh()
      if ($webProcess.HasExited) {
        throw (Get-ExitedProcessHint -Name 'Web' -LogPath $WebErrorLog)
      }
      if ($workerProcess.HasExited) {
        throw "Worker exited after start. See $WorkerErrorLog"
      }

      try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/health" -TimeoutSec 2
      } catch {
        Start-Sleep -Milliseconds 350
      }
    } while (-not $health -and [DateTime]::UtcNow -lt $deadline)

    if (-not $health -or -not $health.ok) {
      throw "Web did not pass health check within 15s. See $WebErrorLog"
    }

    if (-not (Test-SearxngInstalled)) {
      Write-Host '[!] Search is not installed. Run scripts\setup-searxng.ps1 once.' -ForegroundColor Yellow
    } elseif ($searchStatus -eq 'failed') {
      # already reported
    } elseif ($searchProcess) {
      $searchProcess.Refresh()
      if ($searchProcess.HasExited) {
        $searchStatus = 'failed'
        Write-Host "[!] Search exited. See $SearchErrorLog" -ForegroundColor Yellow
      } elseif (Wait-SearxngHealth -ListenPort $SearchPort) {
        $searchStatus = 'ok'
      } else {
        $searchStatus = 'failed'
        Write-Host "[!] Search did not become ready. See $SearchErrorLog" -ForegroundColor Yellow
      }
    }

    $browserHealth = Get-AiCenterBrowserStatus
    $browserCount = 0
    if ($browserHealth -and $browserHealth.browsers) {
      $browserCount = @($browserHealth.browsers).Count
    }
    if ($browserHealth -and $browserCount -gt 0) {
      if ($browserStatus -ne 'reused') { $browserStatus = 'ok' }
    } elseif ($browserHealth) {
      Write-Host '[!] Browser daemon is up, but no Chrome extension is connected.' -ForegroundColor Yellow
    }

    Write-Host ''
    Write-Host 'AI Center started.' -ForegroundColor Green
    Write-Host "[OK] Web     127.0.0.1:$Port"
    Write-Host "[OK] Worker  PID $($workerProcess.Id)"
    if ($browserHealth -and $browserCount -gt 0) {
      Write-Host "[OK] Browser daemon + extension ($browserCount)"
    } elseif ($browserHealth) {
      Write-Host '[!] Browser daemon up; connect BrowserSkill extension in Chrome' -ForegroundColor Yellow
    } else {
      Write-Host '[!] Browser unavailable' -ForegroundColor Yellow
    }
    if ($searchStatus -eq 'ok' -or $searchStatus -eq 'reused') {
      Write-Host "[OK] Search  127.0.0.1:$SearchPort"
    } else {
      Write-Host '[!] Search unavailable' -ForegroundColor Yellow
    }
    Write-Host "Open: http://127.0.0.1:$Port/"
    $phoneLines = @(Get-Content -LiteralPath $WebOutLog -ErrorAction SilentlyContinue |
        Where-Object { $_ -like 'Phone:*' })
    if ($phoneLines.Count -gt 0) {
      $phoneLines | ForEach-Object { Write-Host $_ }
    } else {
      Write-Host 'Phone: no LAN IPv4 address found.' -ForegroundColor Yellow
    }
    Write-Host "Web PID: $($webProcess.Id); Worker PID: $($workerProcess.Id)$(if ($searchProcess -and $searchStatus -eq 'ok') { "; Search PID: $($searchProcess.Id)" } else { '' })$(if ($browserProcess -and $browserOwned) { "; Browser PID: $($browserProcess.Id)" } else { '' })"
    Write-Host "Logs: $LogDirectory"
    Wait-ForCtrlCOrCrash
    Write-Host ''
    Write-Host 'Stopping AI Center...' -ForegroundColor Yellow
  } catch {
    Stop-StartedAiCenterProcesses
    Write-Host ''
    Write-Host "AI Center failed to start: $($_.Exception.Message)" -ForegroundColor Red
  }

  Stop-StartedAiCenterProcesses
  Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 400
  Write-Host ''
  Write-Host 'Stopped. Press Enter to start again, or q then Enter to stay in this folder.' -ForegroundColor Green
  $answer = Read-Host 'Restart'
  if ($answer -match '^[qQ]$') {
    break
  }
}

function global:Start-AiCenter {
  & $PSCommandPath @args
}
Set-Alias -Name sa -Value Start-AiCenter -Scope Global -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "Folder: $RepositoryRoot"
Write-Host 'Start again with:  sa'
