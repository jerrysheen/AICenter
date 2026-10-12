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
$DataDirectory = [IO.Path]::GetFullPath([string]$InstanceConfig.dataDirectory)
$DatabasePath = [IO.Path]::GetFullPath([string]$InstanceConfig.databasePath)
$RepositoryEnvPath = [string]$InstanceConfig.repositoryEnvPath
$InstanceEnvPath = [string]$InstanceConfig.instanceEnvPath
$DeployStatusFile = Join-Path $DataDirectory 'deploy-status.json'
$DeployBackupRoot = Join-Path $DataDirectory 'deploy-backups'
$script:deployInProgress = $false
$script:deploySettings = $null
$script:nextDeployCheckUtc = [DateTime]::UtcNow.AddDays(1)
$LogDirectory = Join-Path $RuntimeDirectory 'logs'
$HostLogDirectory = Join-Path $HostRuntimeDirectory 'logs'
$StateFile = Join-Path $RuntimeDirectory 'processes.json'
$RestartRequestFile = Join-Path $RuntimeDirectory 'restart.request'
$WorkerRestartRequestFile = Join-Path $RuntimeDirectory 'restart.worker.request'
$WebOutLog = Join-Path $LogDirectory 'web.out.log'
$WebErrorLog = Join-Path $LogDirectory 'web.error.log'
$WorkerOutLog = Join-Path $LogDirectory 'worker.out.log'
$WorkerErrorLog = Join-Path $LogDirectory 'worker.error.log'
$SearchPort = 8888
$SearchOutLog = Join-Path $HostLogDirectory 'search.out.log'
$SearchErrorLog = Join-Path $HostLogDirectory 'search.error.log'
$BrowserOutLog = Join-Path $HostLogDirectory 'browser.out.log'
$BrowserErrorLog = Join-Path $HostLogDirectory 'browser.error.log'
$CloudflareOutLog = Join-Path $HostLogDirectory 'cloudflared.out.log'
$CloudflareErrorLog = Join-Path $HostLogDirectory 'cloudflared.error.log'

. (Join-Path $PSScriptRoot 'searxng-process.ps1')
. (Join-Path $PSScriptRoot 'bsk-process.ps1')
. (Join-Path $PSScriptRoot 'cloudflared-process.ps1')
. (Join-Path $PSScriptRoot 'deploy-logic.ps1')
. (Join-Path $PSScriptRoot 'deploy-run.ps1')

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

