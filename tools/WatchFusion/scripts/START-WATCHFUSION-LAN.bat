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
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$ip=[System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) ^| Where-Object {$_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and -not [System.Net.IPAddress]::IsLoopback($_)} ^| Select-Object -First 1; if($ip){$ip.IPAddressToString}"`) do set "LAN_IP=%%I"
if not defined LAN_IP set "LAN_IP=YOUR-PC-LAN-IP"
set "LAN_URL=http://!LAN_IP!:%WATCHFUSION_PORT%/"
powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEOS_ROOT%\tools\batch\set-exposure-state.ps1" -Service watchfusion -Mode lan -PublicUrl "!LAN_URL!" -OriginUrl "http://127.0.0.1:%WATCHFUSION_PORT%" >nul 2>nul

echo.
echo [WARN] LAN mode exposes WatchFusion to devices on this trusted local network.
echo [READY] !LAN_URL!
echo.
start "WatchFusion Server (LAN)" cmd /k "cd /d ""%~dp0\.."" && set HOST=0.0.0.0&& set PORT=%WATCHFUSION_PORT%&& node server.js"
timeout /t 2 /nobreak >nul
start "" "!LAN_URL!"
exit /b 0
