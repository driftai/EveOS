@echo off
setlocal EnableExtensions

cd /d "%~dp0..\.."
set "PROJECT_ROOT=%CD%"
call "%PROJECT_ROOT%\tools\batch\eveos-ports.bat"
call "%PROJECT_ROOT%\tools\batch\eveos-python.bat"
if errorlevel 1 (
    echo ERROR: Python not found. Install Python or create the documented .venv.
    exit /b 1
)
if not defined GEMINI_CONTROL_PORT set "GEMINI_CONTROL_PORT=9082"
if not "%~1"=="" set "GEMINI_CONTROL_PORT=%~1"

call "%PROJECT_ROOT%\tools\batch\install-eveos-control-protocol.bat" --quiet
if errorlevel 1 exit /b 1

set "CONTROL_SERVICE="
call :probe_service "eveos-control-plane" "/api/control-plane/health"
if not errorlevel 1 set "CONTROL_SERVICE=eveos-control-plane"
call :probe_service "gemini-control-helper" "/api/status"
if not errorlevel 1 set "CONTROL_SERVICE=gemini-control-helper"
if /I "%CONTROL_SERVICE%"=="eveos-control-plane" (
    echo EveOS local control is already listening on port %GEMINI_CONTROL_PORT%.
    exit /b 0
)

set "CONTROL_PORT_BUSY="
for /f "tokens=5" %%P in ('netstat -aon ^| findstr /R /C:":%GEMINI_CONTROL_PORT% .*LISTENING"') do (
    set "CONTROL_PORT_BUSY=1"
    if /I "%CONTROL_SERVICE%"=="gemini-control-helper" (
        echo Replacing the legacy Gemini-only helper with EveOS local control...
        >nul 2>nul taskkill /F /T /PID %%P
    )
)
if defined CONTROL_PORT_BUSY if /I not "%CONTROL_SERVICE%"=="gemini-control-helper" (
    echo ERROR: Port %GEMINI_CONTROL_PORT% is occupied by an unknown service.
    exit /b 1
)

rem Selective Boot services are on-demand. Starting local control must never
rem revive an unrelated tool merely because an old desiredRunning file survived.
del /q "%PROJECT_ROOT%\data\runtime\piano-player-service.json" >nul 2>nul
del /q "%PROJECT_ROOT%\data\runtime\world-book-service.json" >nul 2>nul
del /q "%PROJECT_ROOT%\data\runtime\watchfusion-service.json" >nul 2>nul

echo Starting EveOS local control plane on port %GEMINI_CONTROL_PORT%...
start "EveOS Local Control %GEMINI_CONTROL_PORT%" /min "%EVEOS_PYTHON%" -u server/eveos-control-helper.py %GEMINI_CONTROL_PORT%

"%EVEOS_PYTHON%" server/eveos-control-helper.py %GEMINI_CONTROL_PORT% --probe --timeout 30
if not errorlevel 1 (
    echo EveOS local control is ready.
    exit /b 0
)

echo ERROR: EveOS local control did not become ready.
exit /b 1

:probe_service
"%EVEOS_PYTHON%" -c "import json,sys,urllib.request; data=json.load(urllib.request.urlopen(sys.argv[2], timeout=2)); raise SystemExit(0 if data.get('service') == sys.argv[1] else 1)" "%~1" "http://127.0.0.1:%GEMINI_CONTROL_PORT%%~2" >nul 2>nul
exit /b %ERRORLEVEL%
