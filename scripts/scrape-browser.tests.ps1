$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scrape-browser.ps1')

function Assert-Equal($Actual, $Expected, [string]$Label) {
  if ($Actual -ne $Expected) {
    throw "$Label expected [$Expected] but got [$Actual]"
  }
}

$root = 'C:\ai-center'
$envMap = @{
  AI_CENTER_SCRAPE_CHROME = 'C:\Chrome\chrome.exe'
  AI_CENTER_SCRAPE_BROWSER_MISS_LIMIT = '3'
  AI_CENTER_SCRAPE_BROWSER_CHECK_SECONDS = '60'
}
$config = Get-AiCenterScrapeBrowserConfig -RepositoryRoot $root -Environment $envMap -TestFile { $true }
$expectedDir = 'C:\ai-center\.ai-data\chrome-profile'
Assert-Equal $config.Executable 'C:\Chrome\chrome.exe' 'exe'
Assert-Equal $config.UserDataDir $expectedDir 'default profile'
Assert-Equal $config.MissLimit 3 'miss limit'
Assert-Equal ($config.Arguments -join ' ') "--user-data-dir=$expectedDir --no-first-run --no-default-browser-check about:blank" 'args'
if ($config.Arguments -match 'remote-debugging') { throw 'must not open a CDP port' }

$override = Get-AiCenterScrapeBrowserConfig -RepositoryRoot $root -Environment @{
  AI_CENTER_SCRAPE_CHROME_USER_DATA = 'D:\profiles\scrape'
  AI_CENTER_SCRAPE_CHROME_PROFILE_DIRECTORY = 'Default'
} -TestFile { $false }
Assert-Equal $override.UserDataDir 'D:\profiles\scrape' 'override profile'
Assert-Equal ($override.Arguments -join ' ') '--user-data-dir=D:\profiles\scrape --no-first-run --no-default-browser-check --profile-directory=Default about:blank' 'profile directory alongside user-data-dir'

$normalChrome = 'C:\Users\ada\AppData\Local\Google\Chrome\User Data'
$profile2 = Get-AiCenterScrapeBrowserConfig -RepositoryRoot $root -Environment @{
  AI_CENTER_SCRAPE_CHROME_USER_DATA = $normalChrome
  AI_CENTER_SCRAPE_CHROME_PROFILE_DIRECTORY = 'Profile 2'
} -TestFile { $false }
Assert-Equal ($profile2.Arguments -join ' ') "--user-data-dir=$normalChrome --no-first-run --no-default-browser-check --profile-directory=Profile 2 about:blank" 'profile 2 launch args'

$connected = Get-AiCenterScrapeBrowserAction -Status @{ browsers = @(@{ id = 'chrome-1' }) } -ProfileProcessRunning $false -MissStreak 2 -Startup $true
Assert-Equal $connected.Action 'none' 'connected action'
Assert-Equal $connected.Reason 'connected' 'connected reason'
Assert-Equal $connected.MissStreak 0 'connected streak'

$startup = Get-AiCenterScrapeBrowserAction -Status @{ browsers = @() } -ProfileProcessRunning $false -MissStreak 0 -MissLimit 3 -Startup $true
Assert-Equal $startup.Action 'launch' 'startup launch'
Assert-Equal $startup.Reason 'startup' 'startup reason'

$running = Get-AiCenterScrapeBrowserAction -Status $null -ProfileProcessRunning $true -MissStreak 0 -MissLimit 3 -Startup $true
Assert-Equal $running.Action 'none' 'no duplicate'
Assert-Equal $running.Reason 'process' 'process reason'

$wait = Get-AiCenterScrapeBrowserAction -Status @{ browsers = @() } -ProfileProcessRunning $false -MissStreak 1 -MissLimit 3
Assert-Equal $wait.Action 'wait' 'guardian waits'
Assert-Equal $wait.MissStreak 2 'guardian streak'

