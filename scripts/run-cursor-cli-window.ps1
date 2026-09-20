param(
  [Parameter(Mandatory = $true)][string]$AgentScript,
  [Parameter(Mandatory = $true)][string]$Workspace,
  [Parameter(Mandatory = $true)][string]$PromptFile,
  [string]$Model = 'cursor-grok-4.6-high-fast',
  [string[]]$Image = @()
)

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'
$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'

# Windows PowerShell 5.1 reads -File as system ANSI unless the script has a BOM.
# Keep Chinese as code points so the title is not mojibake on GBK consoles.
$title = 'AI Center ' + [char]0x4EFB + [char]0x52A1
$Host.UI.RawUI.WindowTitle = $title
Write-Host $title -ForegroundColor Cyan
Write-Host "workspace=$Workspace"
Write-Host "model=$Model"
Write-Host ''

$prompt = [IO.File]::ReadAllText($PromptFile, $utf8)
$imageArgs = @()
foreach ($path in @($Image)) {
  if ($path) { $imageArgs += @('--image', $path) }
}
$code = 0
try {
  & $AgentScript -p --force --trust --workspace $Workspace --model $Model --output-format text @imageArgs $prompt
  $code = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $PromptFile -Force -ErrorAction SilentlyContinue
}

if ($code -ne 0) {
  Write-Host ("CLI exit {0}" -f $code) -ForegroundColor Yellow
}
exit $code