function Test-InstanceNodeEntry([string]$CommandLine, [string]$AbsoluteEntry) {
  if (-not $CommandLine) { return $false }
  $command = $CommandLine.Replace('/', '\').ToLowerInvariant()
  $absolute = $AbsoluteEntry.Replace('/', '\').ToLowerInvariant()
  # Unrecorded processes need an exact entry and explicit Instance identity.
  # Older processes without markers are handled only by the recorded PID checks.
  $entryPattern = '^\s*(?:"[^"]+"|\S+)\s+"?' + [regex]::Escape($absolute) + '"?(?=\s|$)'
  $rootMarker = ('--ai-center-instance-root=' + $InstanceRoot).Replace('/', '\').ToLowerInvariant()
  $idMarker = ('--ai-center-instance-id=' + $InstanceId).ToLowerInvariant()
  return $command -match $entryPattern -and
    $command -match ('(?:^|\s)"?' + [regex]::Escape($rootMarker) + '"?(?=\s|$)') -and
    $command -match ('(?:^|\s)"?' + [regex]::Escape($idMarker) + '"?(?=\s|$)')
}

function Stop-PreviousInstanceNodes {
  $nodes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)
  $stopped = $false
  foreach ($owner in $nodes) {
    $command = [string]$owner.CommandLine
    $isWeb = Test-InstanceNodeEntry $command $WebEntry
    $isWorker = Test-InstanceNodeEntry $command $WorkerEntry
    if (-not $isWeb -and -not $isWorker) { continue }
    $name = if ($isWeb) { 'Web' } else { 'Worker' }
    Write-Host "Stopping previous $name PID $($owner.ProcessId)..." -ForegroundColor Yellow
    Stop-Process -Id ([int]$owner.ProcessId) -Force -ErrorAction SilentlyContinue
    $stopped = $true
  }
  if ($stopped) {
    Start-Sleep -Milliseconds 500
  }
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

function Update-AiCenterProcessLogs {
  param([switch]$WorkerOnly)
  $day = [DateTime]::Now.ToString('yyyy-MM-dd')
  if (-not $WorkerOnly) {
    $script:WebOutLog = Join-Path $LogDirectory "web.out.$day.log"
    $script:WebErrorLog = Join-Path $LogDirectory "web.error.$day.log"
  }
  $script:WorkerOutLog = Join-Path $LogDirectory "worker.out.$day.log"
  $script:WorkerErrorLog = Join-Path $LogDirectory "worker.error.$day.log"
  $keepFrom = [DateTime]::Today.AddDays(-6)
  Get-ChildItem -LiteralPath $LogDirectory -File -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -match '^(web|worker)\.(out|error)\.(\d{4}-\d{2}-\d{2})\.log$') {
      try {
        $loggedDay = [DateTime]::ParseExact($Matches[3], 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
        if ($loggedDay.Date -lt $keepFrom.Date) {
          Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
        }
      } catch {}
    }
  }
}

function Start-HiddenLoggedProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$OutLog,
    [string]$ErrorLog
  )
  if (-not ('AiCenterAppendLog' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

public static class AiCenterAppendLog {
  public static Process Start(string fileName, string arguments, string workingDirectory, string outLog, string errorLog) {
    var utf8 = new UTF8Encoding(false);
    var stdout = new StreamWriter(new FileStream(outLog, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), utf8);
    stdout.AutoFlush = true;
    var stderr = new StreamWriter(new FileStream(errorLog, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), utf8);
    stderr.AutoFlush = true;
    try {
      var psi = new ProcessStartInfo();
      psi.FileName = fileName;
      psi.Arguments = arguments;
      psi.WorkingDirectory = workingDirectory;
      psi.UseShellExecute = false;
      psi.RedirectStandardOutput = true;
      psi.RedirectStandardError = true;
      psi.CreateNoWindow = true;
      psi.StandardOutputEncoding = utf8;
      psi.StandardErrorEncoding = utf8;
      var process = new Process();
      process.StartInfo = psi;
      process.EnableRaisingEvents = true;
      var gate = new object();
      var stamp = "----- " + DateTimeOffset.Now.ToString("o") + " start -----";
      stdout.WriteLine(stamp);
      stderr.WriteLine(stamp);
      process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
        if (e.Data == null) return;
        lock (gate) { if (stdout != null) stdout.WriteLine(e.Data); }
      };
      process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) {
        if (e.Data == null) return;
        lock (gate) { if (stderr != null) stderr.WriteLine(e.Data); }
      };
      process.Exited += delegate(object sender, EventArgs e) {
        lock (gate) {
          try { if (stdout != null) stdout.Dispose(); } catch (Exception) {}
          stdout = null;
          try { if (stderr != null) stderr.Dispose(); } catch (Exception) {}
          stderr = null;
        }
      };
      if (!process.Start()) throw new InvalidOperationException("process did not start");
      process.BeginOutputReadLine();
      process.BeginErrorReadLine();
      return process;
    } catch {
      try { stdout.Dispose(); } catch (Exception) {}
      try { stderr.Dispose(); } catch (Exception) {}
      throw;
    }
  }
}
'@
  }
  $arguments = $ArgumentList -join ' '
  $lastError = $null
  foreach ($attempt in 1..6) {
    try {
      return [AiCenterAppendLog]::Start($FilePath, $arguments, $WorkingDirectory, $OutLog, $ErrorLog)
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

function Start-AiCenterWebAndWorker {
  param([switch]$WorkerOnly)
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
  $started = @{ web = $null; worker = $null }
  try {
    if (-not $WorkerOnly) {
      $started.web = Start-HiddenLoggedProcess `
        -FilePath $NodeCommand.Source `
        -ArgumentList @("`"$WebEntry`"", "`"--ai-center-instance-root=$InstanceRoot`"", "`"--ai-center-instance-id=$InstanceId`"") `
        -WorkingDirectory $RepositoryRoot `
        -OutLog $WebOutLog `
        -ErrorLog $WebErrorLog
    }
    $started.worker = Start-HiddenLoggedProcess `
      -FilePath $NodeCommand.Source `
      -ArgumentList @("`"$WorkerEntry`"", "`"--ai-center-instance-root=$InstanceRoot`"", "`"--ai-center-instance-id=$InstanceId`"") `
      -WorkingDirectory $RepositoryRoot `
      -OutLog $WorkerOutLog `
      -ErrorLog $WorkerErrorLog
  } finally {
    if ($null -eq $previousPort) { Remove-Item Env:AI_CENTER_PORT -ErrorAction SilentlyContinue } else { $env:AI_CENTER_PORT = $previousPort }
    if ($null -eq $previousBrowserProvider) { Remove-Item Env:AI_BROWSER_PROVIDER -ErrorAction SilentlyContinue } else { $env:AI_BROWSER_PROVIDER = $previousBrowserProvider }
    if ($null -eq $previousBskAutoStart) { Remove-Item Env:BSK_AUTO_START -ErrorAction SilentlyContinue } else { $env:BSK_AUTO_START = $previousBskAutoStart }
    if ($null -eq $previousBskPath) { Remove-Item Env:AI_BSK_PATH -ErrorAction SilentlyContinue } else { $env:AI_BSK_PATH = $previousBskPath }
    if ($null -eq $previousInstanceId) { Remove-Item Env:AI_CENTER_INSTANCE_ID -ErrorAction SilentlyContinue } else { $env:AI_CENTER_INSTANCE_ID = $previousInstanceId }
    if ($null -eq $previousInstanceRoot) { Remove-Item Env:AI_CENTER_INSTANCE_DIR -ErrorAction SilentlyContinue } else { $env:AI_CENTER_INSTANCE_DIR = $previousInstanceRoot }
  }
  return $started
}

function Wait-AiCenterWebHealth($Web, $Worker, [int]$Seconds = 90, [int]$IntervalSeconds = 4) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  $health = $null
  do {
    $Web.Refresh()
    $Worker.Refresh()
    if ($Web.HasExited) {
      throw (Get-ExitedProcessHint -Name 'Web' -LogPath $WebErrorLog)
    }
    if ($Worker.HasExited) {
      throw "Worker exited after start. See $WorkerErrorLog"
    }
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/health" -TimeoutSec 2
    } catch {
      $health = $null
    }
    if ($health -and $health.ok) {
      return $health
    }
    if ([DateTime]::UtcNow -ge $deadline) {
      break
    }
    $remainingMs = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
    if ($remainingMs -le 0) { break }
    $pauseMs = [Math]::Min($IntervalSeconds * 1000, $remainingMs)
    Start-Sleep -Milliseconds $pauseMs
  } while ($true)
  throw "Web did not pass health check within ${Seconds}s. See $WebErrorLog"
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
      if ($script:deployInProgress) {
        Start-Sleep -Milliseconds 800
        continue
      }
      if ($script:deploySettings -and $script:deploySettings.Enabled -and [DateTime]::UtcNow -ge $script:nextDeployCheckUtc) {
        $script:nextDeployCheckUtc = [DateTime]::UtcNow.AddSeconds([int]$script:deploySettings.IntervalSeconds)
        try {
          Invoke-AiCenterAutoDeploy
        } catch {
          $message = ''
          $position = ''
          $stack = ''
          if ($null -ne $_.Exception) { $message = [string]$_.Exception.Message }
          if ($null -ne $_.InvocationInfo) { $position = [string]$_.InvocationInfo.PositionMessage }
          $stack = [string]$_.ScriptStackTrace
          $detail = $message
          try {
            $detail = Format-AiCenterDeployErrorText -Message $message -PositionMessage $position -ScriptStackTrace $stack
          } catch {
            if (-not $detail) { $detail = 'Auto-deploy failed.' }
          }
          $consoleDetail = $message.Replace("`r", ' ').Replace("`n", ' ').Trim()
          if ($consoleDetail.Length -gt 240) { $consoleDetail = $consoleDetail.Substring(0, 240) }
          if ($consoleDetail) {
            Write-Host "[!] Auto-deploy error: $consoleDetail" -ForegroundColor Yellow
          } else {
            Write-Host '[!] Auto-deploy error.' -ForegroundColor Yellow
          }
          if ($position -or $stack) {
            Write-Host $detail -ForegroundColor Yellow
          }
          try {
            Write-AiCenterDeployErrorStatus -ErrorText $detail
          } catch {
            Write-Host "[!] Auto-deploy: could not write deploy status. $($_.Exception.Message)" -ForegroundColor Yellow
          }
        }
        if ([AiCenterConsoleCtrl]::StopRequested) { return 'stop' }
      }
      $webProcess.Refresh()
      $workerProcess.Refresh()
      $fullRestartRequested = Test-Path -LiteralPath $RestartRequestFile -PathType Leaf
      if ($webProcess.HasExited -or $fullRestartRequested) {
        if ($webProcess.HasExited) {
          Write-Host (Get-ExitedProcessHint -Name 'Web' -LogPath $WebErrorLog) -ForegroundColor Yellow
        }
        if ($workerProcess.HasExited) {
          Write-Host "Worker exited unexpectedly. See $WorkerErrorLog" -ForegroundColor Yellow
        }
        if (-not $fullRestartRequested) {
          Write-Host 'Web exited. Restarting Web and Worker; tunnel stays up.' -ForegroundColor Cyan
        }
        return 'restart'
      }
      if ($workerProcess.HasExited -or (Test-Path -LiteralPath $WorkerRestartRequestFile -PathType Leaf)) {
        if ($workerProcess.HasExited) {
          Write-Host "Worker exited unexpectedly. See $WorkerErrorLog" -ForegroundColor Yellow
          Write-Host 'Restarting Worker only. Web stays up.' -ForegroundColor Cyan
        }
        return 'restart-worker'
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
      if ($cloudflareProcess) {
        $cloudflareProcess.Refresh()
        if ($cloudflareProcess.HasExited) {
          Write-Host "[!] Public tunnel exited. Web and Worker will keep running; see $CloudflareErrorLog" -ForegroundColor Yellow
          $cloudflareProcess = $null
          $cloudflareStatus = 'failed'
        }
      }
      Start-Sleep -Milliseconds 800
    }
    return 'stop'
  } finally {
    if ($registered) {
      [void][AiCenterConsoleCtrl]::SetConsoleCtrlHandler([AiCenterConsoleCtrl]::Handler, $false)
    }
  }
}

