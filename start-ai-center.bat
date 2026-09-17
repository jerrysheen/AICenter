@echo off
setlocal
cd /d "%~dp0"
title AI Center

echo %CMDCMDLINE% | find /I "/c" >nul
if errorlevel 1 goto same_console

start "AI Center" /D "%~dp0" powershell.exe -NoLogo -NoExit -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-ai-center.ps1" %*
exit /b 0

:same_console
powershell.exe -NoLogo -NoExit -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-ai-center.ps1" %*
exit /b %ERRORLEVEL%
