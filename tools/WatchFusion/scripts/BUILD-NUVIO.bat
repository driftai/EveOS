@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."
set "LOG=%~dp0..\build-nuvio.log"

set "NUVIO_DIR=%~1"
if not defined NUVIO_DIR if defined NUVIO_PATH set "NUVIO_DIR=%NUVIO_PATH%"
if not defined NUVIO_DIR set "NUVIO_DIR=%~dp0..\nuvio"
for %%I in ("%NUVIO_DIR%") do set "NUVIO_DIR=%%~fI"

if not exist "%NUVIO_DIR%\package.json" (
  echo ERROR: Could not find Nuvio at "%NUVIO_DIR%".
  echo Run GET-NUVIO.bat first.
  exit /b 1
)

if not exist "%~dp0PATCH-NUVIO-BROWSER-MOUSE.ps1" (
  echo ERROR: Missing WatchFusion Nuvio mouse integration patch.
  exit /b 1
)
if not exist "%~dp0PATCH-NUVIO-BROWSER-PLUGINS.ps1" (
  echo ERROR: Missing WatchFusion Nuvio browser plugin integration patch.
  exit /b 1
)

echo Enabling Nuvio native browser mouse controls...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0PATCH-NUVIO-BROWSER-MOUSE.ps1" -NuvioDir "%NUVIO_DIR%"
if errorlevel 1 (
  echo ERROR: Nuvio native mouse patch failed.
  exit /b 1
)

echo Enabling WatchFusion browser plugin networking...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0PATCH-NUVIO-BROWSER-PLUGINS.ps1" -NuvioDir "%NUVIO_DIR%"
if errorlevel 1 (
  echo ERROR: Nuvio browser plugin bridge patch failed.
  exit /b 1
)

echo Building Nuvio from: %NUVIO_DIR%
pushd "%NUVIO_DIR%"
call npm install --no-audit --no-fund
if errorlevel 1 (
  popd
  echo ERROR: npm install failed.
  exit /b 1
)
call npm run build
set "BUILD_EXIT=%ERRORLEVEL%"
popd
if not "%BUILD_EXIT%"=="0" (
  echo ERROR: Nuvio build failed with exit code %BUILD_EXIT%.
  exit /b %BUILD_EXIT%
)

if not exist "%NUVIO_DIR%\dist\index.html" (
  echo ERROR: Build finished without required dist files.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0PATCH-NUVIO-BROWSER-MOUSE.ps1" -NuvioDir "%NUVIO_DIR%" -VerifyDist
if errorlevel 1 (
  echo ERROR: Compiled Nuvio mouse gateway verification failed.
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0PATCH-NUVIO-BROWSER-PLUGINS.ps1" -NuvioDir "%NUVIO_DIR%" -VerifyDist
if errorlevel 1 (
  echo ERROR: Compiled Nuvio browser plugin bridge verification failed.
  exit /b 1
)

echo.
echo BUILD SUCCESSFUL!
echo Native browser mouse controls and host-local plugin networking are included in this Nuvio build.
exit /b 0
