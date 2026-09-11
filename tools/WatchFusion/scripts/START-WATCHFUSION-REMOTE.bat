@echo off
setlocal EnableExtensions
set "ROOT=%~dp0.."
for %%R in ("%ROOT%") do set "ROOT=%%~fR"
set "EVEOS_ROOT=%~dp0..\..\.."
for %%R in ("%EVEOS_ROOT%") do set "EVEOS_ROOT=%%~fR"
call "%EVEOS_ROOT%\tools\batch\eveos-ports.bat"
if errorlevel 1 exit /b 1
if not defined WATCHFUSION_PORT (
    echo ERROR: WATCHFUSION_PORT is missing from the EveOS port registry.
    exit /b 1
)

title WatchFusion - Remote
set "CLOUDFLARED=%ROOT%\tools\cloudflared.exe"
set "CLOUDFLARED_BOOTSTRAP=%EVEOS_ROOT%\tools\batch\ensure-cloudflared.ps1"

if not exist "%CLOUDFLARED%" (
    echo.
    echo [INFO] cloudflared.exe is not installed in WatchFusion yet.
    echo [INFO] EveOS will download the official Cloudflare Windows release now.
    echo.
    set "CLOUDFLARED_FOUND="
    for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%CLOUDFLARED_BOOTSTRAP%" -Destination "%CLOUDFLARED%"`) do set "CLOUDFLARED_FOUND=%%I"
    if defined CLOUDFLARED_FOUND set "CLOUDFLARED=%CLOUDFLARED_FOUND%"
)

if not exist "%CLOUDFLARED%" (
    echo.
    echo ERROR: WatchFusion could not obtain cloudflared.exe.
    echo Check Internet access and retry option 3.
    echo Official source: https://developers.cloudflare.com/tunnel/downloads/
    echo.
    pause
    exit /b 1
)

echo.
echo Using Cloudflared:
echo   %CLOUDFLARED%
echo WatchFusion port:
echo   %WATCHFUSION_PORT%
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass ^
    -File "%ROOT%\scripts\REMOTE-TUNNEL.ps1" ^
    -Root "%ROOT%" ^
    -Cloudflared "%CLOUDFLARED%" ^
    -Port %WATCHFUSION_PORT%

set "RC=%ERRORLEVEL%"
if %RC% neq 0 (
    echo.
    echo Remote tunnel terminated with code %RC%.
    pause
)
exit /b %RC%
