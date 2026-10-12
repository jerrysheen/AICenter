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
} finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output 'deploy-logic-ok'