$relaunch = Get-AiCenterScrapeBrowserAction -Status @{ browsers = @() } -ProfileProcessRunning $false -MissStreak 2 -MissLimit 3
Assert-Equal $relaunch.Action 'launch' 'guardian launch'
Assert-Equal $relaunch.Reason 'guardian' 'guardian reason'
Assert-Equal $relaunch.MissStreak 0 'guardian reset'

$dir = 'C:\ai-center\.ai-data\chrome-profile'
if (-not (Test-AiCenterScrapeBrowserCommandLine '--user-data-dir="C:\ai-center\.ai-data\chrome-profile" about:blank' $dir)) {
  throw 'quoted profile command line should match'
}
if (Test-AiCenterScrapeBrowserCommandLine '--user-data-dir=C:\ai-center\.ai-data\chrome-profile-other' $dir) {
  throw 'a longer profile directory must not match'
}
if (-not (Test-AiCenterScrapeBrowserCommandLine '--user-data-dir=C:/ai-center/.ai-data/chrome-profile' $dir)) {
  throw 'slash-normalized profile command line should match'
}
if (-not (Test-AiCenterScrapeBrowserCommandLine '--user-data-dir=C:\ai-center\.ai-data\chrome-profile\' $dir)) {
  throw 'trailing slash on the profile directory should match'
}

$envFile = Join-Path ([IO.Path]::GetTempPath()) 'ai-center-scrape-browser.env'
Set-Content -LiteralPath $envFile -Value @(
  '# secret=do-not-read',
  'AI_CENTER_SCRAPE_CHROME_USER_DATA="D:\profiles\from-file"',
  'OTHER_SECRET=nope'
) -Encoding ascii
$fromFile = Read-AiCenterScrapeBrowserDotEnv $envFile
Assert-Equal $fromFile['AI_CENTER_SCRAPE_CHROME_USER_DATA'] 'D:\profiles\from-file' 'env file profile'
if ($fromFile.ContainsKey('OTHER_SECRET')) { throw 'unrelated env keys must stay unread' }
Remove-Item -LiteralPath $envFile -Force
$merged = Merge-AiCenterScrapeBrowserEnvironment -RepositoryEnvironment @{
  AI_CENTER_SCRAPE_CHROME_USER_DATA = 'D:\repo'
  AI_CENTER_SCRAPE_BROWSER_MISS_LIMIT = '4'
} -InstanceEnvironment @{
  AI_CENTER_SCRAPE_CHROME_USER_DATA = 'D:\instance'
} -ProcessEnvironment @{
  AI_CENTER_SCRAPE_BROWSER_MISS_LIMIT = '5'
}
Assert-Equal $merged['AI_CENTER_SCRAPE_CHROME_USER_DATA'] 'D:\instance' 'instance env wins over repo'
Assert-Equal $merged['AI_CENTER_SCRAPE_BROWSER_MISS_LIMIT'] '5' 'process env wins'

$seen = @()
$dry = Invoke-AiCenterScrapeBrowserGuard -Status @{ browsers = @() } -ProfileProcessRunning $false -MissStreak 2 -Config $config -Launch {
  param($LaunchConfig)
  $script:seen += $LaunchConfig.Executable
}
Assert-Equal $dry.Launched $true 'dry-run launches through the callback'
Assert-Equal $dry.Decision.Reason 'guardian' 'dry-run reason'
Assert-Equal $dry.Line "[browser] no extension for 3 checks; launched Chrome user-data-dir=$expectedDir" 'dry-run line'
Assert-Equal $seen.Count 1 'dry-run callback once'
Assert-Equal $seen[0] 'C:\Chrome\chrome.exe' 'dry-run exe'

$runningProfile = Test-AiCenterScrapeBrowserProfileRunning -UserDataDir $dir -Executable 'C:\Chrome\chrome.exe' -ListCommandLines {
  param($ProcessName)
  if ($ProcessName -eq 'chrome.exe') {
    return @('--user-data-dir="C:\ai-center\.ai-data\chrome-profile"')
  }
  return @()
}
if (-not $runningProfile) { throw 'profile process command line should count as running' }
$otherProfile = Test-AiCenterScrapeBrowserProfileRunning -UserDataDir $dir -ListCommandLines {
  return @('--user-data-dir=C:\ai-center\.ai-data\chrome-profile-other')
}
if ($otherProfile) { throw 'a different profile must not count as running' }

$defaultDir = 'C:\Users\ada\AppData\Local\Google\Chrome\User Data'
$plainChrome = '"C:\Program Files\Google\Chrome\Application\chrome.exe" --profile-directory="Profile 1"'
if (-not (Test-AiCenterScrapeBrowserCommandLine $plainChrome $defaultDir $defaultDir)) {
  throw 'Chrome launched without --user-data-dir should match the default user-data dir'
}
$cased = 'c:\users\ada\appdata\local\google\chrome\user data\'
if (-not (Test-AiCenterScrapeBrowserCommandLine $plainChrome $cased $defaultDir)) {
  throw 'default user-data dir match should ignore case and a trailing slash'
}
if (Test-AiCenterScrapeBrowserCommandLine $plainChrome $dir $defaultDir) {
  throw 'Chrome without --user-data-dir must not count as a dedicated profile'
}
$renderer = '"C:\Program Files\Google\Chrome\Application\chrome.exe" --type=renderer --user-data-dir="C:\Users\ada\AppData\Local\Google\Chrome\User Data"'
if (Test-AiCenterScrapeBrowserCommandLine $renderer $defaultDir $defaultDir) {
  throw 'a --type= child must not count even when it names the user-data dir'
}
$gpu = '"C:\Program Files\Google\Chrome\Application\chrome.exe" --type=gpu-process'
if (Test-AiCenterScrapeBrowserCommandLine $gpu $defaultDir $defaultDir) {
  throw 'a --type= child without --user-data-dir must not count'
}

$defaultLines = @(
  $renderer,
  '"C:\Program Files\Google\Chrome\Application\chrome.exe"'
)
$defaultRunning = Test-AiCenterScrapeBrowserProfileRunning -UserDataDir $cased -DefaultUserDataDir $defaultDir -ListCommandLines {
  param($ProcessName)
  if ($ProcessName -eq 'chrome.exe') { return $defaultLines }
  return @()
}
if (-not $defaultRunning) { throw 'an open default Chrome should count as that user-data dir' }
$blocked = Get-AiCenterScrapeBrowserAction -Status @{ browsers = @() } -ProfileProcessRunning $defaultRunning -MissStreak 5 -MissLimit 3 -Startup $true
Assert-Equal $blocked.Action 'none' 'do not launch a second Chrome into the default dir'
Assert-Equal $blocked.Reason 'process' 'default dir already in use'
$dedicatedStillFree = Test-AiCenterScrapeBrowserProfileRunning -UserDataDir $dir -DefaultUserDataDir $defaultDir -ListCommandLines {
  return $defaultLines
}
if ($dedicatedStillFree) { throw 'the default Chrome must not occupy the dedicated profile directory' }
$onlyChild = Test-AiCenterScrapeBrowserProfileRunning -UserDataDir $defaultDir -DefaultUserDataDir $defaultDir -ListCommandLines {
  return @($renderer)
}
if ($onlyChild) { throw 'only child processes must not count as the browser' }

try {
  Get-AiCenterScrapeBrowserConfig -RepositoryRoot $root -Environment @{ AI_CENTER_SCRAPE_BROWSER_MISS_LIMIT = '0' } | Out-Null
  throw 'invalid miss limit should throw'
} catch {
  if ($_.Exception.Message -notmatch 'MISS_LIMIT') { throw }
}

Write-Output 'scrape-browser tests passed'
