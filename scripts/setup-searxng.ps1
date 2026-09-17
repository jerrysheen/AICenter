param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDirectory = Join-Path $RepositoryRoot '.ai-data\searxng'
$SourceDirectory = Join-Path $RuntimeDirectory 'src'
$VenvDirectory = Join-Path $RuntimeDirectory 'venv'
$SettingsPath = Join-Path $RuntimeDirectory 'settings.yml'
$TemplatePath = Join-Path $RepositoryRoot 'config\searxng-settings.yml'
$PythonExe = Join-Path $VenvDirectory 'Scripts\python.exe'
$Remote = 'https://github.com/searxng/searxng.git'

function Write-Step([string]$Message, [string]$Color = 'Cyan') {
  Write-Host $Message -ForegroundColor $Color
}

function Resolve-HostPython {
  $probe = 'import sys; print(str(sys.version_info.major)+chr(46)+str(sys.version_info.minor)); print(sys.executable)'
  $candidates = @()
  foreach ($name in @('python', 'python3')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command -and $command.Source -notmatch '\\WindowsApps\\') {
      $candidates += $command.Source
    }
  }
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py -and $py.Source -notmatch '\\WindowsApps\\') { $candidates += $py.Source }

  foreach ($candidate in $candidates) {
    try {
      $args = if ([IO.Path]::GetFileNameWithoutExtension($candidate) -eq 'py') {
        @('-3', '-c', $probe)
      } else {
        @('-c', $probe)
      }
      $output = & $candidate @args
      if ($LASTEXITCODE -ne 0 -or -not $output) { continue }
      $lines = @($output | ForEach-Object { [string]$_.Trim() } | Where-Object { $_ })
      $version = $lines[0]
      $executable = if ($lines.Count -gt 1) { $lines[1] } else { $candidate }
      $parts = $version.Split('.')
      if ([int]$parts[0] -gt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 10)) {
        return @{ Version = $version; Executable = $executable }
      }
      Write-Host "发现 Python $version，需要 3.10 或更高。" -ForegroundColor DarkYellow
    } catch {
      continue
    }
  }
  return $null
}

if (-not (Test-Path -LiteralPath $TemplatePath -PathType Leaf)) {
  throw "缺少配置模板：$TemplatePath"
}

Get-Command git -ErrorAction Stop | Out-Null
$hostPython = Resolve-HostPython
if (-not $hostPython) {
  throw '未找到可用的 Python 3.10+。请先安装 Python 并勾选 Add python.exe to PATH，然后重新运行本脚本。'
}

function Test-SearxngCheckout {
  return (Test-Path -LiteralPath (Join-Path $SourceDirectory 'setup.py') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $SourceDirectory 'searx') -PathType Container)
}

function Install-SearxngSource {
  if ((Test-Path -LiteralPath (Join-Path $SourceDirectory '.git')) -and (Test-SearxngCheckout)) {
    Write-Step '已有 SearXNG 源码，尝试快进更新。'
    git -C $SourceDirectory -c core.protectNTFS=false pull --ff-only
    if ($LASTEXITCODE -ne 0) {
      Write-Host '源码更新失败，继续使用现有副本。' -ForegroundColor Yellow
    }
    return
  }

  if (Test-Path -LiteralPath $SourceDirectory) {
    Write-Step '正在清理不完整的 SearXNG 克隆。' 'Yellow'
    Remove-Item -LiteralPath $SourceDirectory -Recurse -Force
  }

  Write-Step "正在克隆 SearXNG 到 $SourceDirectory"
  # NTFS forbids ':' in filenames; SearXNG ships Apache/nginx templates named *.conf:socket.
  # core.protectNTFS=false lets Git check them out as alternate data streams instead of failing.
  git clone --config core.protectNTFS=false --depth 1 $Remote $SourceDirectory
  if ($LASTEXITCODE -ne 0) { throw 'git clone SearXNG 失败。' }
  if (-not (Test-SearxngCheckout)) { throw 'SearXNG 源码检出不完整。' }
}

Write-Step "使用 Python $($hostPython.Version)"
New-Item -ItemType Directory -Path $RuntimeDirectory -Force | Out-Null

if ($Force -and (Test-Path -LiteralPath $SourceDirectory)) {
  Write-Step '按 -Force 删除已有 SearXNG 源码后重新克隆。' 'Yellow'
  Remove-Item -LiteralPath $SourceDirectory -Recurse -Force
}

Install-SearxngSource

if ($Force -and (Test-Path -LiteralPath $VenvDirectory)) {
  Remove-Item -LiteralPath $VenvDirectory -Recurse -Force
}

if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
  Write-Step '正在创建 Python venv'
  & $hostPython.Executable -m venv $VenvDirectory
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
    throw '创建 venv 失败。'
  }
}

Write-Step '正在安装 SearXNG 依赖（可能需要几分钟）'
& $PythonExe -m pip install --upgrade pip setuptools wheel
if ($LASTEXITCODE -ne 0) { throw '升级 pip 失败。' }
& $PythonExe -m pip install -r (Join-Path $SourceDirectory 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw '安装 SearXNG requirements.txt 失败。' }
& $PythonExe -m pip install -e $SourceDirectory --no-build-isolation
if ($LASTEXITCODE -ne 0) { throw '安装 SearXNG 包失败。Windows 上缺少编译器时，请安装 Python 官方 amd64 安装包后再试。' }

# SearXNG imports Unix pwd in valkeydb.py; Windows has no such module.
$pwdShim = @'
"""Minimal pwd stand-in so SearXNG can import valkeydb on Windows."""
class struct_passwd:
    def __init__(self, pw_name='ai-center', pw_uid=0, pw_gid=0, pw_dir='', pw_shell=''):
        self.pw_name = pw_name
        self.pw_uid = pw_uid
        self.pw_gid = pw_gid
        self.pw_dir = pw_dir
        self.pw_shell = pw_shell
        self.pw_passwd = ''
        self.pw_gecos = ''

def getpwuid(uid):
    return struct_passwd(pw_uid=uid)

def getpwnam(name):
    return struct_passwd(pw_name=name)
'@
$sitePackages = Join-Path $VenvDirectory 'Lib\site-packages\pwd.py'
[System.IO.File]::WriteAllText($sitePackages, $pwdShim.TrimStart(), [System.Text.UTF8Encoding]::new($false))
Write-Step "已写入 Windows pwd 兼容模块"

if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf) -or $Force) {
  $secret = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
  $template = [System.IO.File]::ReadAllText($TemplatePath)
  $rendered = $template.Replace('__SECRET_KEY__', $secret)
  [System.IO.File]::WriteAllText($SettingsPath, $rendered, [System.Text.UTF8Encoding]::new($false))
  Write-Step "已写入 $SettingsPath"
} else {
  Write-Step '保留已有 settings.yml'
}

Write-Host ''
Write-Host 'Search Worker 安装完成。' -ForegroundColor Green
Write-Host "源码：$SourceDirectory"
Write-Host "配置：$SettingsPath"
Write-Host '以后双击 start-ai-center.bat 会尝试一起启动。也可单独运行 scripts\start-searxng.ps1'
