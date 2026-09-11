@echo off
setlocal
set RULE=WatchFusion TCP 9085
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
  netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow protocol=TCP localport=9085 profile=private
  if %errorlevel%==0 (echo Firewall rule added for private networks on TCP 9085.) else (echo Failed to add firewall rule.)
)
echo.
pause
