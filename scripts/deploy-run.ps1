# Auto-deploy steps for scripts/start-ai-center.ps1.
# Dot-sourced after deploy-logic.ps1. Does not parse .env; backups are file copies only.

function Get-AiCenterTimestamp {
  return ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fff') + 'Z')
}

function Invoke-AiCenterGit {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
  $previousPrompt = $env:GIT_TERMINAL_PROMPT
  $previousGcm = $env:GCM_INTERACTIVE
  $hadNative = Test-Path variable:PSNativeCommandUseErrorActionPreference
  $previousNative = $null
  if ($hadNative) { $previousNative = $PSNativeCommandUseErrorActionPreference }
  $previousErrorAction = $ErrorActionPreference
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'Never'
  $PSNativeCommandUseErrorActionPreference = $false
  # Windows PowerShell 5.1 turns native stderr into a terminating error when
  # ErrorActionPreference is Stop. git fetch writes progress there on success.
  $ErrorActionPreference = 'Continue'
  try {
    $output = & git -C $RepositoryRoot @GitArgs 2>&1
    $code = $LASTEXITCODE
    $lines = New-Object System.Collections.Generic.List[string]
    if ($null -ne $output) {
      foreach ($item in @($output)) {
        if ($null -eq $item) { continue }
        $text = if ($item -is [System.Management.Automation.ErrorRecord]) { [string]$item.Exception.Message } else { [string]$item }
        if ($text.Length -gt 0) { $lines.Add($text) | Out-Null }
      }
    }
    return [pscustomobject]@{ Code = [int]$code; Lines = $lines.ToArray() }
  } finally {
    $ErrorActionPreference = $previousErrorAction
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
    $tagLines = $listed.Lines
    if ($tagLines -is [System.Array]) {
      for ($i = 0; $i -lt $tagLines.Length; $i++) {
        $text = [string]$tagLines[$i]
        $parts = $text -split "`t", 2
        if ($parts.Count -lt 2) { continue }
        $tags.Add(@{ name = $parts[0].Trim(); createdAt = $parts[1].Trim() }) | Out-Null
      }
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

function Enter-AiCenterDeployLock {
  New-Item -ItemType Directory -Path $RuntimeDirectory -Force | Out-Null
  $path = Join-Path $RuntimeDirectory 'deploy.lock'
  try {
    $stream = [System.IO.File]::Open(
      $path,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None)
    $bytes = [Text.Encoding]::ASCII.GetBytes([string]$PID)
    $stream.SetLength(0)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    $script:deployLockStream = $stream
    return $true
  } catch {
    return $false
  }
}

function Exit-AiCenterDeployLock {
  if ($script:deployLockStream) {
    $script:deployLockStream.Dispose()
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
        $items.Add((New-AiCenterDeployRecord -Commit ([string]$item.commit) -PreviousCommit ([string]$item.previousCommit) -Ref ([string]$item.ref) -StartedAt ([string]$item.startedAt) -FinishedAt ([string]$item.finishedAt) -Ok ([bool]$item.ok) -Restarted ([bool]$item.restarted) -RolledBack ([bool]$item.rolledBack) -Reason ([string]$item.reason) -NpmCi ([bool]$item.npmCi))) | Out-Null
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
    Write-Host '[!] Auto-deploy: could not write deploy status.' -ForegroundColor Yellow
  }
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
  & $npmCommand.Source 'ci'
  return ($LASTEXITCODE -eq 0)
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
    Write-Host 'Auto-deploy: skipped because another deploy holds the lock.' -ForegroundColor DarkGray
    return
  }
  $script:deployInProgress = $true
  $startedAt = Get-AiCenterTimestamp
  try {
    $plan = $script:deploySettings
    if ($plan.Mode -eq 'invalid') {
      Write-AiCenterDeployOutcome -Commit '' -PreviousCommit '' -Ref '' -StartedAt $startedAt -Ok $false -Restarted $false -RolledBack $false -Reason (Get-AiCenterDeployReason 'ref-invalid') -NpmCi $false
      return
    }
    $fetched = Update-AiCenterDeployRef $plan
    if ($fetched.Code -ne 0) {
      Write-Host 'Auto-deploy: git fetch failed.' -ForegroundColor Yellow
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
