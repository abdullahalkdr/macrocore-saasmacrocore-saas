@echo off
REM Starts the backend, frontend, and marketing dev servers together — one double-click
REM instead of opening 3 windows and typing cd/npm run dev in each one every time.
REM
REM Stop each server with Ctrl+C INSIDE its own window when you're done — not the X
REM button — otherwise the port stays locked and you'll get EADDRINUSE next run.

echo Killing any leftover node processes...
taskkill /F /IM node.exe >nul 2>&1

start "macrocore - backend"   cmd /k "cd /d %~dp0backend   && npm run dev"
start "macrocore - frontend"  cmd /k "cd /d %~dp0frontend  && npm run dev"
start "macrocore - marketing" cmd /k "cd /d %~dp0marketing && npm run dev"

echo Started 3 windows: backend, frontend, marketing.
