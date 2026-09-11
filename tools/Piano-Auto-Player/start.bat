@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PROJECT_ROOT=%CD%\..\.."
for %%R in ("%PROJECT_ROOT%") do set "PROJECT_ROOT=%%~fR"
set "BOOT_DIR=%PROJECT_ROOT%\tools\batch"

echo.
echo  Piano Auto Player
echo  -----------------
echo.

where py >nul 2>nul
if %errorlevel%==0 (
  set "PY=py -3"
) else (
  set "PY=python"
)

call "%BOOT_DIR%\select-exposure-mode.bat" "Piano Auto Player"
if errorlevel 2 exit /b 0

if /I "%EVEOS_EXPOSURE_MODE%"=="lan" goto :lan
if /I "%EVEOS_EXPOSURE_MODE%"=="cloudflare" goto :cloudflare
goto :local

:local
powershell -NoProfile -ExecutionPolicy Bypass -File "%BOOT_DIR%\set-exposure-state.ps1" -Service piano -Mode local >nul 2>nul
echo Starting privately on http://127.0.0.1:8771
start "" "http://127.0.0.1:8771"
%PY% run.py --host 127.0.0.1 --port 8771
if errorlevel 1 goto :fail
exit /b 0

:lan
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$ip=[System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) ^| Where-Object {$_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and -not [System.Net.IPAddress]::IsLoopback($_)} ^| Select-Object -First 1; if($ip){$ip.IPAddressToString}"`) do set "LAN_IP=%%I"
if not defined LAN_IP set "LAN_IP=YOUR-PC-LAN-IP"
set "LAN_URL=http://%LAN_IP%:8771/"
powershell -NoProfile -ExecutionPolicy Bypass -File "%BOOT_DIR%\set-exposure-state.ps1" -Service piano -Mode lan -PublicUrl "%LAN_URL%" -OriginUrl "http://127.0.0.1:8771" >nul 2>nul
echo.
echo [WARN] LAN mode exposes Piano controls and the saved Piano library to devices on this local network.
echo [READY] %LAN_URL%
echo.
%PY% run.py --host 0.0.0.0 --port 8771
if errorlevel 1 goto :fail
exit /b 0

:cloudflare
powershell -NoProfile -ExecutionPolicy Bypass -File "%BOOT_DIR%\set-exposure-state.ps1" -Service piano -Mode local >nul 2>nul
echo [START] Piano origin stays private on 127.0.0.1:8771.
start "Piano Auto Player Origin" cmd /k "cd /d "%CD%" && %PY% run.py --host 127.0.0.1 --port 8771"
for /L %%R in (1,1,40) do (
  powershell -NoProfile -Command "try {(Invoke-RestMethod -Uri 'http://127.0.0.1:8771/api/status' -TimeoutSec 1).ok -eq $true} catch {$false}" | findstr /I "True" >nul && goto :piano_ready
  timeout /t 1 /nobreak >nul
)
echo [ERROR] Piano origin did not become ready on port 8771.
goto :fail

:piano_ready
powershell -NoProfile -ExecutionPolicy Bypass -File "%BOOT_DIR%\start-quick-tunnel.ps1" -Service piano -OriginPort 8771 -PublicPath "/" -OpenBrowser
exit /b %ERRORLEVEL%

:fail
echo.
echo Startup failed. Make sure Python 3 is installed and available in PATH.
pause
exit /b 1
