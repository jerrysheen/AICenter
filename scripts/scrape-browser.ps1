# Scrape Chrome is the BrowserSkill extension host, not a CDP target.
# Default user-data dir is the dedicated profile this product used to own:
# <repo>\.ai-data\chrome-profile. Override with AI_CENTER_SCRAPE_CHROME_USER_DATA.
# Connection stays the extension bridge (bsk daemon). Do not pass a debug port.

function Get-AiCenterScrapeBrowserEnvValue {
  param(
    [hashtable]$Environment,
    [string]$Name
  )
  if ($Environment.ContainsKey($Name) -and $null -ne $Environment[$Name]) {
    return [string]$Environment[$Name]
  }
  return ''
}

function Resolve-AiCenterScrapeChromeExe {
  param(
    [hashtable]$Environment,
    [scriptblock]$TestFile = { param($Path) Test-Path -LiteralPath $Path -PathType Leaf }
  )
  $configured = (Get-AiCenterScrapeBrowserEnvValue -Environment $Environment -Name 'AI_CENTER_SCRAPE_CHROME').Trim()
  if ($configured) { return $configured }
  $candidates = @()
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if ($root) { $candidates += ($root.TrimEnd('\', '/') + '\Google\Chrome\Application\chrome.exe') }
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (& $TestFile $candidate)) { return $candidate }
  }
  return $null
}

function Get-AiCenterScrapeBrowserConfig {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [hashtable]$Environment = @{},
    [scriptblock]$TestFile = { param($Path) Test-Path -LiteralPath $Path -PathType Leaf }
  )
  $userData = (Get-AiCenterScrapeBrowserEnvValue -Environment $Environment -Name 'AI_CENTER_SCRAPE_CHROME_USER_DATA').Trim()
  if (-not $userData) {
    $userData = $RepositoryRoot.TrimEnd('\', '/') + '\.ai-data\chrome-profile'
  }
  $profileDirectory = (Get-AiCenterScrapeBrowserEnvValue -Environment $Environment -Name 'AI_CENTER_SCRAPE_CHROME_PROFILE_DIRECTORY').Trim()
  $missLimit = 3
  $missRaw = (Get-AiCenterScrapeBrowserEnvValue -Environment $Environment -Name 'AI_CENTER_SCRAPE_BROWSER_MISS_LIMIT').Trim()
  if ($missRaw) {
    $parsedMiss = 0
    if (-not [int]::TryParse($missRaw, [ref]$parsedMiss) -or $parsedMiss -lt 1) {
      throw 'AI_CENTER_SCRAPE_BROWSER_MISS_LIMIT must be an integer >= 1'
    }
    $missLimit = $parsedMiss
  }
  $checkSeconds = 60
  $checkRaw = (Get-AiCenterScrapeBrowserEnvValue -Environment $Environment -Name 'AI_CENTER_SCRAPE_BROWSER_CHECK_SECONDS').Trim()
  if ($checkRaw) {
    $parsedCheck = 0
    if (-not [int]::TryParse($checkRaw, [ref]$parsedCheck) -or $parsedCheck -lt 5) {
      throw 'AI_CENTER_SCRAPE_BROWSER_CHECK_SECONDS must be an integer >= 5'
    }
    $checkSeconds = $parsedCheck
  }
  $exe = Resolve-AiCenterScrapeChromeExe -Environment $Environment -TestFile $TestFile
  $arguments = @(
    "--user-data-dir=$userData",
    '--no-first-run',
    '--no-default-browser-check'
  )
  if ($profileDirectory) {
    $arguments += "--profile-directory=$profileDirectory"
  }
  $arguments += 'about:blank'
  return [pscustomobject]@{
    Executable = $exe
    UserDataDir = $userData
    ProfileDirectory = $profileDirectory
    Arguments = $arguments
    MissLimit = $missLimit
    CheckSeconds = $checkSeconds
  }
}

function Test-AiCenterScrapeBrowserCommandLine {
  param(
    [string]$CommandLine,
    [string]$UserDataDir
  )
  if (-not $CommandLine -or -not $UserDataDir) { return $false }
  $normalized = $CommandLine.Replace('/', '\').ToLowerInvariant()
  $dir = $UserDataDir.Replace('/', '\').TrimEnd('\').ToLowerInvariant()
  $index = $normalized.IndexOf($dir)
  if ($index -lt 0) { return $false }
  $after = $index + $dir.Length
  if ($after -ge $normalized.Length) { return $true }
  $next = $normalized[$after]
  return $next -eq '"' -or $next -eq "'" -or $next -eq '\' -or [char]::IsWhiteSpace($next)
}

function Test-AiCenterScrapeBrowserConnected($Status) {
  if (-not $Status -or -not $Status.browsers) { return $false }
  return @($Status.browsers).Count -gt 0
}

function Get-AiCenterScrapeBrowserAction {
  param(
    $Status,
    [bool]$ProfileProcessRunning,
    [int]$MissStreak,
    [int]$MissLimit = 3,
    [bool]$Startup
  )
  if (Test-AiCenterScrapeBrowserConnected $Status) {
    return [pscustomobject]@{ Action = 'none'; Reason = 'connected'; MissStreak = 0 }
  }
  $next = $MissStreak + 1
  if ($ProfileProcessRunning) {
    return [pscustomobject]@{ Action = 'none'; Reason = 'process'; MissStreak = $next }
  }
  if ($Startup -or $next -ge $MissLimit) {
    $reason = if ($Startup) { 'startup' } else { 'guardian' }
    return [pscustomobject]@{ Action = 'launch'; Reason = $reason; MissStreak = 0 }
  }
  return [pscustomobject]@{ Action = 'wait'; Reason = 'disconnected'; MissStreak = $next }
}

function Get-AiCenterScrapeBrowserEnvNames {
  return @(
    'AI_CENTER_SCRAPE_CHROME',
    'AI_CENTER_SCRAPE_CHROME_USER_DATA',
    'AI_CENTER_SCRAPE_CHROME_PROFILE_DIRECTORY',
    'AI_CENTER_SCRAPE_BROWSER_MISS_LIMIT',
    'AI_CENTER_SCRAPE_BROWSER_CHECK_SECONDS'
  )
}

function Read-AiCenterScrapeBrowserDotEnv {
  param([string]$Path)
  $found = @{}
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $found }
  $wanted = @{}
  foreach ($name in (Get-AiCenterScrapeBrowserEnvNames)) { $wanted[$name] = $true }
  foreach ($line in @(Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
    if ($line -match '^\s*#') { continue }
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }
    $name = $Matches[1]
    if (-not $wanted.ContainsKey($name)) { continue }
    $raw = $Matches[2].Trim()
    if ($raw.Length -ge 2) {
      $quote = $raw[0]
      if (($quote -eq '"' -or $quote -eq "'") -and $raw[$raw.Length - 1] -eq $quote) {
        $raw = $raw.Substring(1, $raw.Length - 2)
      }
    }
    $found[$name] = $raw
  }
  return $found
}

function Merge-AiCenterScrapeBrowserEnvironment {
  param(
    [hashtable]$ProcessEnvironment = @{},
    [hashtable]$InstanceEnvironment = @{},
    [hashtable]$RepositoryEnvironment = @{}
  )
  $merged = @{}
  foreach ($name in (Get-AiCenterScrapeBrowserEnvNames)) {
    foreach ($source in @($RepositoryEnvironment, $InstanceEnvironment, $ProcessEnvironment)) {
      if ($source -and $source.ContainsKey($name) -and "$($source[$name])".Trim()) {
        $merged[$name] = "$($source[$name])".Trim()
      }
    }
  }
  return $merged
}

function Get-AiCenterScrapeBrowserEnvironmentFromFiles {
  param(
    [string]$RepositoryEnvPath,
    [string]$InstanceEnvPath
  )
  $process = @{}
  foreach ($name in (Get-AiCenterScrapeBrowserEnvNames)) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($value) { $process[$name] = $value }
  }
  return Merge-AiCenterScrapeBrowserEnvironment `
    -ProcessEnvironment $process `
    -InstanceEnvironment (Read-AiCenterScrapeBrowserDotEnv $InstanceEnvPath) `
    -RepositoryEnvironment (Read-AiCenterScrapeBrowserDotEnv $RepositoryEnvPath)
}

function Test-AiCenterScrapeBrowserProfileRunning {
  param(
    [string]$UserDataDir,
    [string]$Executable,
    [scriptblock]$ListCommandLines
  )
  if (-not $ListCommandLines) {
    $ListCommandLines = {
      param([string]$ProcessName)
      $safe = $ProcessName.Replace("'", "''")
      @(Get-CimInstance Win32_Process -Filter "Name = '$safe'" -ErrorAction SilentlyContinue |
          ForEach-Object { [string]$_.CommandLine })
    }
  }
  $names = @('chrome.exe')
  if ($Executable) {
    $leaf = [IO.Path]::GetFileName($Executable)
    if ($leaf -and ($names -notcontains $leaf)) { $names += $leaf }
  }
  foreach ($name in $names) {
    foreach ($command in @(& $ListCommandLines $name)) {
      if (Test-AiCenterScrapeBrowserCommandLine -CommandLine ([string]$command) -UserDataDir $UserDataDir) {
        return $true
      }
    }
  }
  return $false
}

function Format-AiCenterScrapeBrowserLaunchLine {
  param(
    [string]$Reason,
    [string]$UserDataDir,
    [string]$ProfileDirectory,
    [int]$Misses
  )
  $profile = ''
  if ($ProfileDirectory) { $profile = " profile=$ProfileDirectory" }
  if ($Reason -eq 'startup') {
    return "[browser] extension not connected; launched Chrome user-data-dir=$UserDataDir$profile"
  }
  return "[browser] no extension for $Misses checks; launched Chrome user-data-dir=$UserDataDir$profile"
}

function Invoke-AiCenterScrapeBrowserGuard {
  param(
    $Status,
    [bool]$ProfileProcessRunning,
    [int]$MissStreak,
    $Config,
    [bool]$Startup = $false,
    [scriptblock]$Launch
  )
  $decision = Get-AiCenterScrapeBrowserAction -Status $Status -ProfileProcessRunning $ProfileProcessRunning -MissStreak $MissStreak -MissLimit $Config.MissLimit -Startup:$Startup
  if ($decision.Action -ne 'launch') {
    return [pscustomobject]@{ Decision = $decision; Launched = $false; MissingExecutable = $false; Line = $null }
  }
  if (-not $Config.Executable) {
    return [pscustomobject]@{ Decision = $decision; Launched = $false; MissingExecutable = $true; Line = $null }
  }
  if ($Launch) {
    & $Launch $Config
  } else {
    Start-Process -FilePath $Config.Executable -ArgumentList $Config.Arguments | Out-Null
  }
  $misses = if ($Startup) { 1 } else { $MissStreak + 1 }
  $line = Format-AiCenterScrapeBrowserLaunchLine -Reason $decision.Reason -UserDataDir $Config.UserDataDir -ProfileDirectory $Config.ProfileDirectory -Misses $misses
  return [pscustomobject]@{ Decision = $decision; Launched = $true; MissingExecutable = $false; Line = $line }
}
