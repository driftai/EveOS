@echo off
setlocal EnableExtensions
set "_LABEL=%~1"
if not defined _LABEL set "_LABEL=EveOS service"

if defined EVEOS_EXPOSURE_MODE (
    if /I "%EVEOS_EXPOSURE_MODE%"=="local" goto :selected
    if /I "%EVEOS_EXPOSURE_MODE%"=="lan" goto :selected
    if /I "%EVEOS_EXPOSURE_MODE%"=="cloudflare" goto :selected
)

:prompt
echo.
echo ========================================
echo   Selective Boot - %_LABEL%
echo ========================================
echo   [1] Localhost only
 echo      Private to this computer. Default and safest mode.
echo   [2] LAN
 echo      Reachable by other devices on this local network.
echo   [3] Cloudflare Router
 echo      Local origin + temporary authenticated TryCloudflare URL.
echo   [Q] Cancel
echo.
choice /C 123Q /N /M "Select exposure mode: "
if errorlevel 4 exit /b 2
if errorlevel 3 set "EVEOS_EXPOSURE_MODE=cloudflare"& goto :selected
if errorlevel 2 set "EVEOS_EXPOSURE_MODE=lan"& goto :selected
if errorlevel 1 set "EVEOS_EXPOSURE_MODE=local"& goto :selected
goto :prompt

:selected
echo [BOOT] %_LABEL% exposure: %EVEOS_EXPOSURE_MODE%
endlocal & set "EVEOS_EXPOSURE_MODE=%EVEOS_EXPOSURE_MODE%"
exit /b 0
