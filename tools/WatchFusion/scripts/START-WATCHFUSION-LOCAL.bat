@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."
set "EVEOS_ROOT=%~dp0..\..\.."
for %%R in ("%EVEOS_ROOT%") do set "EVEOS_ROOT=%%~fR"
call "%EVEOS_ROOT%\tools\batch\eveos-ports.bat"
if errorlevel 1 exit /b 1
if not defined WATCHFUSION_PORT (
  echo ERROR: WATCHFUSION_PORT is missing from the EveOS port registry.
  exit /b 1
)
title WatchFusion - Localhost
set "HOST=127.0.0.1"
set "PORT=%WATCHFUSION_PORT%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEOS_ROOT%\tools\batch\set-exposure-state.ps1" -Service watchfusion -Mode local -Inactive >nul 2>nul

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js and try again.
  pause
  exit /b 1
)

start "WatchFusion Server" cmd /k "cd /d ""%~dp0\.."" && set HOST=127.0.0.1&& set PORT=%WATCHFUSION_PORT%&& node server.js"
timeout /t 2 /nobreak >nul
start "" "http://127-0-0-1.sslip.io:%WATCHFUSION_PORT%/"
exit /b 0
