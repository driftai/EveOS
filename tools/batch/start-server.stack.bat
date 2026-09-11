@echo off
if "%~1"=="" exit /b 0
set "_START_SERVER_STACK_LABEL=%~1"
shift
goto %_START_SERVER_STACK_LABEL%

:BootStandardStack
call "%PROJECT_ROOT%\tools\batch\eveos-python.bat"
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python or create the documented .venv.
    pause
    exit /b 1
)
if not defined EVEOS_EXPOSURE_MODE (
    call "%PROJECT_ROOT%\tools\batch\select-exposure-mode.bat" "EveOS main web surface"
    if errorlevel 2 exit /b 0
)
set "_EVE_BIND_HOST=127.0.0.1"
if /I "%EVEOS_EXPOSURE_MODE%"=="lan" set "_EVE_BIND_HOST=0.0.0.0"

echo.
echo ========================================
echo   EveOS Canonical Boot
echo ========================================
echo   Main web origin: http://127.0.0.1:%EVEOS_WEB_PORT%/EveOS.html
echo   Main exposure:   %EVEOS_EXPOSURE_MODE%
echo   Internal control, Gemini and browser bridges remain localhost-only.
echo.
rem --- 1. EveOS web (guarded). ---
call :PortInUse "%EVEOS_WEB_PORT%" _WEB_PID
if defined _WEB_PID (
    echo [OK]    EveOS web already running on port %EVEOS_WEB_PORT% ^(PID !_WEB_PID!^).
) else (
    echo [START] EveOS web ^(hotkeys + audio bypass^) on port %EVEOS_WEB_PORT%...
    start "EveOS %EVEOS_WEB_PORT%" /min "%EVEOS_PYTHON%" -u server/eveos-server-launch.py %EVEOS_WEB_PORT% --host %_EVE_BIND_HOST%
)
call :WaitForEveServer "%EVEOS_WEB_PORT%"
if errorlevel 1 (
    echo [ERROR] EveOS web did not become ready on port %EVEOS_WEB_PORT%.
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\tools\batch\set-exposure-state.ps1" -Service eveos-main -Mode local -Inactive >nul 2>nul
if /I "%EVEOS_EXPOSURE_MODE%"=="lan" (
    set "_EVE_LAN_IP="
    for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$ip=[System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) ^| Where-Object {$_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and -not [System.Net.IPAddress]::IsLoopback($_)} ^| Select-Object -First 1; if($ip){$ip.IPAddressToString}"`) do set "_EVE_LAN_IP=%%I"
    if not defined _EVE_LAN_IP set "_EVE_LAN_IP=YOUR-PC-LAN-IP"
    set "_EVE_PUBLIC_URL=http://!_EVE_LAN_IP!:%EVEOS_WEB_PORT%/EveOS.html"
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\tools\batch\set-exposure-state.ps1" -Service eveos-main -Mode lan -PublicUrl "!_EVE_PUBLIC_URL!" -OriginUrl "http://127.0.0.1:%EVEOS_WEB_PORT%" >nul 2>nul
    echo [WARN]  Main EveOS is reachable on the trusted LAN: !_EVE_PUBLIC_URL!
) else if /I "%EVEOS_EXPOSURE_MODE%"=="cloudflare" (
    echo [INFO]  Main EveOS origin remains on 127.0.0.1.
    echo [INFO]  Opening authenticated Cloudflare Router terminal...
    start "EveOS Cloudflare Router" powershell -NoExit -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\tools\batch\start-quick-tunnel.ps1" -Service eveos-main -OriginPort %EVEOS_WEB_PORT% -PublicPath "/EveOS.html"
) else (
    echo [OK]    Main EveOS is localhost-only.
)

rem The main-surface selection is intentionally one-shot. Clear it before
rem starting the local control plane so Piano / WatchFusion / World Book
rem launchers do not inherit the main mode and silently skip their own prompt.
set "EVEOS_EXPOSURE_MODE="
set "_EVE_BIND_HOST="

echo [INFO]  World Book follows its saved On/Off state on port %WORLD_BOOK_PORT% ^(restores locally only^).
rem --- 2. Gemini backend + general EveOS file-mode control plane. Always loopback. ---
echo [BOOT]  Ensuring Gemini backend ^(WS %GEMINI_WS_PORT% / status %GEMINI_STATUS_PORT%^) on localhost...
call "%GEMINI_AUTOSTART_BAT%" >nul 2>nul
call :ReportPort "Gemini WebSocket" "%GEMINI_WS_PORT%"
call :ReportPort "Gemini control  " "%GEMINI_CONTROL_PORT%"
rem --- 3. Popup bridge. Always loopback. ---
call :EnsureBridge "Popup bridge   " "%POPUP_BRIDGE_PORT%" "server\bridges\popup-bridge.py"
rem --- 4. Lightpanda bridge. Always loopback. ---
if exist "%PROJECT_ROOT%\bin\lightpanda" (
    call :EnsureBridge "Lightpanda     " "%LIGHTPANDA_BRIDGE_PORT%" "server\bridges\lightpanda-bridge.py"
) else (
    echo [SKIP]  Lightpanda bridge - binary not found ^(bin\lightpanda^).
)
rem --- 5. Camofox bridge. Always loopback. ---
if exist "%CAMOFOX_RUNTIME_SERVER%" (
    call :EnsureBridge "Camofox        " "%CAMOFOX_BRIDGE_PORT%" "server\bridges\camofox-bridge.py"
) else (
    echo [SKIP]  Camofox bridge - runtime not installed.
)
echo.
echo ========================================
echo   Boot complete. Local host: http://127.0.0.1:%EVEOS_WEB_PORT%/EveOS.html
echo ========================================
exit /b 0

:WaitForEveServer
set "_EVE_READY="
for /L %%R in (1,1,15) do (
    "%EVEOS_PYTHON%" -c "import json,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:%~1/api/status', timeout=1)); raise SystemExit(0 if d.get('service') == 'eveos-local-server' else 1)" >nul 2>nul
    if not errorlevel 1 (
        set "_EVE_READY=1"
        goto :WaitForEveServerDone
    )
    timeout /t 1 /nobreak >nul 2>nul || ping -n 2 127.0.0.1 >nul
)
:WaitForEveServerDone
if defined _EVE_READY exit /b 0
exit /b 1

:EnsureBridge
rem %1=label  %2=port  %3=relative script path
set "_LABEL=%~1"
set "_PORT=%~2"
set "_SCRIPT=%PROJECT_ROOT%\%~3"
if not exist "%_SCRIPT%" (
    echo [SKIP]  %_LABEL% - script not found: %_SCRIPT%
    exit /b 0
)
call :PortInUse "%_PORT%" _BPID
if defined _BPID (
    echo [OK]    %_LABEL% already running on port %_PORT% ^(PID !_BPID!^).
    exit /b 0
)
echo [START] %_LABEL% on localhost port %_PORT%...
ping 127.0.0.1 -n 2 >nul
start "EveOS %_LABEL%" /min "%EVEOS_PYTHON%" -u "%_SCRIPT%" %_PORT%
exit /b 0

:ReportPort
set "_LABEL=%~1"
call :PortInUse "%~2" _RPID
if defined _RPID (
    echo [OK]    %_LABEL% running on port %~2 ^(PID !_RPID!^).
) else (
    echo [WARN]  %_LABEL% not detected on port %~2 yet ^(may still be starting^).
)
exit /b 0

:PortInUse
set "%~2="
for /f "tokens=5" %%P in ('netstat -aon ^| findstr /r /c:":%~1 .*LISTENING"') do (
    set "%~2=%%P"
    goto :PortInUseDone
)
:PortInUseDone
exit /b 0
