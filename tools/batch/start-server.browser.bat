@echo off
if not defined PROJECT_ROOT for %%R in ("%~dp0..\..") do set "PROJECT_ROOT=%%~fR"
if not defined LIGHTPANDA_MONITOR_TITLE set "LIGHTPANDA_MONITOR_TITLE=EveOS Lightpanda Monitor"
if not defined LIGHTPANDA_ACTIVITY_LOG set "LIGHTPANDA_ACTIVITY_LOG=%PROJECT_ROOT%\bin\lightpanda_activity.log"
if "%~1"=="" exit /b 0
set "_START_SERVER_BROWSER_LABEL=%~1"
shift
goto %_START_SERVER_BROWSER_LABEL%

:RefreshBrowserFallbackStatus
set "LP_READY="
if exist "%PROJECT_ROOT%\bin\lightpanda" (
    set "LP_READY=1"
)
call :CheckStandaloneLightpanda
call :CheckCamofoxRuntime
call :CheckStandaloneCamofox
call :CheckStandaloneWikimedia
call :CheckStandalonePopup
exit /b 0

:RefreshLightpandaStatus
call :RefreshBrowserFallbackStatus
exit /b 0

:CheckStandaloneLightpanda
set "LP_STANDALONE_PID="
for /f "tokens=5" %%P in ('netstat -aon ^| findstr /r /c:":%LIGHTPANDA_BRIDGE_PORT% .*LISTENING"') do (
    set "LP_STANDALONE_PID=%%P"
    goto :CheckStandaloneLightpandaDone
)
:CheckStandaloneLightpandaDone
exit /b 0

:CheckCamofoxRuntime
set "CF_READY="
if exist "%CAMOFOX_RUNTIME_SERVER%" (
    set "CF_READY=1"
)
exit /b 0

:CheckStandaloneCamofox
set "CF_STANDALONE_PID="
for /f "tokens=5" %%P in ('netstat -aon ^| findstr /r /c:":%CAMOFOX_BRIDGE_PORT% .*LISTENING"') do (
    set "CF_STANDALONE_PID=%%P"
    goto :CheckStandaloneCamofoxDone
)
:CheckStandaloneCamofoxDone
exit /b 0

:CheckStandaloneWikimedia
set "WMF_STANDALONE_PID="
for /f "tokens=5" %%P in ('netstat -aon ^| findstr /r /c:":%WIKIMEDIA_BRIDGE_PORT% .*LISTENING"') do (
    set "WMF_STANDALONE_PID=%%P"
    goto :CheckStandaloneWikimediaDone
)
:CheckStandaloneWikimediaDone
exit /b 0

:CheckStandalonePopup
set "POPUP_STANDALONE_PID="
for /f "tokens=5" %%P in ('netstat -aon ^| findstr /r /c:":%POPUP_BRIDGE_PORT% .*LISTENING"') do (
    set "POPUP_STANDALONE_PID=%%P"
    goto :CheckStandalonePopupDone
)
:CheckStandalonePopupDone
exit /b 0

:EnsureLightpandaMonitor
if not exist "%PROJECT_ROOT%\bin" mkdir "%PROJECT_ROOT%\bin" >nul 2>nul
if not exist "%LIGHTPANDA_ACTIVITY_LOG%" type nul > "%LIGHTPANDA_ACTIVITY_LOG%"
tasklist /v /fi "imagename eq cmd.exe" | findstr /i /c:"%LIGHTPANDA_MONITOR_TITLE%" >nul
if %ERRORLEVEL% EQU 0 exit /b 0
start "%LIGHTPANDA_MONITOR_TITLE%" cmd /k "echo ======================================== && echo   %LIGHTPANDA_MONITOR_TITLE% && echo ======================================== && echo. && powershell -NoProfile -Command ""Get-Content -Path '%LIGHTPANDA_ACTIVITY_LOG%' -Wait -Tail 20"""
exit /b 0

:EnsureCamofoxMonitor
if not exist "%PROJECT_ROOT%\bin" mkdir "%PROJECT_ROOT%\bin" >nul 2>nul
if not exist "%CAMOFOX_ACTIVITY_LOG%" type nul > "%CAMOFOX_ACTIVITY_LOG%"
tasklist /v /fi "imagename eq cmd.exe" | findstr /i /c:"%CAMOFOX_MONITOR_TITLE%" >nul
if %ERRORLEVEL% EQU 0 exit /b 0
start "%CAMOFOX_MONITOR_TITLE%" cmd /k "echo ======================================== && echo   %CAMOFOX_MONITOR_TITLE% && echo ======================================== && echo. && powershell -NoProfile -Command ""Get-Content -Path '%CAMOFOX_ACTIVITY_LOG%' -Wait -Tail 20"""
exit /b 0

:EnsureWikimediaMonitor
if not exist "%PROJECT_ROOT%\bin" mkdir "%PROJECT_ROOT%\bin" >nul 2>nul
if not exist "%WIKIMEDIA_ACTIVITY_LOG%" type nul > "%WIKIMEDIA_ACTIVITY_LOG%"
tasklist /v /fi "imagename eq cmd.exe" | findstr /i /c:"%WIKIMEDIA_MONITOR_TITLE%" >nul
if %ERRORLEVEL% EQU 0 exit /b 0
start "%WIKIMEDIA_MONITOR_TITLE%" cmd /k "echo ======================================== && echo   %WIKIMEDIA_MONITOR_TITLE% && echo ======================================== && echo. && powershell -NoProfile -Command ""Get-Content -Path '%WIKIMEDIA_ACTIVITY_LOG%' -Wait -Tail 20"""
exit /b 0

:EnsurePopupMonitor
if not exist "%PROJECT_ROOT%\bin" mkdir "%PROJECT_ROOT%\bin" >nul 2>nul
if not exist "%POPUP_ACTIVITY_LOG%" type nul > "%POPUP_ACTIVITY_LOG%"
tasklist /v /fi "imagename eq cmd.exe" | findstr /i /c:"%POPUP_MONITOR_TITLE%" >nul
if %ERRORLEVEL% EQU 0 exit /b 0
start "%POPUP_MONITOR_TITLE%" cmd /k "echo ======================================== && echo   %POPUP_MONITOR_TITLE% && echo ======================================== && echo. && powershell -NoProfile -Command ""Get-Content -Path '%POPUP_ACTIVITY_LOG%' -Wait -Tail 20"""
exit /b 0