function Restart-AiCenterWorkerOnly {
  Write-Host ''
  Write-Host 'Restarting Worker only. Web stays up.' -ForegroundColor Cyan
  Remove-Item -LiteralPath $WorkerRestartRequestFile -Force -ErrorAction SilentlyContinue
  Update-AiCenterProcessLogs -WorkerOnly
  Stop-StartedProcess $script:workerProcess
  Start-Sleep -Milliseconds 500
  $healthy = $false
  $needsStart = $true
  foreach ($healthAttempt in 1, 2) {
    try {
      if ($needsStart -or -not $script:workerProcess -or $script:workerProcess.HasExited) {
        $started = Start-AiCenterWebAndWorker -WorkerOnly
        $script:workerProcess = $started.worker
        Write-InstanceProcessState
        $needsStart = $false
      }
      [void](Wait-AiCenterWebHealth -Web $script:webProcess -Worker $script:workerProcess)
      $healthy = $true
      break
    } catch {
      Write-Host "[!] $($_.Exception.Message)" -ForegroundColor Yellow
      $script:webProcess.Refresh()
      if ($script:webProcess.HasExited) {
        return 'web-down'
      }
      if ($healthAttempt -ge 2) { break }
      if ($script:workerProcess) { $script:workerProcess.Refresh() }
      if (-not $script:workerProcess -or $script:workerProcess.HasExited) {
        Write-Host 'Worker exited during restart. Starting it once more. Web stays up.' -ForegroundColor Yellow
        Stop-StartedProcess $script:workerProcess
        $needsStart = $true
        Start-Sleep -Milliseconds 500
      } else {
        Write-Host 'Health check failed. Retrying without stopping Web.' -ForegroundColor Yellow
      }
    }
  }
  if ($healthy) {
    Write-Host "[OK] Worker restarted. Web PID $($script:webProcess.Id); Worker PID $($script:workerProcess.Id)" -ForegroundColor Green
    return 'ok'
  }
  Write-Host '[!] Worker restart did not pass health check. Web is still running.' -ForegroundColor Yellow
  Start-Sleep -Seconds 5
  return 'left-web-up'
}

