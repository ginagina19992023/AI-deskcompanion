@echo off
setlocal
cd /d "%~dp0"

echo Installing AI Desk Companion desktop shortcut...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL-DESKTOP-SHORTCUT.ps1"

if errorlevel 1 (
  echo.
  echo Failed to create the shortcut.
  pause
  exit /b 1
)

echo.
echo Done. You can close this window.
pause
