@echo off
setlocal EnableExtensions
set "EVEOS_ROOT=%~dp0..\..\.."
for %%R in ("%EVEOS_ROOT%") do set "EVEOS_ROOT=%%~fR"
call "%EVEOS_ROOT%\tools\batch\eveos-ports.bat"
if errorlevel 1 exit /b 1
if not defined WATCHFUSION_PORT (
  echo ERROR: WATCHFUSION_PORT is missing from the EveOS port registry.
  exit /b 1
)
set "RULE=WatchFusion TCP %WATCHFUSION_PORT%"
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Please run this file as Administrator.
  echo Right-click ^> Run as administrator
  pause
  exit /b 1
)
netsh advfirewall firewall show rule name="%RULE%" >nul 2>&1
if %errorlevel%==0 (
  echo Firewall rule already exists: %RULE%
) else (
  netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow protocol=TCP localport=%WATCHFUSION_PORT% profile=private
  if %errorlevel%==0 (echo Firewall rule added for private networks on TCP %WATCHFUSION_PORT%.) else (echo Failed to add firewall rule.)
)
echo.
pause
