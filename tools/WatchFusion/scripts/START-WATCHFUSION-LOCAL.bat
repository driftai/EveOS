@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."
title WatchFusion - Localhost
set "HOST=127.0.0.1"
set "PORT=9085"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js and try again.
  pause
  exit /b 1
)

start "WatchFusion Server" cmd /k "cd /d ""%~dp0\.."" && node server.js"
timeout /t 2 /nobreak >nul
start "" "http://127-0-0-1.sslip.io:9085/"
exit /b 0
