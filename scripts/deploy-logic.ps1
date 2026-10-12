# Pure deploy decisions for the Windows daemon. No git, process, or .env reads.

function Get-AiCenterDeployReason([string]$Name) {
  switch ($Name) {
    'dirty' { return '工作区不干净，已放弃本次部署' }
    'lockfile' { return 'package-lock.json 被改写，已放弃本次部署且未还原' }
    'dirty-unknown' { return '无法确认工作区是否干净，已放弃本次部署' }
    'diverged' { return '不能快进，已放弃本次部署' }
    'env' { return '引用包含 .env，已放弃本次部署' }
    'backup' { return '备份数据库或 .env 失败，已放弃本次部署' }
    'npm-ci' { return 'npm ci 失败，已回滚到上一个提交' }
    'npm-ci-rollback-health' { return 'npm ci 失败，回滚后健康检查失败' }
    'health' { return '健康检查失败，已回滚到上一个提交' }
    'rollback-health' { return '回滚后健康检查失败' }
    'ref-invalid' { return '部署引用无效，已放弃本次部署' }
    'path' { return '已省略包含路径的原因' }
    default { return '部署失败' }
  }
}

function ConvertTo-AiCenterRepoPath([string]$Path) {
  $normalized = ([string]$Path).Replace('\', '/').Trim()
  if ($normalized.StartsWith('"') -and $normalized.EndsWith('"') -and $normalized.Length -ge 2) {
    $normalized = $normalized.Substring(1, $normalized.Length - 2).Replace('\', '/')
  }
  while ($normalized.StartsWith('./')) { $normalized = $normalized.Substring(2) }
  return $normalized.Trim()
}

function Get-AiCenterPorcelainPath([string]$Line) {
  $text = ([string]$Line).TrimEnd()
  if ($text.Length -lt 4) { return '' }
  $rest = $text.Substring(3).Trim()
  $marker = ' -> '
  $markerAt = $rest.LastIndexOf($marker)
  if ($markerAt -ge 0) { $rest = $rest.Substring($markerAt + $marker.Length).Trim() }
  return ConvertTo-AiCenterRepoPath $rest
}

function Get-AiCenterListItems($Value) {
  $items = New-Object System.Collections.Generic.List[object]
  if ($null -eq $Value) { return ,$items.ToArray() }
  if ($Value -is [System.Array]) {
    for ($i = 0; $i -lt $Value.Length; $i++) { $items.Add($Value[$i]) | Out-Null }
  } else {
    $items.Add($Value) | Out-Null
  }
  return ,$items.ToArray()
}

function Get-AiCenterDirtyDeployReason {
  param($Lines)
  $rows = Get-AiCenterListItems $Lines
  $sawPath = $false
  for ($i = 0; $i -lt $rows.Length; $i++) {
    if (-not ([string]$rows[$i]).Trim()) { continue }
    $sawPath = $true
    if ((Get-AiCenterPorcelainPath $rows[$i]) -eq 'package-lock.json') {
      return (Get-AiCenterDeployReason 'lockfile')
    }
  }
  if (-not $sawPath) { return $null }
  return (Get-AiCenterDeployReason 'dirty')
}

function Test-AiCenterStaticWebPath([string]$Path) {
  $normalized = ConvertTo-AiCenterRepoPath $Path
  return $normalized -match '^apps/web/public/.+'
}

function Test-AiCenterRestartRequired {
  param($Paths)
  $rows = Get-AiCenterListItems $Paths
  for ($i = 0; $i -lt $rows.Length; $i++) {
    if (-not ([string]$rows[$i]).Trim()) { continue }
    if (-not (Test-AiCenterStaticWebPath $rows[$i])) { return $true }
  }
  return $false
}

function Test-AiCenterPackageLockChanged {
  param($Paths)
  $rows = Get-AiCenterListItems $Paths
  for ($i = 0; $i -lt $rows.Length; $i++) {
    if ((ConvertTo-AiCenterRepoPath $rows[$i]) -eq 'package-lock.json') { return $true }
  }
  return $false
}

function Test-AiCenterEnvPath([string]$Path) {
  $normalized = ConvertTo-AiCenterRepoPath $Path
  if (-not $normalized) { return $false }
  $name = ($normalized -split '/')[-1]
  return $name -eq '.env'
}

function Test-AiCenterEnvChange {
  param($Paths)
  $rows = Get-AiCenterListItems $Paths
  for ($i = 0; $i -lt $rows.Length; $i++) {
    if (Test-AiCenterEnvPath $rows[$i]) { return $true }
  }
  return $false
}

function ConvertTo-AiCenterChangedPaths {
  param($Lines)
  $rows = Get-AiCenterListItems $Lines
  $paths = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $rows.Length; $i++) {
    $path = ConvertTo-AiCenterRepoPath $rows[$i]
    if ($path) { $paths.Add($path) | Out-Null }
  }
  return ,$paths.ToArray()
}

function Get-AiCenterDeployFetchPlan([string]$Ref) {
  $value = ([string]$Ref).Trim()
  if (-not $value) { $value = 'origin/deploy' }
  if ($value -notmatch '^[A-Za-z0-9._/*-]+$' -or $value -match '\.\.' -or $value -match '//') {
    return [pscustomobject]@{ Mode = 'invalid'; Pattern = ''; RemoteBranch = ''; LocalRef = ''; DisplayRef = '' }
  }
  if ($value.Contains('*')) {
    return [pscustomobject]@{ Mode = 'tag-pattern'; Pattern = $value; RemoteBranch = ''; LocalRef = ''; DisplayRef = $value }
  }
  if ($value -match '^origin/([A-Za-z0-9._/-]+)$') {
    return [pscustomobject]@{ Mode = 'branch'; Pattern = ''; RemoteBranch = $Matches[1]; LocalRef = $value; DisplayRef = $value }
  }
  if ($value -match '^deploy-[A-Za-z0-9._-]+$') {
    return [pscustomobject]@{ Mode = 'tag'; Pattern = ''; RemoteBranch = ''; LocalRef = $value; DisplayRef = $value }
  }
  return [pscustomobject]@{ Mode = 'rev'; Pattern = ''; RemoteBranch = ''; LocalRef = $value; DisplayRef = $value }
}

function Get-AiCenterDeployIntervalSeconds([string]$Value) {
  $seconds = 90
  $text = ([string]$Value).Trim()
  if ($text -match '^\d+$') { $seconds = [int]$text }
  if ($seconds -lt 60) { return 60 }
  if ($seconds -gt 120) { return 120 }
  return $seconds
}

function Get-AiCenterDeployBackupKeep([string]$Value) {
  $keep = 7
  $text = ([string]$Value).Trim()
  if ($text -match '^\d+$') { $keep = [int]$text }
  if ($keep -lt 1) { return 1 }
  if ($keep -gt 50) { return 50 }
  return $keep
}

function Get-AiCenterDeploySettings {
  param($Environment)
  $read = {
    param($Name)
    if ($null -eq $Environment) { return '' }
    $value = $Environment[$Name]
    if ($null -eq $value) { return '' }
    return [string]$value
  }
  $flag = (& $read 'AI_CENTER_AUTO_DEPLOY').Trim().ToLowerInvariant()
  $enabled = $flag -notin @('0', 'false', 'off', 'no')
  $plan = Get-AiCenterDeployFetchPlan (& $read 'AI_CENTER_DEPLOY_REF')
  return [pscustomobject]@{
    Enabled = [bool]$enabled
    IntervalSeconds = (Get-AiCenterDeployIntervalSeconds (& $read 'AI_CENTER_DEPLOY_INTERVAL_SECONDS'))
    Ref = [string]$plan.DisplayRef
    Mode = [string]$plan.Mode
    Pattern = [string]$plan.Pattern
    RemoteBranch = [string]$plan.RemoteBranch
    LocalRef = [string]$plan.LocalRef
    BackupKeep = (Get-AiCenterDeployBackupKeep (& $read 'AI_CENTER_DEPLOY_BACKUP_KEEP'))
  }
}

function Select-AiCenterLatestDeployTag {
  param(
    $Tags,
    [string]$Pattern = 'deploy-*'
  )
  $regex = '^' + ([regex]::Escape([string]$Pattern).Replace('\*', '.*')) + '$'
  $matched = New-Object System.Collections.Generic.List[object]
  $rows = Get-AiCenterListItems $Tags
  for ($i = 0; $i -lt $rows.Length; $i++) {
    $tag = $rows[$i]
    if ($null -eq $tag) { continue }
    $name = [string]$tag.name
    if ($name -notmatch $regex) { continue }
    $created = 0L
    [void][long]::TryParse([string]$tag.createdAt, [ref]$created)
    $matched.Add([pscustomobject]@{ name = $name; createdAt = $created }) | Out-Null
  }
  if ($matched.Count -eq 0) { return $null }
  $selected = @($matched.ToArray() | Sort-Object -Property @{ Expression = 'createdAt'; Descending = $true }, @{ Expression = 'name'; Descending = $true })[0]
  return [string]$selected.name
}

function Get-AiCenterFastForwardDecision {
  param(
    [string]$Head,
    [string]$Target,
    [int]$AncestorExitCode
  )
  if (-not $Head -or -not $Target) { return 'missing' }
  if ($Head -eq $Target) { return 'same' }
  if ($AncestorExitCode -eq 0) { return 'fast-forward' }
  if ($AncestorExitCode -eq 1) { return 'diverged' }
  return 'error'
}

function Test-AiCenterCommitSha([string]$Value) {
  return ([string]$Value) -match '^[0-9a-fA-F]{7,64}$'
}

function Select-AiCenterCommitLine {
  param($Lines)
  $rows = Get-AiCenterListItems $Lines
  for ($i = 0; $i -lt $rows.Length; $i++) {
    $text = ([string]$rows[$i]).Trim().ToLowerInvariant()
    if ($text -match '^[0-9a-f]{40}$') { return $text }
  }
  return ''
}

function ConvertTo-AiCenterJsonString([string]$Value) {
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  foreach ($char in ([string]$Value).ToCharArray()) {
    $code = [int]$char
    if ($char -eq '"') { [void]$builder.Append('\"') }
    elseif ($char -eq '\') { [void]$builder.Append('\\') }
    elseif ($char -eq "`n") { [void]$builder.Append('\n') }
    elseif ($char -eq "`r") { [void]$builder.Append('\r') }
    elseif ($char -eq "`t") { [void]$builder.Append('\t') }
    elseif ($code -lt 32) { [void]$builder.Append(('\u{0:x4}' -f $code)) }
    else { [void]$builder.Append($char) }
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function ConvertTo-AiCenterJsonBool([bool]$Value) {
  if ($Value) { return 'true' }
  return 'false'
}

function New-AiCenterDeployRecord {
  param(
    [string]$Commit,
    [string]$PreviousCommit,
    [string]$Ref,
    [string]$StartedAt,
    [string]$FinishedAt,
    [bool]$Ok,
    [bool]$Restarted,
    [bool]$RolledBack,
    [string]$Reason,
    [bool]$NpmCi
  )
  $safeReason = [string]$Reason
  if ($safeReason -match '[\r\n]' -or $safeReason -match '[\\/]' -or $safeReason -match '://' -or $safeReason.Length -gt 200) {
    $safeReason = Get-AiCenterDeployReason 'path'
  }
  $record = [ordered]@{
    commit = [string]$Commit
    previousCommit = [string]$PreviousCommit
    ref = [string]$Ref
    startedAt = [string]$StartedAt
    finishedAt = [string]$FinishedAt
    ok = [bool]$Ok
    restarted = [bool]$Restarted
    rolledBack = [bool]$RolledBack
    reason = $safeReason
    npmCi = [bool]$NpmCi
  }
  return ,$record
}

function ConvertTo-AiCenterDeployRecordJson($Record) {
  $parts = @(
    ('"commit":' + (ConvertTo-AiCenterJsonString ([string]$Record.commit))),
    ('"previousCommit":' + (ConvertTo-AiCenterJsonString ([string]$Record.previousCommit))),
    ('"ref":' + (ConvertTo-AiCenterJsonString ([string]$Record.ref))),
    ('"startedAt":' + (ConvertTo-AiCenterJsonString ([string]$Record.startedAt))),
    ('"finishedAt":' + (ConvertTo-AiCenterJsonString ([string]$Record.finishedAt))),
    ('"ok":' + (ConvertTo-AiCenterJsonBool ([bool]$Record.ok))),
    ('"restarted":' + (ConvertTo-AiCenterJsonBool ([bool]$Record.restarted))),
    ('"rolledBack":' + (ConvertTo-AiCenterJsonBool ([bool]$Record.rolledBack))),
    ('"reason":' + (ConvertTo-AiCenterJsonString ([string]$Record.reason))),
    ('"npmCi":' + (ConvertTo-AiCenterJsonBool ([bool]$Record.npmCi)))
  )
  return '{' + ($parts -join ',') + '}'
}

function ConvertTo-AiCenterDeployStatusJson {
  param(
    $Current,
    $History
  )
  $items = @()
  $count = 0
  if ($null -ne $History -and $History -is [System.Array]) { $count = $History.Length }
  for ($i = 0; $i -lt $count; $i++) {
    $item = $History[$i]
    if ($null -eq $item) { continue }
    $items += (ConvertTo-AiCenterDeployRecordJson $item)
  }
  $historyJson = '[' + ($items -join ',') + ']'
  $currentJson = 'null'
  if ($null -ne $Current) { $currentJson = ConvertTo-AiCenterDeployRecordJson $Current }
  return '{"current":' + $currentJson + ',"history":' + $historyJson + '}'
}

function Test-AiCenterSameDeployResult($Previous, $Next) {
  if ($null -eq $Previous -or $null -eq $Next) { return $false }
  return [string]$Previous.commit -eq [string]$Next.commit -and
    [string]$Previous.previousCommit -eq [string]$Next.previousCommit -and
    [bool]$Previous.ok -eq [bool]$Next.ok -and
    [string]$Previous.reason -eq [string]$Next.reason -and
    [bool]$Previous.rolledBack -eq [bool]$Next.rolledBack -and
    [bool]$Previous.npmCi -eq [bool]$Next.npmCi
}

function Limit-AiCenterDeployHistory {
  param(
    $Records,
    [int]$Keep = 20
  )
  if ($Keep -lt 1) { $Keep = 1 }
  $items = New-Object System.Collections.Generic.List[object]
  if ($null -ne $Records -and $Records -is [System.Array]) {
    $count = [Math]::Min($Keep, $Records.Length)
    for ($i = 0; $i -lt $count; $i++) {
      if ($null -ne $Records[$i]) { $items.Add($Records[$i]) | Out-Null }
    }
  }
  return ,$items.ToArray()
}
