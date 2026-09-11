@echo off
rem ============================================================
rem  EveOS - Canonical port adapter for Windows batch launchers
rem ------------------------------------------------------------
rem  The single source of truth is now:
rem      config\eveos-ports.json
rem
rem  This adapter exports every registered KEY=PORT into the
rem  current cmd.exe environment so existing launchers stay simple.
rem  New services must be registered in the JSON file rather than
rem  adding another literal port to a launcher.
rem ============================================================

if not defined PROJECT_ROOT for %%R in ("%~dp0..\..") do set "PROJECT_ROOT=%%~fR"
set "EVEOS_PORT_REGISTRY=%PROJECT_ROOT%\config\eveos-ports.json"

if not exist "%EVEOS_PORT_REGISTRY%" (
    echo [ERROR] EveOS port registry not found: "%EVEOS_PORT_REGISTRY%"
    exit /b 1
)

set "_EVEOS_PORT_LOAD_OK="
for /f "usebackq tokens=1,* delims==" %%A in (`powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $j=Get-Content -LiteralPath '%EVEOS_PORT_REGISTRY%' -Raw ^| ConvertFrom-Json; foreach($p in $j.ports.PSObject.Properties){ $n=[string]$p.Name; $v=[int]$p.Value.port; if($v -lt 1 -or $v -gt 65535){ throw ('Invalid port for '+$n) }; [Console]::WriteLine($n+'='+$v) }" 2^>nul`) do (
    set "%%A=%%B"
    set "_EVEOS_PORT_LOAD_OK=1"
)

if not defined _EVEOS_PORT_LOAD_OK (
    echo [ERROR] Could not parse EveOS port registry: "%EVEOS_PORT_REGISTRY%"
    exit /b 1
)

set "_EVEOS_PORT_LOAD_OK="
exit /b 0
