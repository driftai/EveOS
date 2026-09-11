@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0..\.."
set "PROJECT_ROOT=%CD%"
set "SERVER_ROOT=%PROJECT_ROOT%\server"
set "GEMINI_MAIN_DIR=%SERVER_ROOT%\gemini-backend\interactions"
set "GEMINI_MAIN_SCRIPT=%GEMINI_MAIN_DIR%\main.py"
call "%PROJECT_ROOT%\tools\batch\eveos-ports.bat"
if errorlevel 1 exit /b 1
if not defined GEMINI_WS_PORT (
    echo ERROR: GEMINI_WS_PORT is missing from the EveOS port registry.
    exit /b 1
)
if not defined GEMINI_STATUS_PORT (
    echo ERROR: GEMINI_STATUS_PORT is missing from the EveOS port registry.
    exit /b 1
)
call "%PROJECT_ROOT%\tools\batch\eveos-python.bat"
if errorlevel 1 (
    echo ERROR: Python not found. Install Python or create the documented .venv.
    pause
    exit /b 1
)
set "GEMINI_WINDOW_TITLE=EveOS Gemini Main %GEMINI_WS_PORT%-%GEMINI_STATUS_PORT%"

if /I "%~1"=="stop" (
    call :StopGemini
    exit /b %ERRORLEVEL%
)

if not "%~1"=="" (
    call :HandleChoice "%~1"
    exit /b %ERRORLEVEL%
)

:MainMenu
cls
echo ====================================
echo EveOS Gemini Backend Console
echo ====================================
echo.
echo Current Status:
call :ShowStatus
echo.
echo Options:
echo [1] Start Gemini server ^(WebSocket %GEMINI_WS_PORT% + Status %GEMINI_STATUS_PORT%^)
echo [2] Stop Gemini server
echo [3] Restart Gemini server
echo [4] Check Status
echo [5] Exit
echo.
echo Note: EveOS itself is served by server/python-server.py on your chosen site port.
echo       This menu only controls the Gemini Live backend used by file:// and localhost EveOS.
echo.
set /P "choice=Enter your choice (1-5): "
if "%choice%"=="" goto :MainMenu

call :HandleChoice "%choice%"
if "%choice%"=="5" exit /b 0
goto :MainMenu

:HandleChoice
set "choice=%~1"

rem Current menu.
if "%choice%"=="1" (
    call :StartGemini
    exit /b %ERRORLEVEL%
)
if "%choice%"=="2" (
    call :StopGemini
    exit /b %ERRORLEVEL%
)
if "%choice%"=="3" (
    call :StopGemini
    call :Sleep 2
    call :StartGemini
    exit /b %ERRORLEVEL%
)
if "%choice%"=="4" (
    echo.
    echo === Gemini Server Status ===
    call :ShowStatus
    echo.
    pause
    exit /b 0
)
if "%choice%"=="5" (
    exit /b 0
)

rem Legacy compatibility from the older two-server menu:
rem 1/2 both started split pieces before; use the canonical combined server now.
if "%choice%"=="6" (
    call :StartGemini
    exit /b %ERRORLEVEL%
)
if "%choice%"=="7" (
    echo.
    echo === Gemini Server Status ===
    call :ShowStatus
    echo.
    pause
    exit /b 0
)
if "%choice%"=="8" (
    exit /b 0
)
if "%choice%"=="10" (
    call :StartGemini
    exit /b %ERRORLEVEL%
)

echo Invalid choice: %choice%
exit /b 1

:StartGemini
if not exist "%GEMINI_MAIN_SCRIPT%" (
    echo ERROR: Gemini entry point not found:
    echo        %GEMINI_MAIN_SCRIPT%
    exit /b 1
)

call :CheckPort "%GEMINI_WS_PORT%" WS_PID
call :CheckPort "%GEMINI_STATUS_PORT%" STATUS_PID
if defined WS_PID (
    if defined STATUS_PID (
        echo Gemini server is already running.
        call :ShowStatus
        exit /b 0
    )
)

