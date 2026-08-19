@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [Pet Studio] Node.js was not found in PATH.
  echo Install Node.js 18 or newer, then run this file again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [Pet Studio] npm was not found in PATH.
  echo Install Node.js with npm, then run this file again.
  echo.
  pause
  exit /b 1
)

echo Starting AI Desk Companion Pet Studio...
echo The browser should open automatically at http://127.0.0.1:8732
if "%OPENAI_API_KEY%"=="" (
  echo OPENAI_API_KEY is not set in this terminal. Manual mode will still work.
)
echo.

npm run pet-studio
if errorlevel 1 (
  echo.
  echo Pet Studio stopped with an error.
  pause
)
