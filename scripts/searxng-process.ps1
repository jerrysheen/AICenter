$script:AiCenterRoot = Split-Path -Parent $PSScriptRoot
$script:SearxngRuntime = Join-Path $script:AiCenterRoot '.ai-data\searxng'
$script:SearxngSource = Join-Path $script:SearxngRuntime 'src'
$script:SearxngPython = Join-Path $script:SearxngRuntime 'venv\Scripts\python.exe'
$script:SearxngSettings = Join-Path $script:SearxngRuntime 'settings.yml'

function Test-SearxngInstalled {
  return (Test-Path -LiteralPath $script:SearxngPython -PathType Leaf) -and
    (Test-Path -LiteralPath $script:SearxngSettings -PathType Leaf) -and
    (Test-Path -LiteralPath $script:SearxngSource -PathType Container)
}

function Wait-SearxngHealth([int]$ListenPort = 8888, [int]$TimeoutSeconds = 25) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$ListenPort/healthz" -TimeoutSec 2 -UseBasicParsing
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return $true }
    } catch {
      try {
        $search = Invoke-WebRequest -Uri "http://127.0.0.1:$ListenPort/search?q=ai-center&format=json" -TimeoutSec 3 -UseBasicParsing
        if ($search.StatusCode -eq 200 -and $search.Content -match '"results"') { return $true }
      } catch {
        Start-Sleep -Milliseconds 400
      }
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Start-AiCenterSearchProcess {
  param(
    [string]$OutLog,
    [string]$ErrorLog
  )
  $previousSettings = $env:SEARXNG_SETTINGS_PATH
  $previousUnbuffered = $env:PYTHONUNBUFFERED
  $previousUtf8 = $env:PYTHONUTF8
  $env:SEARXNG_SETTINGS_PATH = $script:SearxngSettings
  $env:PYTHONUNBUFFERED = '1'
  $env:PYTHONUTF8 = '1'
  try {
    $lastError = $null
    foreach ($attempt in 1..6) {
      try {
        return Start-Process -FilePath $script:SearxngPython `
          -ArgumentList '-m','searx.webapp' `
          -WorkingDirectory $script:SearxngSource `
          -WindowStyle Hidden `
          -RedirectStandardOutput $OutLog `
          -RedirectStandardError $ErrorLog `
          -PassThru
      } catch {
        $lastError = $_
        Start-Sleep -Milliseconds 400
      }
    }
    throw "Cannot start Search Worker: $($lastError.Exception.Message)"
  } finally {
    if ($null -eq $previousSettings) { Remove-Item Env:SEARXNG_SETTINGS_PATH -ErrorAction SilentlyContinue } else { $env:SEARXNG_SETTINGS_PATH = $previousSettings }
    if ($null -eq $previousUnbuffered) { Remove-Item Env:PYTHONUNBUFFERED -ErrorAction SilentlyContinue } else { $env:PYTHONUNBUFFERED = $previousUnbuffered }
    if ($null -eq $previousUtf8) { Remove-Item Env:PYTHONUTF8 -ErrorAction SilentlyContinue } else { $env:PYTHONUTF8 = $previousUtf8 }
  }
}