echo.
echo Starting EveOS Gemini server...
echo   WebSocket: ws://127.0.0.1:%GEMINI_WS_PORT%
echo   Status:    http://127.0.0.1:%GEMINI_STATUS_PORT%/status
echo.

rem Clear stale partial listeners. The canonical Gemini process must own both ports.
call :StopGeminiSilent
call :Sleep 1

start "%GEMINI_WINDOW_TITLE%" /min "%EVEOS_PYTHON%" -u "%GEMINI_MAIN_SCRIPT%" --port %GEMINI_WS_PORT%

call :WaitForReady 18
if %ERRORLEVEL% EQU 0 (
    echo [OK] Gemini server is running.
    call :ShowStatus
    exit /b 0
)

echo [WARN] Gemini server was launched, but both ports were not ready yet.
echo        Check the "%GEMINI_WINDOW_TITLE%" window for startup/API key errors.
call :ShowStatus
exit /b 1

:StopGemini
echo.
echo Stopping EveOS Gemini server...
call :StopGeminiSilent
call :Sleep 1
call :ShowStatus
exit /b 0

:StopGeminiSilent
taskkill /F /FI "WINDOWTITLE eq %GEMINI_WINDOW_TITLE%*" /T >nul 2>&1
call :KillPort "%GEMINI_WS_PORT%"
call :KillPort "%GEMINI_STATUS_PORT%"
exit /b 0

:ShowStatus
call :CheckPort "%GEMINI_WS_PORT%" WS_PID
call :CheckPort "%GEMINI_STATUS_PORT%" STATUS_PID
if defined WS_PID (
    echo Main WebSocket Server: RUNNING ^(Port %GEMINI_WS_PORT%, PID !WS_PID!^)
) else (
    echo Main WebSocket Server: STOPPED ^(Port %GEMINI_WS_PORT%^)
)
if defined STATUS_PID (
    echo Status Server: RUNNING ^(Port %GEMINI_STATUS_PORT%, PID !STATUS_PID!^)
) else (
    echo Status Server: STOPPED ^(Port %GEMINI_STATUS_PORT%^)
)
if defined WS_PID (
    if defined STATUS_PID (
        echo Overall: ONLINE
    ) else (
        echo Overall: PARTIAL - status endpoint is offline.
    )
) else (
    if defined STATUS_PID (
        echo Overall: PARTIAL - stale status/launcher listener; restart recommended.
    ) else (
        echo Overall: OFFLINE
    )
)
exit /b 0

:WaitForReady
set "TRIES=%~1"
if "%TRIES%"=="" set "TRIES=12"
for /L %%I in (1,1,%TRIES%) do (
    call :CheckPort "%GEMINI_WS_PORT%" WS_PID
    call :CheckPort "%GEMINI_STATUS_PORT%" STATUS_PID
    if defined WS_PID (
        if defined STATUS_PID exit /b 0
    )
    call :Sleep 1
)
exit /b 1

:Sleep
set "SLEEP_SECONDS=%~1"
if "%SLEEP_SECONDS%"=="" set "SLEEP_SECONDS=1"
set /a SLEEP_PINGS=SLEEP_SECONDS + 1
ping -n %SLEEP_PINGS% 127.0.0.1 >nul
exit /b 0

:CheckPort
set "%~2="
for /f "tokens=5" %%P in ('netstat -aon ^| findstr /R /C:":%~1 .*LISTENING"') do (
    set "%~2=%%P"
    goto :CheckPortDone
)
:CheckPortDone
exit /b 0

:KillPort
for /f "tokens=5" %%P in ('netstat -aon ^| findstr /R /C:":%~1 .*LISTENING"') do (
    taskkill /F /PID %%P /T >nul 2>&1
)
exit /b 0
