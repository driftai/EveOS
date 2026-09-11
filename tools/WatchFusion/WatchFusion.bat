@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title WatchFusion Control Center

:MENU
cls
echo ============================================================
echo                      WATCHFUSION CONTROL CENTER
echo ============================================================
echo   [1] Start Localhost (127.0.0.1:9085)
echo   [2] Start LAN Mode (0.0.0.0:9085)
echo   [3] Start Cloudflare Remote Tunnel
echo   [4] Install/Repair Nuvio Media Integration
echo   [5] Build Nuvio Media Integration
echo   [6] Configure Nuvio Account / QR
echo   [7] Run Smoke ^& Security Test Suite
echo   [8] Run Architecture Check
echo   [9] Exit
echo ============================================================
set /p "CHOICE=Select an option [1-9]: "

if "%CHOICE%"=="1" goto :LOCAL
if "%CHOICE%"=="2" goto :LAN
if "%CHOICE%"=="3" goto :REMOTE
if "%CHOICE%"=="4" goto :GET_NUVIO
if "%CHOICE%"=="5" goto :BUILD_NUVIO
if "%CHOICE%"=="6" goto :CONF_NUVIO
if "%CHOICE%"=="7" goto :TESTS
if "%CHOICE%"=="8" goto :ARCH
if "%CHOICE%"=="9" exit /b 0
goto :MENU

:LOCAL
call scripts\START-WATCHFUSION-LOCAL.bat
pause
goto :MENU

:LAN
call scripts\START-WATCHFUSION-LAN.bat
pause
goto :MENU

:REMOTE
call scripts\START-WATCHFUSION-REMOTE.bat
pause
goto :MENU

:GET_NUVIO
call scripts\GET-NUVIO.bat
pause
goto :MENU

:BUILD_NUVIO
call scripts\BUILD-NUVIO.bat
pause
goto :MENU

:CONF_NUVIO
call scripts\CONFIGURE-NUVIO.bat
pause
goto :MENU

:TESTS
call npm run --silent test
pause
goto :MENU

:ARCH
node scripts\CHECK-ARCHITECTURE.mjs
pause
goto :MENU
