@echo off
setlocal
title Codex CLI - AI Center Grok

cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-codex-grok.ps1" %*
set "AI_CENTER_CODEX_EXIT_CODE=%ERRORLEVEL%"

if not "%AI_CENTER_CODEX_EXIT_CODE%"=="0" (
    echo.
    echo [Codex] Exited with code %AI_CENTER_CODEX_EXIT_CODE%.
    pause
)

endlocal & exit /b %AI_CENTER_CODEX_EXIT_CODE%
