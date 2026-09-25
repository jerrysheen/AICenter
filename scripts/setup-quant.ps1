# Requires an installed Python 3.11. Does not touch the system Python.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'
if (-not (Test-Path $Python)) {
  $Python = (& py -3.11 -c "import sys; print(sys.executable)")
}
if (-not (Test-Path $Python)) {
  throw 'Python 3.11 was not found. Install it with: winget install -e --id Python.Python.3.11'
}
$Venv = Join-Path $Root 'quant\.venv'
& $Python -m venv $Venv
$VenvPython = Join-Path $Venv 'Scripts\python.exe'
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r (Join-Path $Root 'quant\requirements.txt')
$env:PYTHONPATH = Join-Path $Root 'quant\src'
& $VenvPython -m aicenter_quant doctor
Write-Output 'Quant environment is ready.'
