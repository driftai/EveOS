@echo off
setlocal EnableExtensions
set "ROOT=%~dp0.."

for %%R in ("%ROOT%") do set "ROOT=%%~fR"

title WatchFusion - Remote

rem Cloudflared is a user-installed dependency.
rem Place cloudflared.exe at: <WatchFusion>\tools\cloudflared.exe
set "CLOUDFLARED=%ROOT%\tools\cloudflared.exe"

if not exist "%CLOUDFLARED%" (
    echo.
    echo ERROR: cloudflared.exe was not found.
    echo.
    echo WatchFusion Remote mode requires Cloudflare cloudflared.
    echo Download it from the official Cloudflare downloads page:
    echo https://developers.cloudflare.com/tunnel/downloads/
    echo.
    echo Then place the Windows executable here:
    echo   %CLOUDFLARED%
    echo.
    echo Rename it to cloudflared.exe if necessary.
    echo.
    pause
    exit /b 1
)

echo.
echo Using Cloudflared:
echo   %CLOUDFLARED%
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass ^
    -File "%ROOT%\scripts\REMOTE-TUNNEL.ps1" ^
    -Root "%ROOT%" ^
    -Cloudflared "%CLOUDFLARED%"

set "RC=%ERRORLEVEL%"
if %RC% neq 0 (
    echo.
    echo Remote tunnel terminated with code %RC%.
    pause
)
exit /b %RC%
