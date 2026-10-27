@echo off
rem ============================================================
rem  Douyin PC client - force 4K (one click)
rem  Double-click this file. It will:
rem    1) find your Douyin install
rem    2) close Douyin (and restart it after patching)
rem    3) back up preload.js
rem    4) inject the 4K patch
rem    5) verify
rem  To undo: double-click "restore-original.cmd"
rem ============================================================
chcp 65001 >nul 2>&1
cd /d "%~dp0"

if not exist "%~dp0dypc4k.ps1" (
  echo [x] dypc4k.ps1 not found next to this file. Keep the whole folder together.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dypc4k.ps1" -Mode apply -Target 4k -StartAfter -Pause
exit /b %errorlevel%
