# Auto-deploy steps for scripts/start-ai-center.ps1.
# Dot-sourced after deploy-logic.ps1. Does not parse .env; backups are file copies only.

function Get-AiCenterTimestamp {
  return ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fff') + 'Z')
}

function Add-AiCenterCapturedLines($Lines, $Output) {
  $rows = Get-AiCenterListItems $Output
  for ($i = 0; $i -lt $rows.Length; $i++) {
    $item = $rows[$i]
    if ($null -eq $item) { continue }
    $text = ''
    if ($item -is [System.Management.Automation.ErrorRecord]) {
      if ($null -ne $item.Exception) { $text = [string]$item.Exception.Message }
    } else {
      $text = [string]$item
    }
    $text = $text.TrimEnd("`r")
    if ($text.Length -gt 0) { [void]$Lines.Add($text) }
  }
}

function Format-AiCenterGitStderr([string]$Text) {
  $clean = Remove-AiCenterDeploySecretText $Text
  if (-not $clean) { return '' }
  $flat = ([regex]::Replace($clean, '\s+', ' ')).Trim()
  if ($flat.Length -gt 500) { return $flat.Substring(0, 500) }
  return $flat
}

function Invoke-AiCenterGit {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
  # Windows PowerShell 5.1 turns native stderr into ErrorRecords when stderr
  # is merged into the success stream. The daemon sets ErrorActionPreference
  # to Stop, so the first fetch progress line becomes a terminating error
  # before LASTEXITCODE is read. Send stderr to a file instead. Do not use
  # Start-Process: Windows PowerShell 5.1 mis-quotes ArgumentList.
  $lines = New-Object System.Collections.Generic.List[string]
  if ($null -eq $GitArgs -or $GitArgs.Length -eq 0) {
    return [pscustomobject]@{ Code = 1; Lines = $lines.ToArray(); Stderr = 'git arguments were empty' }
  }
  $previousPrompt = $env:GIT_TERMINAL_PROMPT
  $previousGcm = $env:GCM_INTERACTIVE
  $hadNative = Test-Path variable:PSNativeCommandUseErrorActionPreference
  $previousNative = $null
  if ($hadNative) { $previousNative = $PSNativeCommandUseErrorActionPreference }
  $previousErrorAction = $ErrorActionPreference
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'Never'
  if ($hadNative) { $PSNativeCommandUseErrorActionPreference = $false }
  $ErrorActionPreference = 'Continue'
  $stderrPath = Join-Path ([IO.Path]::GetTempPath()) ('ai-center-git-' + [guid]::NewGuid().ToString('n') + '.err')
  $code = 1
  try {
    $output = & git -C $RepositoryRoot @GitArgs 2> $stderrPath
    if ($null -ne $LASTEXITCODE) { $code = [int]$LASTEXITCODE }
    Add-AiCenterCapturedLines $lines $output
    $stderrText = ''
    if ($code -ne 0 -and (Test-Path -LiteralPath $stderrPath -PathType Leaf)) {
      try { $stderrText = [IO.File]::ReadAllText($stderrPath) } catch { $stderrText = '' }
    }
    return [pscustomobject]@{ Code = $code; Lines = $lines.ToArray(); Stderr = (Format-AiCenterGitStderr $stderrText) }
  } finally {
    $ErrorActionPreference = $previousErrorAction
    if (Test-Path -LiteralPath $stderrPath) {
      Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
    if ($null -eq $previousPrompt) { Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue }
    else { $env:GIT_TERMINAL_PROMPT = $previousPrompt }
    if ($null -eq $previousGcm) { Remove-Item Env:GCM_INTERACTIVE -ErrorAction SilentlyContinue }
    else { $env:GCM_INTERACTIVE = $previousGcm }
    if ($hadNative) { $PSNativeCommandUseErrorActionPreference = $previousNative }
  }
}

function Update-AiCenterDeployRef($Plan) {
  if ($Plan.Mode -eq 'tag-pattern') {
    $spec = '+refs/tags/{0}:refs/tags/{0}' -f $Plan.Pattern
    return Invoke-AiCenterGit fetch --prune origin $spec
  }
  if ($Plan.Mode -eq 'branch') {
    return Invoke-AiCenterGit fetch --prune origin $Plan.RemoteBranch
  }
  if ($Plan.Mode -eq 'tag') {
    $spec = 'refs/tags/{0}:refs/tags/{0}' -f $Plan.LocalRef
    return Invoke-AiCenterGit fetch origin $spec
  }
  return Invoke-AiCenterGit fetch --prune origin
}

function Resolve-AiCenterDeployTarget($Plan) {
  if ($Plan.Mode -eq 'tag-pattern') {
    $listed = Invoke-AiCenterGit for-each-ref --sort=-creatordate --format='%(refname:short)%09%(creatordate:unix)' 'refs/tags'
    if ($listed.Code -ne 0) { return '' }
    $tags = New-Object System.Collections.Generic.List[object]
    $tagLines = Get-AiCenterListItems $listed.Lines
    for ($i = 0; $i -lt $tagLines.Length; $i++) {
      $row = ConvertTo-AiCenterTagRow $tagLines[$i]
      if ($null -eq $row) { continue }
      $tags.Add(@{ name = [string]$row.name; createdAt = [string]$row.createdAt }) | Out-Null
    }
    $tagArray = $tags.ToArray()
    $name = Select-AiCenterLatestDeployTag -Tags $tagArray -Pattern $Plan.Pattern
    if (-not $name) { return '' }
    $parsed = Invoke-AiCenterGit rev-parse --verify ($name + '^{commit}')
    if ($parsed.Code -ne 0) { return '' }
    return (Select-AiCenterCommitLine -Lines $parsed.Lines)
  }
  $parsed = Invoke-AiCenterGit rev-parse --verify ($Plan.LocalRef + '^{commit}')
  if ($parsed.Code -ne 0) { return '' }
  return (Select-AiCenterCommitLine -Lines $parsed.Lines)
}

function Get-AiCenterHeadCommit {
  $parsed = Invoke-AiCenterGit rev-parse --verify 'HEAD^{commit}'
  if ($parsed.Code -ne 0) { return '' }
  return (Select-AiCenterCommitLine -Lines $parsed.Lines)
}

$script:deployLockStream = $null
$script:deployLockDepth = 0
$script:deployLockSkipReason = ''

function Get-AiCenterDeployLockShare {
  return ([IO.FileShare]::Read -bor [IO.FileShare]::Delete)
}

function Get-AiCenterLockProcessSnapshot([int]$ProcessId) {
  $info = [pscustomobject]@{ Exists = $false; Name = '' }
  if ($ProcessId -le 0) { return $info }
  $proc = $null
  try { $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue } catch { $proc = $null }
  if ($null -eq $proc) { return $info }
  $info.Exists = $true
  $info.Name = [string]$proc.ProcessName
  return $info
}

function Read-AiCenterDeployLockState([string]$Path) {
  $state = [pscustomobject]@{ Exists = $false; Pid = 0; Ticks = 0L; Readable = $false }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $state }
  $state.Exists = $true
  $ticks = 0L
  try { $ticks = ([IO.File]::GetLastWriteTimeUtc($Path)).Ticks } catch { $ticks = 0L }
  $stream = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, (Get-AiCenterDeployLockShare))
    $buffer = New-Object byte[] 256
    $count = $stream.Read($buffer, 0, $buffer.Length)
    if ($count -lt 0) { $count = 0 }
    $text = [Text.Encoding]::ASCII.GetString($buffer, 0, $count)
    $parts = @($text -split '\r?\n', 3)
    $first = ''
    $second = ''
    if ($parts.Length -ge 1) { $first = [string]$parts[0] }
    if ($parts.Length -ge 2) { $second = [string]$parts[1] }
    $parsedPid = 0
    [void][int]::TryParse($first.Trim(), [ref]$parsedPid)
    $state.Pid = $parsedPid
    $state.Readable = $true
    $parsedTicks = ConvertTo-AiCenterLockUtcTicks $second
    if ($parsedTicks -gt 0) { $ticks = $parsedTicks }
  } catch {
    $state.Pid = 0
    $state.Readable = $false
  } finally {
    if ($null -ne $stream) {
      try { $stream.Dispose() } catch {}
    }
  }
  $state.Ticks = $ticks
  return $state
}

