@echo off
setlocal EnableExtensions DisableDelayedExpansion
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
set "CLOUDFLARED_BUNDLED=%ROOT%\tools\cloudflared.exe"
set "CLOUDFLARED_BOOTSTRAP=%EVEOS_ROOT%\tools\batch\ensure-cloudflared.ps1"
set "CLOUDFLARED_RESULT=%TEMP%\eveos-cloudflared-%RANDOM%-%RANDOM%.txt"
set "CLOUDFLARED="

if not exist "%CLOUDFLARED_BOOTSTRAP%" (
    echo ERROR: EveOS cloudflared resolver is missing:
    echo   %CLOUDFLARED_BOOTSTRAP%
    pause
    exit /b 1
)

echo.
echo [INFO] Locating a usable cloudflared installation...
powershell -NoProfile -ExecutionPolicy Bypass -File "%CLOUDFLARED_BOOTSTRAP%" -Destination "%CLOUDFLARED_BUNDLED%" > "%CLOUDFLARED_RESULT%" 2>&1
set "CLOUDFLARED_RC=%ERRORLEVEL%"

if not "%CLOUDFLARED_RC%"=="0" goto :RESOLVE_FAILED

for /f "usebackq delims=" %%I in ("%CLOUDFLARED_RESULT%") do set "CLOUDFLARED=%%I"
del /q "%CLOUDFLARED_RESULT%" >nul 2>nul

if not defined CLOUDFLARED goto :NO_CLOUDFLARED
if not exist "%CLOUDFLARED%" goto :CLOUDFLARED_NOT_EXIST

"%CLOUDFLARED%" --version >nul 2>nul
if errorlevel 1 goto :CLOUDFLARED_BAD_VERSION

echo [READY] cloudflared:
echo   "%CLOUDFLARED%"
echo WatchFusion port:
echo   %WATCHFUSION_PORT%
echo.
goto :RUN_TUNNEL

:RESOLVE_FAILED
echo.
echo ERROR: WatchFusion could not resolve or install cloudflared.
echo Resolver details:
type "%CLOUDFLARED_RESULT%"
del /q "%CLOUDFLARED_RESULT%" >nul 2>nul
echo.
echo Official source: https://developers.cloudflare.com/tunnel/downloads/
echo.
pause
exit /b %CLOUDFLARED_RC%

:NO_CLOUDFLARED
echo.
echo ERROR: cloudflared resolver returned no executable path.
pause
exit /b 1

:CLOUDFLARED_NOT_EXIST
echo.
echo ERROR: Resolved cloudflared.exe was not found or path does not exist:
echo   "%CLOUDFLARED%"
pause
exit /b 1

:CLOUDFLARED_BAD_VERSION
echo.
echo ERROR: Resolved cloudflared failed its version self-check:
echo   "%CLOUDFLARED%"
pause
exit /b 1

:RUN_TUNNEL

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
