param(
  [string]$InstanceId = '',
  [string]$InstanceRoot = '',
  [Nullable[int]]$Port = $null,
  [switch]$WorkerOnly
)

$ErrorActionPreference = 'Stop'
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$NodeCommand = Get-Command node.exe -ErrorAction Stop
$InstanceConfigScript = Join-Path $PSScriptRoot 'print-instance-config.mjs'
$InstanceArguments = @($InstanceConfigScript)
if ($InstanceId) { $InstanceArguments += @('--instance-id', $InstanceId) }
if ($InstanceRoot) { $InstanceArguments += @('--instance-root', $InstanceRoot) }
if ($null -ne $Port) { $InstanceArguments += @('--port', [string]$Port) }
$InstanceConfig = (& $NodeCommand.Source $InstanceArguments | ConvertFrom-Json)
if (-not $InstanceConfig) { throw 'Instance configuration could not be resolved.' }
$Port = [int]$InstanceConfig.port
$RuntimeDirectory = [IO.Path]::GetFullPath([string]$InstanceConfig.runtimeDirectory)
$RestartRequestFile = Join-Path $RuntimeDirectory 'restart.request'
$WorkerRestartRequestFile = Join-Path $RuntimeDirectory 'restart.worker.request'
$StateFile = Join-Path $RuntimeDirectory 'processes.json'
$HealthUrl = "http://127.0.0.1:$Port/api/v1/health"

function Read-ProcessPid([string]$Name) {
  if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) { return 0 }
  try {
    $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    $record = $state.processes.PSObject.Properties[$Name].Value
    if (-not $record -or -not $record.pid) { return 0 }
    return [int]$record.pid
  } catch {
    return 0
  }
}

function Read-WebPid { return Read-ProcessPid 'web' }
function Read-WorkerPid { return Read-ProcessPid 'worker' }

function Test-Health {
  try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
    return [bool]$health.ok
  } catch {
    return $false
  }
}

New-Item -ItemType Directory -Path $RuntimeDirectory -Force | Out-Null
if ($WorkerOnly) {
  $beforeWeb = Read-WebPid
  $beforeWorker = Read-WorkerPid
  if ($beforeWeb -le 0 -or $beforeWorker -le 0 -or -not (Test-Health)) {
    throw 'Web is not healthy, so a worker-only restart was not requested. Run scripts/restart-ai-center.ps1 without -WorkerOnly.'
  }
  [System.IO.File]::WriteAllText($WorkerRestartRequestFile, [DateTimeOffset]::Now.ToString('o'), [System.Text.UTF8Encoding]::new($false))
  Write-Host "Wrote worker restart request for instance $($InstanceConfig.instanceId). Waiting for the launcher to restart Worker only..."
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $deadline) {
    $web = Read-WebPid
    $worker = Read-WorkerPid
    if ($web -gt 0 -and $web -ne $beforeWeb) {
      throw "Worker-only restart changed the Web PID from $beforeWeb to $web. Check the launcher window."
    }
    if ((Test-Health) -and $web -eq $beforeWeb -and $worker -gt 0 -and $worker -ne $beforeWorker) {
      Write-Host "Worker restarted. Web PID $web stayed up. Worker PID $worker"
      exit 0
    }
    Start-Sleep -Milliseconds 400
  }
  throw 'Launcher did not apply restart.worker.request within 60s. The current start-ai-center window needs one manual restart to pick up worker-only restarts; after that, this switch leaves Web running.'
}

$beforePid = Read-WebPid
[System.IO.File]::WriteAllText($RestartRequestFile, [DateTimeOffset]::Now.ToString('o'), [System.Text.UTF8Encoding]::new($false))
Write-Host "Wrote restart request for instance $($InstanceConfig.instanceId). Waiting for launcher to bounce Web/Worker..."

$deadline = [DateTime]::UtcNow.AddSeconds(60)
$sawDown = $false
while ([DateTime]::UtcNow -lt $deadline) {
  $healthy = Test-Health
  $afterPid = Read-WebPid
  if (-not $healthy) { $sawDown = $true }
  if ($healthy -and $afterPid -gt 0 -and $beforePid -gt 0 -and $afterPid -ne $beforePid) {
    Write-Host "Web/Worker restarted. New Web PID $afterPid"
    exit 0
  }
  if ($healthy -and $sawDown -and $afterPid -gt 0) {
    Write-Host "Web/Worker came back after restart. Web PID $afterPid"
    exit 0
  }
  Start-Sleep -Milliseconds 400
}

throw 'Launcher did not apply restart.request within 60s. The current start-ai-center window needs one manual restart to pick up the watcher; after that, work-package restarts stay automatic and the public tunnel stays up.'