function Write-AiCenterDeployLockContent($Stream) {
  $stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fff') + 'Z'
  $payload = [string]$PID + "`n" + $stamp + "`n"
  $bytes = [Text.Encoding]::ASCII.GetBytes($payload)
  $Stream.SetLength(0)
  $Stream.Position = 0
  $Stream.Write($bytes, 0, $bytes.Length)
  $Stream.Flush()
}

function Open-AiCenterDeployLockHandle([string]$Path, [string]$Decision) {
  $share = Get-AiCenterDeployLockShare
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    $stream = $null
    try {
      if ($attempt -eq 2) {
        if ($null -ne $script:deployLockStream) {
          try { $script:deployLockStream.Dispose() } catch {}
          $script:deployLockStream = $null
        }
        [GC]::Collect()
        [GC]::WaitForPendingFinalizers()
        if ($Decision -ne 'own' -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
          Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        }
      }
      $stream = [IO.File]::Open($Path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, $share)
      Write-AiCenterDeployLockContent $stream
      $script:deployLockStream = $stream
      return $true
    } catch {
      if ($null -ne $stream) {
        try { $stream.Dispose() } catch {}
      }
      $script:deployLockStream = $null
    }
  }
  return $false
}

function Enter-AiCenterDeployLock {
  if (-not (Test-Path variable:script:deployLockDepth)) { $script:deployLockDepth = 0 }
  if (-not (Test-Path variable:script:deployLockStream)) { $script:deployLockStream = $null }
  $script:deployLockSkipReason = ''
  if ($script:deployLockDepth -gt 0 -and $null -ne $script:deployLockStream) {
    $script:deployLockDepth = $script:deployLockDepth + 1
    return $true
  }
  New-Item -ItemType Directory -Path $RuntimeDirectory -Force | Out-Null
  $path = Join-Path $RuntimeDirectory 'deploy.lock'
  $maxAge = 30
  if ($null -ne $script:deploySettings -and $script:deploySettings.LockMinutes) {
    $maxAge = [int]$script:deploySettings.LockMinutes
  }
  $state = Read-AiCenterDeployLockState $path
  $proc = Get-AiCenterLockProcessSnapshot -ProcessId $state.Pid
  $decision = Get-AiCenterDeployLockDecision -LockPid $state.Pid -CurrentPid ([int]$PID) -HasLock ([bool]$state.Exists) -Readable ([bool]$state.Readable) -ProcessExists ([bool]$proc.Exists) -ProcessName ([string]$proc.Name) -LockUtcTicks ([long]$state.Ticks) -NowUtcTicks ([DateTime]::UtcNow.Ticks) -MaxAgeMinutes $maxAge
  if ($decision -eq 'busy') {
    $script:deployLockSkipReason = 'busy pid ' + [string]$state.Pid
    return $false
  }
  if (Open-AiCenterDeployLockHandle -Path $path -Decision $decision) {
    $script:deployLockDepth = 1
    return $true
  }
  $script:deployLockSkipReason = $decision + ' pid ' + [string]$state.Pid
  return $false
}

