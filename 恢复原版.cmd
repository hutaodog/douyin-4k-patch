@echo off
rem ============================================================
rem  Restore original Douyin PC client (remove the 4K patch)
rem  Double-click this file.
rem ============================================================
chcp 65001 >nul 2>&1
cd /d "%~dp0"

if not exist "%~dp0dypc4k.ps1" (
  echo [x] dypc4k.ps1 not found next to this file.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dypc4k.ps1" -Mode restore -StartAfter -Pause
exit /b %errorlevel%
