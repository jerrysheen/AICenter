# UTF-8 with BOM so Windows PowerShell 5.1 can parse the Chinese assertions below.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'deploy-logic.ps1')

function Assert-True($Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

Assert-True (-not (Test-AiCenterRestartRequired -Paths @('apps/web/public/app.js', 'apps/web/public/styles.css'))) 'public files should not restart'
Assert-True (Test-AiCenterRestartRequired -Paths @('apps/web/public/app.js', 'apps/web/src/server.js')) 'server file should restart'
Assert-True (Test-AiCenterRestartRequired -Paths 'apps/web/src/server.js') 'single server path should restart'
Assert-True (-not (Test-AiCenterRestartRequired -Paths @())) 'empty diff should not restart'
Assert-True (-not (Test-AiCenterRestartRequired -Paths 'apps/web/public/app.js')) 'single public file should not restart'
Assert-True (Test-AiCenterPackageLockChanged -Paths 'package-lock.json') 'lockfile change'
Assert-True (-not (Test-AiCenterPackageLockChanged -Paths 'apps/web/public/app.js')) 'public file is not lockfile'
Assert-True (Test-AiCenterEnvChange -Paths @('apps/web/public/app.js', '.env')) '.env change'
Assert-True (Test-AiCenterEnvChange -Paths 'instance/.env') 'nested .env'
Assert-True (-not (Test-AiCenterEnvChange -Paths '.env.example')) '.env.example stays deployable'
Assert-True ((Get-AiCenterDirtyDeployReason -Lines ' M package-lock.json') -eq (Get-AiCenterDeployReason 'lockfile')) 'dirty lockfile'
Assert-True ((Get-AiCenterDirtyDeployReason -Lines @('?? notes.txt')) -eq (Get-AiCenterDeployReason 'dirty')) 'dirty tree'
Assert-True ((Get-AiCenterDirtyDeployReason -Lines @()) -eq $null) 'clean tree'
Assert-True ((Get-AiCenterPorcelainPath 'R  apps/web/old.js -> apps/web/src/server.js') -eq 'apps/web/src/server.js') 'rename path'

$disabled = Get-AiCenterDeploySettings -Environment @{
  AI_CENTER_AUTO_DEPLOY = '0'
  AI_CENTER_DEPLOY_INTERVAL_SECONDS = '30'
  AI_CENTER_DEPLOY_REF = 'deploy-*'
  AI_CENTER_DEPLOY_BACKUP_KEEP = '3'
}
Assert-True (-not $disabled.Enabled) 'disabled'
Assert-True ($disabled.IntervalSeconds -eq 60) 'interval floor'
Assert-True ($disabled.Mode -eq 'tag-pattern') 'tag mode'
Assert-True ($disabled.BackupKeep -eq 3) 'backup keep'

$defaults = Get-AiCenterDeploySettings -Environment @{}
Assert-True $defaults.Enabled 'default enabled'
Assert-True ($defaults.IntervalSeconds -eq 90) 'default interval'
Assert-True ($defaults.Ref -eq 'origin/deploy') 'default ref'
Assert-True ($defaults.Mode -eq 'branch') 'branch mode'
Assert-True ($defaults.RemoteBranch -eq 'deploy') 'remote branch'
Assert-True ($defaults.BackupKeep -eq 7) 'default keep'
Assert-True ($defaults.LockMinutes -eq 30) 'default lock minutes'
$lockShort = Get-AiCenterDeploySettings -Environment @{ AI_CENTER_DEPLOY_LOCK_MINUTES = '1' }
Assert-True ($lockShort.LockMinutes -eq 5) 'lock minutes floor'
$lockLong = Get-AiCenterDeploySettings -Environment @{ AI_CENTER_DEPLOY_LOCK_MINUTES = '9999' }
Assert-True ($lockLong.LockMinutes -eq 240) 'lock minutes ceiling'

$nowTicks = ConvertTo-AiCenterLockUtcTicks '2026-10-12T00:00:00.000Z'
Assert-True ($nowTicks -gt 0) 'lock timestamp parses'
Assert-True ((ConvertTo-AiCenterLockUtcTicks 'not-a-time') -eq 0) 'bad lock timestamp'
$youngTicks = $nowTicks - (5L * 600000000L)
$oldTicks = $nowTicks - (45L * 600000000L)
Assert-True ((Get-AiCenterDeployLockDecision -LockPid 0 -CurrentPid 20 -HasLock $false -Readable $false -ProcessExists $false -ProcessName '' -LockUtcTicks 0 -NowUtcTicks $nowTicks -MaxAgeMinutes 30) -eq 'free') 'no lock is free'
Assert-True ((Get-AiCenterDeployLockDecision -LockPid 20 -CurrentPid 20 -HasLock $true -Readable $true -ProcessExists $true -ProcessName 'powershell' -LockUtcTicks $oldTicks -NowUtcTicks $nowTicks -MaxAgeMinutes 30) -eq 'own') 'own pid is reentrant'
Assert-True ((Get-AiCenterDeployLockDecision -LockPid 99 -CurrentPid 20 -HasLock $true -Readable $true -ProcessExists $false -ProcessName '' -LockUtcTicks $youngTicks -NowUtcTicks $nowTicks -MaxAgeMinutes 30) -eq 'stale-missing') 'dead pid is stale'
Assert-True ((Get-AiCenterDeployLockDecision -LockPid 99 -CurrentPid 20 -HasLock $true -Readable $true -ProcessExists $true -ProcessName 'node' -LockUtcTicks $youngTicks -NowUtcTicks $nowTicks -MaxAgeMinutes 30) -eq 'stale-process') 'non-powershell is stale'
Assert-True ((Get-AiCenterDeployLockDecision -LockPid 99 -CurrentPid 20 -HasLock $true -Readable $true -ProcessExists $true -ProcessName 'pwsh.exe' -LockUtcTicks $oldTicks -NowUtcTicks $nowTicks -MaxAgeMinutes 30) -eq 'stale-age') 'old powershell lock is stale'
Assert-True ((Get-AiCenterDeployLockDecision -LockPid 99 -CurrentPid 20 -HasLock $true -Readable $true -ProcessExists $true -ProcessName 'powershell' -LockUtcTicks $youngTicks -NowUtcTicks $nowTicks -MaxAgeMinutes 30) -eq 'busy') 'live powershell lock is busy'
Assert-True ((Get-AiCenterDeployLockDecision -LockPid 0 -CurrentPid 20 -HasLock $true -Readable $false -ProcessExists $false -ProcessName '' -LockUtcTicks $youngTicks -NowUtcTicks $nowTicks -MaxAgeMinutes 30) -eq 'busy') 'unreadable young lock is busy'
Assert-True ((Get-AiCenterDeployLockDecision -LockPid 0 -CurrentPid 20 -HasLock $true -Readable $true -ProcessExists $false -ProcessName '' -LockUtcTicks $youngTicks -NowUtcTicks $nowTicks -MaxAgeMinutes 30) -eq 'stale-missing') 'blank pid is stale'

$formatted = Format-AiCenterDeployErrorText -Message 'git failed' -PositionMessage "At scripts\deploy-run.ps1:19 char:5" -ScriptStackTrace 'at Invoke-AiCenterGit, deploy-run.ps1: line 19'
Assert-True ($formatted.Contains('git failed')) 'error message kept'
Assert-True ($formatted.Contains('deploy-run.ps1:19')) 'script line kept'
Assert-True ($formatted.Contains('Invoke-AiCenterGit')) 'stack kept'
$secretText = Format-AiCenterDeployErrorText -Message 'https://user:pass@example.com password=hunter2 Bearer abcdef' -PositionMessage '' -ScriptStackTrace ''
Assert-True ($secretText.Contains('https://redacted@example.com')) 'url userinfo redacted'
Assert-True ($secretText.Contains('password=<redacted>')) 'password redacted'
Assert-True ($secretText.Contains('Bearer <redacted>')) 'bearer redacted'
Assert-True (-not $secretText.Contains('hunter2')) 'password value removed'
Assert-True (-not $secretText.Contains('user:pass')) 'userinfo removed'

$high = Get-AiCenterDeploySettings -Environment @{ AI_CENTER_DEPLOY_INTERVAL_SECONDS = '500'; AI_CENTER_DEPLOY_BACKUP_KEEP = '99' }
Assert-True ($high.IntervalSeconds -eq 120) 'interval ceiling'
Assert-True ($high.BackupKeep -eq 50) 'keep ceiling'
Assert-True ((Get-AiCenterDeployFetchPlan '../.env').Mode -eq 'invalid') 'reject path ref'
Assert-True ((Get-AiCenterDeployFetchPlan 'deploy-2026-10-12').Mode -eq 'tag') 'exact tag'

$latest = Select-AiCenterLatestDeployTag -Tags @(
  @{ name = 'deploy-1'; createdAt = '10' },
  @{ name = 'deploy-2'; createdAt = '20' },
  @{ name = 'other'; createdAt = '30' }
) -Pattern 'deploy-*'
Assert-True ($latest -eq 'deploy-2') "latest tag $latest"
$singleRow = ConvertTo-AiCenterTagRow "deploy-9`t4"
Assert-True ($null -ne $singleRow -and $singleRow.name -eq 'deploy-9' -and $singleRow.createdAt -eq '4') 'single tag line stays a row'
Assert-True ($null -eq (ConvertTo-AiCenterTagRow 'deploy-9')) 'tag line without a timestamp'
$only = Select-AiCenterLatestDeployTag -Tags @{ name = 'deploy-9'; createdAt = '4' } -Pattern 'deploy-*'
Assert-True ($only -eq 'deploy-9') "single tag $only"
$tie = Select-AiCenterLatestDeployTag -Tags @(
  @{ name = 'deploy-a'; createdAt = '5' },
  @{ name = 'deploy-b'; createdAt = '5' }
) -Pattern 'deploy-*'
Assert-True ($tie -eq 'deploy-b') "tie break $tie"

Assert-True ((Get-AiCenterFastForwardDecision -Head 'aaa' -Target 'bbb' -AncestorExitCode 0) -eq 'fast-forward') 'fast-forward'
Assert-True ((Get-AiCenterFastForwardDecision -Head 'aaa' -Target 'bbb' -AncestorExitCode 1) -eq 'diverged') 'diverged'
Assert-True ((Get-AiCenterFastForwardDecision -Head 'aaa' -Target 'aaa' -AncestorExitCode 1) -eq 'same') 'same'
$sha = Select-AiCenterCommitLine -Lines @('warning: something', ('ab' * 20))
Assert-True ($sha -eq ('ab' * 20)) 'sha line'
Assert-True ((Select-AiCenterCommitLine -Lines ('cd' * 20)) -eq ('cd' * 20)) 'single sha line'

$records = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt 25; $i++) {
  $records.Add((New-AiCenterDeployRecord -Commit ('{0:x40}' -f $i) -PreviousCommit ('{0:x40}' -f ($i + 1)) -Ref 'origin/deploy' -StartedAt '2026-10-12T00:00:00.000Z' -FinishedAt '2026-10-12T00:01:00.000Z' -Ok $true -Restarted $false -RolledBack $false -Reason '静态文件' -NpmCi $false)) | Out-Null
}
$limited = Limit-AiCenterDeployHistory -Records $records.ToArray() -Keep 20
Assert-True ($limited.Length -eq 20) "history $($limited.Length)"
$single = New-Object System.Collections.Generic.List[object]
$single.Add($records[0]) | Out-Null
$one = Limit-AiCenterDeployHistory -Records $single.ToArray() -Keep 20
Assert-True ($one.Length -eq 1) 'single history item stays an array'
$json = ConvertTo-AiCenterDeployStatusJson -Current $records[0] -History $limited
Assert-True ($json.Contains('"npmCi":false')) 'json npmCi'
Assert-True ($json.Contains('"rolledBack":false')) 'json rolledBack'
Assert-True ($json.Contains('"ref":"origin/deploy"')) 'json ref'
Assert-True ($json.Contains('"reason":"静态文件"')) 'json reason'
Assert-True (-not $json.Contains('.env')) 'status json has no env'
Assert-True (-not $json.Contains([string][char]92)) 'status json has no backslash'
$hidden = New-AiCenterDeployRecord -Commit '' -PreviousCommit '' -Ref '' -StartedAt '' -FinishedAt '' -Ok $false -Restarted $false -RolledBack $false -Reason 'C:\secret\.env changed' -NpmCi $false
Assert-True ($hidden.reason -eq (Get-AiCenterDeployReason 'path')) "sanitized $($hidden.reason)"
$errorRecord = New-AiCenterDeployRecord -Commit '' -PreviousCommit '' -Ref '' -StartedAt '2026-10-12T00:02:00.000Z' -FinishedAt '2026-10-12T00:02:00.000Z' -Ok $false -Restarted $false -RolledBack $false -Reason '' -NpmCi $false -State 'error' -ErrorText "https://user:pass@example.com password=hunter2`nAt scripts\deploy-run.ps1:19" -At '2026-10-12T00:02:00.000Z'
Assert-True ($errorRecord.state -eq 'error') 'error state'
Assert-True ($errorRecord.error.Contains('deploy-run.ps1:19')) 'error keeps script path'
Assert-True ($errorRecord.error.Contains('https://redacted@example.com')) 'record redacts url'
Assert-True (-not $errorRecord.error.Contains('hunter2')) 'record redacts password'
Assert-True (-not (Test-AiCenterSameDeployResult -Previous $records[0] -Next $errorRecord)) 'error is a different result'
$again = New-AiCenterDeployRecord -Commit '' -PreviousCommit '' -Ref '' -StartedAt '2026-10-12T00:03:00.000Z' -FinishedAt '2026-10-12T00:03:00.000Z' -Ok $false -Restarted $false -RolledBack $false -Reason '' -NpmCi $false -State 'error' -ErrorText $errorRecord.error -At '2026-10-12T00:03:00.000Z'
Assert-True (Test-AiCenterSameDeployResult -Previous $errorRecord -Next $again) 'same error dedups'
$weird = New-AiCenterDeployRecord -Commit '' -PreviousCommit '' -Ref '' -StartedAt '' -FinishedAt '' -Ok $false -Restarted $false -RolledBack $false -Reason '' -NpmCi $false -State 'pwned'
Assert-True ($weird.state -eq '') 'unknown state dropped'
$errorJson = ConvertTo-AiCenterDeployRecordJson $errorRecord
Assert-True ($errorJson.Contains('"state":"error"')) 'json state'
Assert-True ($errorJson.Contains('deploy-run.ps1:19')) 'json script line'
$same = Test-AiCenterSameDeployResult -Previous $records[0] -Next $records[0]
Assert-True $same 'same result'
Assert-True (-not (Test-AiCenterSameDeployResult -Previous $records[0] -Next $records[1])) 'different result'

