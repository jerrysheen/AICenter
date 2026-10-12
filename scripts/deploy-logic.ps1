# Pure deploy decisions for the Windows daemon. No git, process, or .env reads.
# UTF-8 with BOM: Windows PowerShell 5.1 otherwise reads this file as GBK and breaks the quotes.

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

function Get-AiCenterDeployLockMinutes([string]$Value) {
  $minutes = 30
  $text = ([string]$Value).Trim()
  if ($text -match '^\d+$') { $minutes = [int]$text }
  if ($minutes -lt 5) { return 5 }
  if ($minutes -gt 240) { return 240 }
  return $minutes
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
    LockMinutes = (Get-AiCenterDeployLockMinutes (& $read 'AI_CENTER_DEPLOY_LOCK_MINUTES'))
  }
}

function ConvertTo-AiCenterLockUtcTicks([string]$Text) {
  $value = ([string]$Text).Trim()
  if (-not $value) { return 0L }
  $parsed = [datetime]::MinValue
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  $ok = [datetime]::TryParse($value, [cultureinfo]::InvariantCulture, $styles, [ref]$parsed)
  if (-not $ok) { return 0L }
  return [long]$parsed.ToUniversalTime().Ticks
}

function Get-AiCenterDeployLockDecision {
  param(
    [int]$LockPid,
    [int]$CurrentPid,
    [bool]$HasLock,
    [bool]$Readable,
    [bool]$ProcessExists,
    [string]$ProcessName,
    [long]$LockUtcTicks,
    [long]$NowUtcTicks,
    [int]$MaxAgeMinutes
  )
  if (-not $HasLock) { return 'free' }
  if ($Readable -and $LockPid -le 0) { return 'stale-missing' }
  if ($LockPid -gt 0 -and $LockPid -eq $CurrentPid) { return 'own' }
  if ($LockPid -gt 0 -and -not $ProcessExists) { return 'stale-missing' }
  if ($LockPid -gt 0) {
    $name = ([string]$ProcessName).Trim().ToLowerInvariant()
    if ($name.EndsWith('.exe')) { $name = $name.Substring(0, $name.Length - 4) }
    if ($name -ne 'powershell' -and $name -ne 'pwsh') { return 'stale-process' }
  }
  $limitMinutes = $MaxAgeMinutes
  if ($limitMinutes -lt 1) { $limitMinutes = 30 }
  if ($LockUtcTicks -gt 0 -and $NowUtcTicks -gt $LockUtcTicks) {
    $limit = [long]$limitMinutes * 600000000L
    if (($NowUtcTicks - $LockUtcTicks) -gt $limit) { return 'stale-age' }
  }
  return 'busy'
}

function Remove-AiCenterDeploySecretText([string]$Value) {
  $text = [string]$Value
  if (-not $text) { return '' }
  $text = [regex]::Replace($text, '(?i)(https?://)[^\s/@]+:[^\s/@]+@', '$1redacted@')
  $text = [regex]::Replace($text, '(?i)\b(password|api[_-]?key|secret|token)\s*[=:]\s*\S+', '$1=<redacted>')
  $text = [regex]::Replace($text, '(?i)\bBearer\s+\S+', 'Bearer <redacted>')
  return $text
}

function Format-AiCenterDeployErrorText {
  param(
    [string]$Message,
    [string]$PositionMessage,
    [string]$ScriptStackTrace
  )
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($piece in @($Message, $PositionMessage, $ScriptStackTrace)) {
    $clean = (Remove-AiCenterDeploySecretText ([string]$piece)).Trim()
    if ($clean.Length -gt 1500) { $clean = $clean.Substring(0, 1500) }
    if ($clean.Length -gt 0) { $parts.Add($clean) | Out-Null }
  }
  if ($parts.Count -eq 0) { return 'Auto-deploy failed.' }
  $text = ''
  for ($i = 0; $i -lt $parts.Count; $i++) {
    if ($i -gt 0) { $text += "`n" }
    $text += [string]$parts[$i]
  }
  return $text
}

function ConvertTo-AiCenterTagRow([string]$Line) {
  $parts = @(([string]$Line) -split "`t", 2)
  if ($parts.Length -lt 2) { return $null }
  $name = ([string]$parts[0]).Trim()
  $createdAt = ([string]$parts[1]).Trim()
  if (-not $name -or -not $createdAt) { return $null }
  return [pscustomobject]@{ name = $name; createdAt = $createdAt }
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
    [bool]$NpmCi,
    [string]$State = '',
    [string]$ErrorText = '',
    [string]$At = ''
  )
  $safeReason = [string]$Reason
  if ($safeReason -match '[\r\n]' -or $safeReason -match '[\\/]' -or $safeReason -match '://' -or $safeReason.Length -gt 200) {
    $safeReason = Get-AiCenterDeployReason 'path'
  }
  $safeState = ''
  if ($State -eq 'error') { $safeState = 'error' }
  $safeError = Remove-AiCenterDeploySecretText $ErrorText
  if ($safeError.Length -gt 4500) { $safeError = $safeError.Substring(0, 4500) }
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
    state = $safeState
    error = $safeError
    at = [string]$At
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
    ('"npmCi":' + (ConvertTo-AiCenterJsonBool ([bool]$Record.npmCi))),
    ('"state":' + (ConvertTo-AiCenterJsonString ([string]$Record.state))),
    ('"error":' + (ConvertTo-AiCenterJsonString ([string]$Record.error))),
    ('"at":' + (ConvertTo-AiCenterJsonString ([string]$Record.at)))
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
    [bool]$Previous.npmCi -eq [bool]$Next.npmCi -and
    [string]$Previous.state -eq [string]$Next.state -and
    [string]$Previous.error -eq [string]$Next.error
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
