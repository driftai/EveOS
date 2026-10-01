@echo off
setlocal EnableExtensions
title EveOS Local Control Bootstrap

rem Registered URI entrypoint. URI payloads are intentionally ignored.
rem This shell is only a bootstrap. The persistent EveOS Local Control service,
rem when needed, opens its own titled console and reports its managed services.
echo [EveOS] Local Control Bootstrap
echo [EveOS] Ensuring the loopback control plane is available on port 9082...
echo [EveOS] This bootstrap exits automatically; it is not the service itself.

call "%~dp0start-eveos-control.bat"
set "EVEOS_CONTROL_BOOT_RC=%ERRORLEVEL%"

if "%EVEOS_CONTROL_BOOT_RC%"=="0" (
    echo [EveOS] Local Control is ready. Closing bootstrap.
) else (
    echo [EveOS] Local Control bootstrap failed with exit code %EVEOS_CONTROL_BOOT_RC%.
)

exit /b %EVEOS_CONTROL_BOOT_RC%
