@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0\.."
set "EVEOS_ROOT=%~dp0..\..\.."
for %%R in ("%EVEOS_ROOT%") do set "EVEOS_ROOT=%%~fR"
call "%EVEOS_ROOT%\tools\batch\eveos-ports.bat"
if errorlevel 1 exit /b 1
if not defined WATCHFUSION_PORT (
  echo ERROR: WATCHFUSION_PORT is missing from the EveOS port registry.
  exit /b 1
)
title WatchFusion - LAN
set "HOST=0.0.0.0"
set "PORT=%WATCHFUSION_PORT%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js and try again.
  pause
  exit /b 1
)

set "LAN_IP="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$c = (Get-NetIPConfiguration); foreach ($a in $c) { if ($a.NetAdapter.Status -eq 'Up' -and $a.IPv4DefaultGateway -and $a.IPv4Address) { foreach ($ip in $a.IPv4Address.IPAddress) { if ($ip -and $ip -notlike '169.254*') { $ip; exit } } } }"`) do if not defined LAN_IP set "LAN_IP=%%I"

set "LAN_URL="
if defined LAN_IP set "LAN_URL=http://!LAN_IP!:%WATCHFUSION_PORT%/"
if defined LAN_URL (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEOS_ROOT%\tools\batch\set-exposure-state.ps1" -Service watchfusion -Mode lan -PublicUrl "!LAN_URL!" -OriginUrl "http://127.0.0.1:%WATCHFUSION_PORT%" >nul 2>nul
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEOS_ROOT%\tools\batch\set-exposure-state.ps1" -Service watchfusion -Mode lan -OriginUrl "http://127.0.0.1:%WATCHFUSION_PORT%" >nul 2>nul
)

echo.
echo [WARN] LAN mode exposes WatchFusion to devices on this trusted local network.
if defined LAN_URL (
  echo [READY] !LAN_URL!
) else (
  echo [READY] WatchFusion will bind to all interfaces on port %WATCHFUSION_PORT%.
  echo [WARN] A preferred LAN IPv4 address could not be resolved automatically.
)
echo [INFO] EveOS will keep using its embedded WatchFusion view; no extra browser tab will open.
echo.
start "WatchFusion Server (LAN)" cmd /k "cd /d ""%~dp0\.."" && set HOST=0.0.0.0&& set PORT=%WATCHFUSION_PORT%&& node server.js"
exit /b 0