function Exit-AiCenterDeployLock {
  if (-not (Test-Path variable:script:deployLockDepth)) { $script:deployLockDepth = 0 }
  if ($script:deployLockDepth -gt 1) {
    $script:deployLockDepth = $script:deployLockDepth - 1
    return
  }
  $script:deployLockDepth = 0
  if ($null -ne $script:deployLockStream) {
    try { $script:deployLockStream.Dispose() } catch {}
    $script:deployLockStream = $null
  }
}

function Save-AiCenterEnvSnapshots([string]$Directory) {
  $script:deployEnvSnapshots = New-Object System.Collections.Generic.List[object]
  $seen = New-Object System.Collections.Generic.List[string]
  foreach ($envPath in @($RepositoryEnvPath, $InstanceEnvPath)) {
    if (-not $envPath) { continue }
    if ($seen.Contains([string]$envPath)) { continue }
    $seen.Add([string]$envPath) | Out-Null
    $exists = Test-Path -LiteralPath $envPath -PathType Leaf
    $hash = ''
    $copy = $null
    if ($exists) {
      $hash = (Get-FileHash -LiteralPath $envPath -Algorithm SHA256).Hash
      $leaf = 'repository.env'
      if ($envPath -eq $InstanceEnvPath -and $envPath -ne $RepositoryEnvPath) { $leaf = 'instance.env' }
      $copy = Join-Path $Directory $leaf
      [System.IO.File]::Copy($envPath, $copy, $true)
    }
    $script:deployEnvSnapshots.Add([pscustomobject]@{
      Path = $envPath
      Existed = [bool]$exists
      Hash = $hash
      Copy = $copy
    }) | Out-Null
  }
}

