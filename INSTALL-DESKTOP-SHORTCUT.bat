@echo off
setlocal

set "SCRIPT_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%tools\create-shortcut.ps1"

echo.
echo Done. Look for "AI Desk Companion" on your Desktop.
pause
