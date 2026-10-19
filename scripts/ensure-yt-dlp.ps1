# Install yt-dlp and ffmpeg for the YouTube podcast collector.
# Run from the repository root in PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts/ensure-yt-dlp.ps1

$ErrorActionPreference = 'Stop'

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

if (-not (Test-Command 'yt-dlp')) {
  if (Test-Command 'winget') {
    winget install --id yt-dlp.yt-dlp -e --accept-package-agreements --accept-source-agreements
  }
  if (-not (Test-Command 'yt-dlp')) {
    python -m pip install -U "yt-dlp[default]"
  }
}

if (-not (Test-Command 'ffmpeg')) {
  if (Test-Command 'winget') {
    winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements
  } else {
    Write-Error '没有 ffmpeg。请安装后重新打开终端。'
  }
}

yt-dlp --version
ffmpeg -version