function Restore-AiCenterEnvSnapshots {
  $rows = $script:deployEnvSnapshots
  if ($null -eq $rows) { return }
  for ($index = 0; $index -lt $rows.Count; $index++) {
    $item = $rows[$index]
    if ($null -eq $item) { continue }
    $existsNow = Test-Path -LiteralPath $item.Path -PathType Leaf
    if (-not $item.Existed) {
      if ($existsNow) { Remove-Item -LiteralPath $item.Path -Force -ErrorAction SilentlyContinue }
      continue
    }
    $hashNow = ''
    if ($existsNow) { $hashNow = (Get-FileHash -LiteralPath $item.Path -Algorithm SHA256).Hash }
    if ($hashNow -ne $item.Hash -and $item.Copy -and (Test-Path -LiteralPath $item.Copy -PathType Leaf)) {
      [System.IO.File]::Copy($item.Copy, $item.Path, $true)
    }
  }
}

function Backup-AiCenterDeployFiles([string]$Directory) {
  foreach ($suffix in @('', '-wal', '-shm')) {
    $source = $DatabasePath + $suffix
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      $destination = Join-Path $Directory (Split-Path -Leaf $source)
      [System.IO.File]::Copy($source, $destination, $true)
    }
  }
  Save-AiCenterEnvSnapshots -Directory $Directory
}