$paths = ConvertTo-AiCenterChangedPaths -Lines 'apps/web/public/app.js'
Assert-True ($paths.Length -eq 1 -and $paths[0] -eq 'apps/web/public/app.js') 'single changed path'

. (Join-Path $PSScriptRoot 'deploy-run.ps1')
$tempDir = Join-Path ([IO.Path]::GetTempPath()) ('ai-center-deploy-status-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
  $DataDirectory = $tempDir
  $DeployStatusFile = Join-Path $tempDir 'deploy-status.json'
  $sample = New-AiCenterDeployRecord -Commit ('a' * 40) -PreviousCommit ('b' * 40) -Ref 'origin/deploy' -StartedAt '2026-10-12T00:00:00.000Z' -FinishedAt '2026-10-12T00:01:00.000Z' -Ok $false -Restarted $true -RolledBack $true -Reason (Get-AiCenterDeployReason 'health') -NpmCi $true
  Write-AiCenterDeployStatusRecord $sample
  Write-AiCenterDeployStatusRecord $sample
  $loaded = Read-AiCenterDeployHistory
  Assert-True ($loaded.Length -eq 1) "deduped history $($loaded.Length)"
  Assert-True ($loaded[0].npmCi -eq $true) 'saved npmCi'
  Assert-True ($loaded[0].rolledBack -eq $true) 'saved rolledBack'
  $raw = Get-Content -LiteralPath $DeployStatusFile -Raw -Encoding UTF8
  Assert-True (-not $raw.Contains([string][char]92)) 'saved status has no backslash'
  Assert-True ($raw.Contains('"history":[{')) 'history is a json array'
  Write-AiCenterDeployErrorStatus -ErrorText "boom at scripts\deploy-run.ps1:19`npassword=hunter2"
  Write-AiCenterDeployErrorStatus -ErrorText "boom at scripts\deploy-run.ps1:19`npassword=hunter2"
  $errors = Read-AiCenterDeployHistory
  Assert-True ($errors.Length -eq 2) "error appended once $($errors.Length)"
  Assert-True ($errors[0].state -eq 'error') 'saved state'
  Assert-True ($errors[0].error.Contains('deploy-run.ps1:19')) 'saved script line'
  Assert-True (-not $errors[0].error.Contains('hunter2')) 'saved error redacts password'
  Assert-True ($errors[0].at.Length -gt 0) 'saved at'

  $RuntimeDirectory = Join-Path $tempDir 'runtime'
  $script:deploySettings = Get-AiCenterDeploySettings -Environment @{}
  $script:deployLockDepth = 0
  $script:deployLockStream = $null
  $lockPath = Join-Path $RuntimeDirectory 'deploy.lock'
  New-Item -ItemType Directory -Path $RuntimeDirectory -Force | Out-Null
  $oldStamp = [DateTime]::UtcNow.AddHours(-2).ToString('yyyy-MM-ddTHH:mm:ss.fff') + 'Z'
  [IO.File]::WriteAllText($lockPath, "2147483646`n$oldStamp`n")
  Assert-True (Enter-AiCenterDeployLock) 'take over dead pid'
  $held = [IO.File]::ReadAllText($lockPath)
  Assert-True ($held.StartsWith(([string]$PID) + "`n")) "lock replaced with current pid $held"
  Assert-True (Enter-AiCenterDeployLock) 'own pid reenters'
  Assert-True ($script:deployLockDepth -eq 2) "lock depth $($script:deployLockDepth)"
  Exit-AiCenterDeployLock
  Assert-True ($null -ne $script:deployLockStream) 'outer lock still held'
  Exit-AiCenterDeployLock
  Assert-True ($null -eq $script:deployLockStream) 'lock released in finally'
  Assert-True ($script:deployLockDepth -eq 0) 'lock depth cleared'
  Assert-True (Enter-AiCenterDeployLock) 'own leftover pid is not busy'
  Exit-AiCenterDeployLock
  $youngStamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fff') + 'Z'
  [IO.File]::WriteAllText($lockPath, "1`n$youngStamp`n")
  Assert-True (Enter-AiCenterDeployLock) 'missing or non-powershell pid is taken over'
  Exit-AiCenterDeployLock

  $gitCommand = Get-Command git -ErrorAction SilentlyContinue
  if ($gitCommand) {
    $RepositoryRoot = Join-Path $tempDir 'not-a-repo'
    New-Item -ItemType Directory -Path $RepositoryRoot -Force | Out-Null
    $missingRepo = Invoke-AiCenterGit status
    Assert-True ($missingRepo.Code -ne 0) "git status should fail in $($RepositoryRoot) code=$($missingRepo.Code)"
    Assert-True ($missingRepo.Stderr.Contains('not a git repository')) "stderr kept $($missingRepo.Stderr)"
    $stdoutLines = Get-AiCenterListItems $missingRepo.Lines
    Assert-True ($stdoutLines.Length -eq 0) 'stderr is not parsed as porcelain'
    $version = Invoke-AiCenterGit --version
    Assert-True ($version.Code -eq 0) "git version code $($version.Code)"
    $versionLines = Get-AiCenterListItems $version.Lines
    Assert-True ($versionLines.Length -ge 1 -and ([string]$versionLines[0]).StartsWith('git version')) 'stdout kept'
    Assert-True ($ErrorActionPreference -eq 'Stop') 'git helper does not change script error action'
  }
} finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$gitStderr = Invoke-AiCenterGit not-a-real-command
Assert-True ($gitStderr.Code -ne 0) "git stderr stays a result $($gitStderr.Code)"
$gitText = (@(Get-AiCenterListItems $gitStderr.Lines) + @([string]$gitStderr.Stderr)) -join "`n"
Assert-True ($gitText -match 'not-a-real-command') 'git stderr line kept'
Assert-True ($gitText -notmatch 'CategoryInfo') 'git stderr is not an error record dump'

Write-Output 'deploy-logic-ok'
