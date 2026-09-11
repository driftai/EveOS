@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

set "TARGET=%~1"
if not defined TARGET if defined NUVIO_PATH set "TARGET=%NUVIO_PATH%"
if not defined TARGET set "TARGET=%~dp0..\nuvio"
for %%I in ("%TARGET%") do set "TARGET=%%~fI"

set "MISSING=0"
if not exist "%TARGET%\package.json" set "MISSING=1"
if not exist "%TARGET%\appinfo.json" set "MISSING=1"
if not exist "%TARGET%\index.html" set "MISSING=1"
if not exist "%TARGET%\js\app.js" set "MISSING=1"

if "%MISSING%"=="0" (
  echo Nuvio installation is present and valid:
  echo   %TARGET%
  echo WatchFusion can use this location directly.
  call :PAUSE_IF_INTERACTIVE
  exit /b 0
)

echo Installing Nuvio into:
echo   %TARGET%

set "ZIP=%TEMP%\nuvio-main.zip"
set "UNPACK=%TEMP%\nuvio-unpack"
set "URL=https://github.com/NuvioMedia/NuvioTVSmart/archive/refs/heads/main.zip"

echo Downloading NuvioTVSmart...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri '%URL%' -OutFile '%ZIP%' -UseBasicParsing; exit 0 } catch { Write-Host $_; exit 1 }"
if errorlevel 1 goto :FAIL
if exist "%UNPACK%" rmdir /s /q "%UNPACK%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%UNPACK%' -Force"
if errorlevel 1 goto :FAIL
set "SRC="
for /d %%D in ("%UNPACK%\NuvioTVSmart-*") do set "SRC=%%D"
if not defined SRC goto :FAIL
if not exist "%TARGET%" mkdir "%TARGET%"
robocopy "%SRC%" "%TARGET%" /E /NFL /NDL /NJH /NJS >nul
if errorlevel 8 goto :FAIL

if not exist "%TARGET%\package.json" goto :FAIL
if not exist "%TARGET%\appinfo.json" goto :FAIL
if not exist "%TARGET%\index.html" goto :FAIL
if not exist "%TARGET%\js\app.js" goto :FAIL

del /q "%ZIP%" >nul 2>nul
rmdir /s /q "%UNPACK%" >nul 2>nul
echo.
echo Nuvio installation is ready at:
echo   %TARGET%
echo Run BUILD-NUVIO.bat next to compile the browser bundle.
call :PAUSE_IF_INTERACTIVE
exit /b 0

:FAIL
del /q "%ZIP%" >nul 2>nul
rmdir /s /q "%UNPACK%" >nul 2>nul
echo ERROR: Nuvio install/repair failed.
call :PAUSE_IF_INTERACTIVE
exit /b 1

:PAUSE_IF_INTERACTIVE
if /I "%WATCHFUSION_NONINTERACTIVE%"=="1" goto :eof
pause
goto :eof