function Remove-OldAiCenterDeployBackups {
  if (-not (Test-Path -LiteralPath $DeployBackupRoot -PathType Container)) { return }
  $dirs = @(Get-ChildItem -LiteralPath $DeployBackupRoot -Directory |
    Where-Object { $_.Name -match '^\d{8}T\d{6,}Z$' } |
    Sort-Object Name -Descending)
  $keep = [int]$script:deploySettings.BackupKeep
  if ($dirs.Count -le $keep) { return }
  $dirs | Select-Object -Skip $keep | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function New-AiCenterDeployBackupDirectory {
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + 'Z'
  $directory = Join-Path $DeployBackupRoot $stamp
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  return $directory
}

function Read-AiCenterDeployHistory {
  $items = New-Object System.Collections.Generic.List[object]
  if (Test-Path -LiteralPath $DeployStatusFile -PathType Leaf) {
    try {
      $parsed = Get-Content -LiteralPath $DeployStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $rows = Get-AiCenterListItems $parsed.history
      for ($i = 0; $i -lt $rows.Length; $i++) {
        $item = $rows[$i]
        if ($null -eq $item) { continue }
        $items.Add((New-AiCenterDeployRecord -Commit ([string]$item.commit) -PreviousCommit ([string]$item.previousCommit) -Ref ([string]$item.ref) -StartedAt ([string]$item.startedAt) -FinishedAt ([string]$item.finishedAt) -Ok ([bool]$item.ok) -Restarted ([bool]$item.restarted) -RolledBack ([bool]$item.rolledBack) -Reason ([string]$item.reason) -NpmCi ([bool]$item.npmCi) -State ([string]$item.state) -ErrorText ([string]$item.error) -At ([string]$item.at))) | Out-Null
      }
    } catch {
      $items.Clear()
    }
  }
  return ,$items.ToArray()
}

function Write-AiCenterDeployStatusRecord($Record) {
  try {
    $history = Read-AiCenterDeployHistory
    $previous = $null
    if ($history.Length -gt 0) { $previous = $history[0] }
    if (Test-AiCenterSameDeployResult -Previous $previous -Next $Record) {
      Write-Host 'Auto-deploy: same result already recorded.' -ForegroundColor DarkGray
      return
    }
    $combined = New-Object System.Collections.Generic.List[object]
    $combined.Add($Record) | Out-Null
    for ($i = 0; $i -lt $history.Length; $i++) { $combined.Add($history[$i]) | Out-Null }
    $limited = Limit-AiCenterDeployHistory -Records $combined.ToArray() -Keep 20
    $json = ConvertTo-AiCenterDeployStatusJson -Current $Record -History $limited
    New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
    $temp = $DeployStatusFile + '.tmp'
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($temp, $json, $utf8)
    [System.IO.File]::Copy($temp, $DeployStatusFile, $true)
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  } catch {
    Write-Host "[!] Auto-deploy: could not write deploy status. $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

function Write-AiCenterDeployErrorStatus {
  param([string]$ErrorText)
  $at = Get-AiCenterTimestamp
  $record = New-AiCenterDeployRecord -Commit '' -PreviousCommit '' -Ref '' -StartedAt $at -FinishedAt $at -Ok $false -Restarted $false -RolledBack $false -Reason '' -NpmCi $false -State 'error' -ErrorText $ErrorText -At $at
  Write-AiCenterDeployStatusRecord $record
}

function Write-AiCenterDeployOutcome {
  param(
    [string]$Commit,
    [string]$PreviousCommit,
    [string]$Ref,
    [string]$StartedAt,
    [bool]$Ok,
    [bool]$Restarted,
    [bool]$RolledBack,
    [string]$Reason,
    [bool]$NpmCi
  )
  $record = New-AiCenterDeployRecord -Commit $Commit -PreviousCommit $PreviousCommit -Ref $Ref -StartedAt $StartedAt -FinishedAt (Get-AiCenterTimestamp) -Ok $Ok -Restarted $Restarted -RolledBack $RolledBack -Reason $Reason -NpmCi $NpmCi
  Write-AiCenterDeployStatusRecord $record
}

function Invoke-AiCenterNpmCi {
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
  if (-not $npmCommand) {
    Write-Host '[!] Auto-deploy: npm was not found.' -ForegroundColor Yellow
    return $false
  }
  Write-Host 'Auto-deploy: running npm ci.' -ForegroundColor Cyan
  $hadNative = Test-Path variable:PSNativeCommandUseErrorActionPreference
  $previousNative = $null
  if ($hadNative) { $previousNative = $PSNativeCommandUseErrorActionPreference }
  $previousErrorAction = $ErrorActionPreference
  if ($hadNative) { $PSNativeCommandUseErrorActionPreference = $false }
  $ErrorActionPreference = 'Continue'
  $code = 1
  try {
    & $npmCommand.Source 'ci'
    if ($null -ne $LASTEXITCODE) { $code = [int]$LASTEXITCODE }
  } finally {
    $ErrorActionPreference = $previousErrorAction
    if ($hadNative) { $PSNativeCommandUseErrorActionPreference = $previousNative }
  }
  return ($code -eq 0)
}

function Restart-AiCenterForDeploy {
  Update-AiCenterProcessLogs
  Stop-StartedAiCenterProcesses
  Start-Sleep -Milliseconds 500
  $started = Start-AiCenterWebAndWorker
  $script:webProcess = $started.web
  $script:workerProcess = $started.worker
  Write-InstanceProcessState
}

function Undo-AiCenterDeployCommit {
  param(
    [string]$PreviousCommit,
    [bool]$RunNpmCi
  )
  if (-not (Test-AiCenterCommitSha $PreviousCommit)) { return $false }
  $target = $PreviousCommit.ToLowerInvariant()
  Write-Host "Auto-deploy: rolling back to $target" -ForegroundColor Yellow
  $reset = Invoke-AiCenterGit reset --hard $target
  Restore-AiCenterEnvSnapshots
  $head = Get-AiCenterHeadCommit
  if ($reset.Code -ne 0 -or $head -ne $target) { return $false }
  if ($RunNpmCi -and -not (Invoke-AiCenterNpmCi)) { return $false }
  return $true
}

function Complete-AiCenterDeployRollback {
  param(
    [string]$PreviousCommit,
    [bool]$RunNpmCi,
    [bool]$NpmCi,
    [string]$HealthyReason,
    [string]$UnhealthyReason,
    [string]$Commit,
    [string]$Ref,
    [string]$StartedAt
  )
  $rolled = Undo-AiCenterDeployCommit -PreviousCommit $PreviousCommit -RunNpmCi $RunNpmCi
  $healthy = $false
  try {
    Restart-AiCenterForDeploy
    [void](Wait-AiCenterWebHealth -Web $script:webProcess -Worker $script:workerProcess)
    $healthy = $true
  } catch {
    Write-Host '[!] Auto-deploy: rollback health check failed.' -ForegroundColor Yellow
  }
  $reason = if ($rolled -and $healthy) { $HealthyReason } else { $UnhealthyReason }
  Write-AiCenterDeployOutcome -Commit $Commit -PreviousCommit $PreviousCommit -Ref $Ref -StartedAt $StartedAt -Ok $false -Restarted $true -RolledBack ([bool]$rolled) -Reason $reason -NpmCi $NpmCi
}

function Invoke-AiCenterAutoDeploy {
  if (-not $script:deploySettings -or -not $script:deploySettings.Enabled) { return }
  if ($script:deployInProgress) { return }
  if (-not (Enter-AiCenterDeployLock)) {
    $held = [string]$script:deployLockSkipReason
    if ($held) {
      Write-Host "Auto-deploy: skipped because another deploy holds the lock ($held)." -ForegroundColor DarkGray
    } else {
      Write-Host 'Auto-deploy: skipped because another deploy holds the lock.' -ForegroundColor DarkGray
    }
    return
  }
  try {
    $script:deployInProgress = $true
    $startedAt = Get-AiCenterTimestamp
    $plan = $script:deploySettings
    if ($plan.Mode -eq 'invalid') {
      Write-AiCenterDeployOutcome -Commit '' -PreviousCommit '' -Ref '' -StartedAt $startedAt -Ok $false -Restarted $false -RolledBack $false -Reason (Get-AiCenterDeployReason 'ref-invalid') -NpmCi $false
      return
    }
    $fetched = Update-AiCenterDeployRef $plan
    if ($null -eq $fetched -or $fetched.Code -ne 0) {
      $fetchCode = 1
      $fetchErr = ''
      if ($null -ne $fetched) {
        $fetchCode = [int]$fetched.Code
        $fetchErr = [string]$fetched.Stderr
      }
      Write-Host "Auto-deploy: git fetch failed ($fetchCode). $fetchErr" -ForegroundColor Yellow
      Write-AiCenterDeployErrorStatus -ErrorText ("git fetch failed ($fetchCode). $fetchErr")
      return
    }
    $target = Resolve-AiCenterDeployTarget $plan
    $head = Get-AiCenterHeadCommit
    if (-not (Test-AiCenterCommitSha $target) -or -not (Test-AiCenterCommitSha $head)) {
      if (-not $script:deployMissingRefLogged) {
        Write-Host "Auto-deploy: $($plan.Ref) is not available yet." -ForegroundColor DarkGray
        $script:deployMissingRefLogged = $true
      }
      return
    }
    $script:deployMissingRefLogged = $false
    if ($target -eq $head) {
      if ($script:lastDeployedSha -ne $target) {
        Write-Host "Auto-deploy: $($plan.Ref) matches HEAD." -ForegroundColor DarkGray
        $script:lastDeployedSha = $target
      }
      return
    }

    $status = Invoke-AiCenterGit status --porcelain
    if ($status.Code -ne 0) {
      Write-AiCenterDeployOutcome -Commit $target -PreviousCommit $head -Ref $plan.Ref -StartedAt $startedAt -Ok $false -Restarted $false -RolledBack $false -Reason (Get-AiCenterDeployReason 'dirty-unknown') -NpmCi $false
      return
    }
    $dirty = Get-AiCenterDirtyDeployReason -Lines $status.Lines
    if ($dirty) {
      Write-Host "Auto-deploy: $dirty" -ForegroundColor Yellow
      Write-AiCenterDeployOutcome -Commit $target -PreviousCommit $head -Ref $plan.Ref -StartedAt $startedAt -Ok $false -Restarted $false -RolledBack $false -Reason $dirty -NpmCi $false
      return
    }

    $diff = Invoke-AiCenterGit diff --name-only $head $target
    if ($diff.Code -ne 0) {
      Write-AiCenterDeployOutcome -Commit $target -PreviousCommit $head -Ref $plan.Ref -StartedAt $startedAt -Ok $false -Restarted $false -RolledBack $false -Reason (Get-AiCenterDeployReason 'diverged') -NpmCi $false
      return
    }
    $paths = ConvertTo-AiCenterChangedPaths -Lines $diff.Lines
    if (Test-AiCenterEnvChange -Paths $paths) {
      Write-Host 'Auto-deploy: refused because the ref changes .env.' -ForegroundColor Yellow
      Write-AiCenterDeployOutcome -Commit $target -PreviousCommit $head -Ref $plan.Ref -StartedAt $startedAt -Ok $false -Restarted $false -RolledBack $false -Reason (Get-AiCenterDeployReason 'env') -NpmCi $false
      return
    }
    $ancestor = Invoke-AiCenterGit merge-base --is-ancestor $head $target
    $decision = Get-AiCenterFastForwardDecision -Head $head -Target $target -AncestorExitCode $ancestor.Code
    if ($decision -ne 'fast-forward') {
      Write-Host 'Auto-deploy: refused because the ref is not a fast-forward.' -ForegroundColor Yellow
      Write-AiCenterDeployOutcome -Commit $target -PreviousCommit $head -Ref $plan.Ref -StartedAt $startedAt -Ok $false -Restarted $false -RolledBack $false -Reason (Get-AiCenterDeployReason 'diverged') -NpmCi $false
      return
    }

    try {
      $backupDir = New-AiCenterDeployBackupDirectory
      Backup-AiCenterDeployFiles $backupDir
      Remove-OldAiCenterDeployBackups
    } catch {
      Write-Host '[!] Auto-deploy: backup failed.' -ForegroundColor Yellow
      Write-AiCenterDeployOutcome -Commit $target -PreviousCommit $head -Ref $plan.Ref -StartedAt $startedAt -Ok $false -Restarted $false -RolledBack $false -Reason (Get-AiCenterDeployReason 'backup') -NpmCi $false
      return
    }

    $merged = Invoke-AiCenterGit merge --ff-only $target
    Restore-AiCenterEnvSnapshots
    $newHead = Get-AiCenterHeadCommit
    if ($merged.Code -ne 0 -or $newHead -ne $target) {
      Write-Host 'Auto-deploy: fast-forward did not complete.' -ForegroundColor Yellow
      $rolled = $false
      if ($newHead -and $newHead -ne $head) {
        $rolled = Undo-AiCenterDeployCommit -PreviousCommit $head -RunNpmCi $false
      }
      Write-AiCenterDeployOutcome -Commit $target -PreviousCommit $head -Ref $plan.Ref -StartedAt $startedAt -Ok $false -Restarted $false -RolledBack ([bool]$rolled) -Reason (Get-AiCenterDeployReason 'diverged') -NpmCi $false
      return
    }

    $lockChanged = Test-AiCenterPackageLockChanged -Paths $paths
    $restart = (Test-AiCenterRestartRequired -Paths $paths) -or $lockChanged
    $npmCi = $false
    if ($lockChanged) {
      Stop-StartedAiCenterProcesses
      Start-Sleep -Milliseconds 500
      $npmCi = $true
      if (-not (Invoke-AiCenterNpmCi)) {
        Complete-AiCenterDeployRollback -PreviousCommit $head -RunNpmCi $true -NpmCi $true -HealthyReason (Get-AiCenterDeployReason 'npm-ci') -UnhealthyReason (Get-AiCenterDeployReason 'npm-ci-rollback-health') -Commit $target -Ref $plan.Ref -StartedAt $startedAt
        return
      }
    }

    if ($restart) {
      try {
        Restart-AiCenterForDeploy
        [void](Wait-AiCenterWebHealth -Web $script:webProcess -Worker $script:workerProcess)
      } catch {
        Write-Host "[!] Auto-deploy health check failed: $($_.Exception.Message)" -ForegroundColor Yellow
        Complete-AiCenterDeployRollback -PreviousCommit $head -RunNpmCi $lockChanged -NpmCi $npmCi -HealthyReason (Get-AiCenterDeployReason 'health') -UnhealthyReason (Get-AiCenterDeployReason 'rollback-health') -Commit $target -Ref $plan.Ref -StartedAt $startedAt
        return
      }
    } else {
      try {
        [void](Wait-AiCenterWebHealth -Web $script:webProcess -Worker $script:workerProcess)
      } catch {
        Write-Host "[!] Auto-deploy health check failed: $($_.Exception.Message)" -ForegroundColor Yellow
        Complete-AiCenterDeployRollback -PreviousCommit $head -RunNpmCi $false -NpmCi $false -HealthyReason (Get-AiCenterDeployReason 'health') -UnhealthyReason (Get-AiCenterDeployReason 'rollback-health') -Commit $target -Ref $plan.Ref -StartedAt $startedAt
        return
      }
    }

    if ($restart) {
      Write-Host "Auto-deploy: updated to $target and restarted Web and Worker." -ForegroundColor Green
    } else {
      Write-Host "Auto-deploy: updated to $target. Static files only, Web and Worker stayed up." -ForegroundColor Green
    }
    Write-AiCenterDeployOutcome -Commit $target -PreviousCommit $head -Ref $plan.Ref -StartedAt $startedAt -Ok $true -Restarted ([bool]$restart) -RolledBack $false -Reason '' -NpmCi $npmCi
    $script:lastDeployedSha = $target
  } finally {
    $script:deployInProgress = $false
    Exit-AiCenterDeployLock
  }
}
