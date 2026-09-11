@echo off
if "%~1"=="" exit /b 0
set "_START_SERVER_INSTANCE_LABEL=%~1"
shift
goto %_START_SERVER_INSTANCE_LABEL%
:LaunchEveInstance
set "INSTANCE_PORT=%~1"
set "INSTANCE_PACK_PATH=%~2"
set "INSTANCE_KIND=%~3"
set "PORT_MODE=%~4"

call "%PROJECT_ROOT%\tools\batch\eveos-python.bat"
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python or create the documented .venv.
    echo.
    pause
    exit /b 1
)

echo.
echo [OK] Python found:
"%EVEOS_PYTHON%" --version
echo.

if not exist "%INSTANCE_PACK_PATH%" mkdir "%INSTANCE_PACK_PATH%" >nul 2>nul

netstat -ano | findstr ":%INSTANCE_PORT%" | find "LISTENING" >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    if /I "%PORT_MODE%"=="replace" (
        echo [INFO] Port %INSTANCE_PORT% is in use. Stopping listeners on that port...
        for /f "tokens=5" %%a in ('netstat -aon ^| find ":%INSTANCE_PORT%" ^| find "LISTENING"') do (
            if "%%a" NEQ "0" (
                echo Killing PID %%a...
                taskkill /f /pid %%a >nul 2>nul
            )
        )
        timeout /t 2 /nobreak >nul
    ) else (
        echo [ERROR] Port %INSTANCE_PORT% is already in use. Pick another port.
        timeout /t 1 /nobreak >nul
        exit /b 1
    )
)

echo [OK] Launching %INSTANCE_KIND% EveOS instance in a new window:
echo      Port: %INSTANCE_PORT%
echo      Data: %INSTANCE_PACK_PATH%

rem Keep Lightpanda state as a normal inherited environment value. Do not build
rem partial command fragments here: an empty fragment used to leave an incomplete
rem `if defined` command in option 1 and could abort before Python was launched.
set "EVEOS_LIGHTPANDA_DISABLED="
if "%LP_ENABLED_STATE%"=="0" (
    set "EVEOS_LIGHTPANDA_DISABLED=1"
) else (
    call "%START_SERVER_BROWSER_BAT%" :EnsureLightpandaMonitor
)

set "EVEOS_MODULAR_ROOT=%INSTANCE_PACK_PATH%"
call :StartAndVerifyEveServer "%INSTANCE_PORT%" "EveOS Instance %INSTANCE_PORT%"
if errorlevel 1 exit /b 1
call "%START_SERVER_PATHS_BAT%" :TrackInstance "%INSTANCE_PORT%" "%INSTANCE_PACK_PATH%" "%INSTANCE_KIND%"
exit /b 0

:LaunchEvePortOnly
set "INSTANCE_PORT=%~1"

call "%PROJECT_ROOT%\tools\batch\eveos-python.bat"
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python or create the documented .venv.
    echo.
    pause
    exit /b 1
)

netstat -ano | findstr ":%INSTANCE_PORT%" | find "LISTENING" >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [ERROR] Port %INSTANCE_PORT% is already in use. Pick another port.
    timeout /t 1 /nobreak >nul
    exit /b 1
)

echo.
echo [OK] Launching EveOS HTTP port in a new window:
echo      URL: http://127.0.0.1:%INSTANCE_PORT%/EveOS.html
echo      Data: current active modular data-pack
echo.

call :StartAndVerifyEveServer "%INSTANCE_PORT%" "EveOS Port %INSTANCE_PORT%"
if errorlevel 1 exit /b 1
call "%START_SERVER_PATHS_BAT%" :TrackInstance "%INSTANCE_PORT%" "active modular data-pack" "PortOnly"
exit /b 0

:StartAndVerifyEveServer
set "_EVE_START_PORT=%~1"
set "_EVE_START_TITLE=%~2"
if not exist "%PROJECT_ROOT%\bin" mkdir "%PROJECT_ROOT%\bin" >nul 2>nul
set "_EVE_START_LOG=%PROJECT_ROOT%\bin\eveos-server-%_EVE_START_PORT%.log"

> "%_EVE_START_LOG%" echo [launcher] Python: %EVEOS_PYTHON%
>> "%_EVE_START_LOG%" echo [launcher] Port: %_EVE_START_PORT%

start "%_EVE_START_TITLE%" /min "%EVEOS_PYTHON%" -u server/python-server.py %_EVE_START_PORT% >> "%_EVE_START_LOG%" 2>&1
call :WaitForEveServer "%_EVE_START_PORT%"
if errorlevel 1 (
    echo.
    echo [ERROR] EveOS did not become ready on port %_EVE_START_PORT%.
    echo [ERROR] Python: %EVEOS_PYTHON%
    echo [ERROR] Startup log: %_EVE_START_LOG%
    if exist "%_EVE_START_LOG%" (
        echo.
        echo ---------- EveOS startup log ----------
        type "%_EVE_START_LOG%"
        echo ---------- end startup log ------------
    )
    echo.
    pause
    exit /b 1
)

echo [OK] EveOS is ready: http://127.0.0.1:%_EVE_START_PORT%/EveOS.html
exit /b 0

:WaitForEveServer
set "_EVE_READY="
for /L %%R in (1,1,12) do (
    "%EVEOS_PYTHON%" -c "import json,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:%~1/api/status', timeout=1)); raise SystemExit(0 if d.get('service') == 'eveos-local-server' and int(d.get('port', 0)) == int('%~1') else 1)" >nul 2>nul
    if not errorlevel 1 (
        set "_EVE_READY=1"
        goto :WaitForEveServerDone
    )
    timeout /t 1 /nobreak >nul
)
:WaitForEveServerDone
if defined _EVE_READY exit /b 0
exit /b 1