Set-Location -LiteralPath $RepositoryRoot

while ($true) {
  $webProcess = $null
  $workerProcess = $null
  $searchProcess = $null
  $browserProcess = $null
  $cloudflareProcess = $null
  $searchStatus = 'skipped'
  $browserStatus = 'skipped'
  $cloudflareStatus = 'skipped'
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
    Update-AiCenterProcessLogs
    Write-Host "Checking recorded processes for instance $InstanceId..." -ForegroundColor Cyan
    Stop-RecordedInstanceProcesses
    Stop-PreviousInstanceNodes
    Assert-PortAvailable

    Write-Host 'Starting Browser, Web, Worker, Search, and Tunnel...' -ForegroundColor Cyan
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

    if (-not (Test-CloudflaredConfigured)) {
      $cloudflareStatus = 'missing'
    } elseif (Test-CloudflaredRunning) {
      $cloudflareStatus = 'reused'
      Write-Host '[OK] Public tunnel already running.' -ForegroundColor DarkGray
    } else {
      try {
        $cloudflareProcess = Start-AiCenterCloudflaredProcess -OutLog $CloudflareOutLog -ErrorLog $CloudflareErrorLog
        $cloudflareStatus = if ($cloudflareProcess) { 'ok' } else { 'reused' }
      } catch {
        $cloudflareStatus = 'failed'
        Write-Host "[!] Public tunnel failed to start: $($_.Exception.Message)" -ForegroundColor Yellow
      }
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
    if ($cloudflareStatus -eq 'ok' -or $cloudflareStatus -eq 'reused') {
      Write-Host '[OK] Tunnel  public HTTPS'
    } elseif ($cloudflareStatus -eq 'missing') {
      Write-Host '[!] Tunnel not configured. Public hostname stays off until .ai-data/cloudflare is set up.' -ForegroundColor Yellow
    } else {
      Write-Host '[!] Tunnel unavailable' -ForegroundColor Yellow
    }
    Write-Host "Open: http://127.0.0.1:$Port/"
    $phoneLines = @(Get-Content -LiteralPath $WebOutLog -ErrorAction SilentlyContinue |
        Where-Object { $_ -like 'Phone:*' })
    if ($phoneLines.Count -gt 0) {
      $phoneLines | ForEach-Object { Write-Host $_ }
    } else {
      Write-Host 'Phone: no LAN IPv4 address found.' -ForegroundColor Yellow
    }
    Write-Host "Web PID: $($webProcess.Id); Worker PID: $($workerProcess.Id)$(if ($searchProcess -and $searchStatus -eq 'ok') { "; Search PID: $($searchProcess.Id)" } else { '' })$(if ($browserProcess -and $browserOwned) { "; Browser PID: $($browserProcess.Id)" } else { '' })$(if ($cloudflareProcess -and $cloudflareStatus -eq 'ok') { "; Tunnel PID: $($cloudflareProcess.Id)" } else { '' })"
    Write-Host "Logs: $LogDirectory"
    $script:deploySettings = Get-AiCenterDeploySettings -Environment @{
      AI_CENTER_AUTO_DEPLOY = [string]$env:AI_CENTER_AUTO_DEPLOY
      AI_CENTER_DEPLOY_INTERVAL_SECONDS = [string]$env:AI_CENTER_DEPLOY_INTERVAL_SECONDS
      AI_CENTER_DEPLOY_REF = [string]$env:AI_CENTER_DEPLOY_REF
      AI_CENTER_DEPLOY_BACKUP_KEEP = [string]$env:AI_CENTER_DEPLOY_BACKUP_KEEP
      AI_CENTER_DEPLOY_LOCK_MINUTES = [string]$env:AI_CENTER_DEPLOY_LOCK_MINUTES
    }
    $script:nextDeployCheckUtc = [DateTime]::UtcNow
    $script:deployMissingRefLogged = $false
    $script:lastDeployedSha = ''
    if ($script:deploySettings.Enabled) {
      Write-Host "Auto-deploy: every $($script:deploySettings.IntervalSeconds)s, ref $($script:deploySettings.Ref). .env is backed up and not applied." -ForegroundColor DarkGray
    }
    $waitResult = 'restart'
    while ($waitResult -eq 'restart' -or $waitResult -eq 'restart-worker') {
      $waitResult = Wait-ForCtrlCOrCrash
      if ($waitResult -eq 'stop') { break }
      if ($waitResult -eq 'restart-worker' -and -not $webProcess.HasExited) {
        $workerRestart = Restart-AiCenterWorkerOnly
        if ($workerRestart -ne 'web-down') { continue }
        Write-Host 'Web exited during worker restart. Restarting Web and Worker. Tunnel stays up.' -ForegroundColor Cyan
      }
      Write-Host ''
      Write-Host 'Restarting Web/Worker. Tunnel stays up.' -ForegroundColor Cyan
      Remove-Item -LiteralPath $RestartRequestFile -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $WorkerRestartRequestFile -Force -ErrorAction SilentlyContinue
      Update-AiCenterProcessLogs
      Stop-StartedAiCenterProcesses
      Start-Sleep -Milliseconds 500
      $started = Start-AiCenterWebAndWorker
      $webProcess = $started.web
      $workerProcess = $started.worker
      Write-InstanceProcessState
      $restartHealthy = $false
      foreach ($healthAttempt in 1, 2) {
        try {
          [void](Wait-AiCenterWebHealth -Web $webProcess -Worker $workerProcess)
          $restartHealthy = $true
          break
        } catch {
          Write-Host "[!] $($_.Exception.Message)" -ForegroundColor Yellow
          if ($healthAttempt -ge 2) { break }
          $webProcess.Refresh()
          $workerProcess.Refresh()
          if ($webProcess.HasExited -or $workerProcess.HasExited) {
            Write-Host 'Web or Worker exited during restart. Starting them once more. Tunnel stays up.' -ForegroundColor Yellow
            Stop-StartedAiCenterProcesses
            Start-Sleep -Milliseconds 500
            $started = Start-AiCenterWebAndWorker
            $webProcess = $started.web
            $workerProcess = $started.worker
            Write-InstanceProcessState
          } else {
            Write-Host 'Health check failed. Retrying without stopping Web/Worker.' -ForegroundColor Yellow
          }
        }
      }
      if ($restartHealthy) {
        Write-Host "[OK] Web/Worker restarted. Web PID $($webProcess.Id); Worker PID $($workerProcess.Id)" -ForegroundColor Green
      } else {
        Write-Host '[!] Health check did not pass. Leaving the current Web/Worker processes in place.' -ForegroundColor Yellow
      }
    }
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
