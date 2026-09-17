param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CodexArguments
)

$ErrorActionPreference = 'Stop'
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$LocalConfigRoot = Join-Path $RepositoryRoot '.codex-grok'
$EnvFile = Join-Path $RepositoryRoot '.env'

function Read-EnvValue([string]$Name) {
  $fromProcess = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ($fromProcess) {
    return $fromProcess
  }
  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    return ''
  }
  foreach ($line in Get-Content -LiteralPath $EnvFile) {
    if ($line -match ("^\s*" + [regex]::Escape($Name) + "\s*=\s*(.+?)\s*$")) {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return ''
}

function Import-LocalElucidGrokKey {
  $key = Read-EnvValue 'ELUCID_GROK_API_KEY'
  if (-not $key) {
    $key = Read-EnvValue 'AI_CENTER_GROK_API_KEY'
  }
  if (-not $key) {
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
      throw "Missing $EnvFile. Add the Elucid-only ELUCID_GROK_API_KEY to the local .env file."
    }
    throw 'Elucid-only ELUCID_GROK_API_KEY is not configured in .env or the current environment.'
  }
  $env:ELUCID_GROK_API_KEY = $key
}

try {
  $codex = Get-Command codex -ErrorAction Stop
  if (-not (Test-Path -LiteralPath (Join-Path $LocalConfigRoot 'config.toml') -PathType Leaf)) {
    throw "Missing local Codex configuration: $LocalConfigRoot\config.toml"
  }

  Import-LocalElucidGrokKey
  $env:CODEX_HOME = $LocalConfigRoot
  Write-Host "[Codex] Starting in $RepositoryRoot"
  Write-Host '[Codex] Elucid 专用 Grok Key @ hk.getelucid.com（不用于信息流翻译）'
  & $codex.Source @CodexArguments
  exit $LASTEXITCODE
} catch {
  Write-Error "[Codex] $($_.Exception.Message)"
  exit 1
}
