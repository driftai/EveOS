@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title VoxelVision Control Center

:MENU
cls
echo ============================================================
echo                      VOXELVISION CONTROL CENTER
echo       Interactive 3D Voxel Video + Live AI Depth Engine
echo ============================================================
echo   [1] Start VoxelVision ^& Open Browser (http://127.0.0.1:9095)
echo   [2] Start Server (Foreground / Headless Browser)
echo   [3] Verify Local Media ^& YouTube Support
echo   [4] Setup / Update YouTube Support
echo       (yt-dlp + JS runtime + FFmpeg + ffprobe)
echo   [5] Exit
echo ============================================================
set /p "CHOICE=Select an option [1-5]: "

if "%CHOICE%"=="1" goto :START_APP
if "%CHOICE%"=="2" goto :START_SERVER
if "%CHOICE%"=="3" goto :VERIFY_ASSETS
if "%CHOICE%"=="4" goto :SETUP_YOUTUBE
if "%CHOICE%"=="5" exit /b 0
goto :MENU

:START_APP
cls
echo Starting VoxelVision Server...
start "" http://127.0.0.1:9095
node server.js
pause
goto :MENU

:START_SERVER
cls
echo Starting server on http://127.0.0.1:9095...
node server.js
pause
goto :MENU

:VERIFY_ASSETS
cls
echo ============================================================
echo Checking VoxelVision:
echo ============================================================
where node >nul 2>nul
if errorlevel 1 (
    echo [MISSING] Node.js is not available on PATH.
) else (
    for /f "delims=" %%V in ('node --version 2^>nul') do echo [OK] Node.js %%V
)

if exist "public\media\voxelvision-demo.mp4" (
    echo [OK] Public procedural demo found.
) else (
    echo [MISSING] public\media\voxelvision-demo.mp4
)
if exist "public\media\voxelvision-demo.depth.json" (
    echo [OK] Cached depth metadata found.
) else (
    echo [MISSING] public\media\voxelvision-demo.depth.json
)
if exist "public\media\voxelvision-demo.depth.bin.gz" (
    echo [OK] Cached depth binary found.
) else (
    echo [MISSING] public\media\voxelvision-demo.depth.bin.gz
)
if exist "public\vendor\three.module.js" (
    echo [OK] Three.js engine found.
) else (
    echo [MISSING] public\vendor\three.module.js
)

call :CHECK_YTDLP
call :CHECK_JS_RUNTIME
call :CHECK_FFMPEG
call :CHECK_FFPROBE

echo.
if defined YTDLP_READY (echo [OK] YouTube extractor: !YTDLP_PROVIDER!) else (echo [OPTIONAL] yt-dlp is missing. Choose option 4.)
if defined JS_RUNTIME_READY (echo [OK] YouTube JS runtime: !JS_RUNTIME_PROVIDER!) else (echo [OPTIONAL] No supported YouTube JS runtime. Choose option 4.)
if defined FFMPEG_READY (echo [OK] Adaptive video/audio merge: !FFMPEG_PROVIDER!) else (echo [OPTIONAL] FFmpeg is missing. Choose option 4.)
if defined FFPROBE_READY (echo [OK] Media probe: !FFPROBE_PROVIDER!) else (echo [OPTIONAL] ffprobe is missing. Choose option 4.)
echo ============================================================
pause
goto :MENU

:SETUP_YOUTUBE
cls
echo ============================================================
echo              VOXELVISION YOUTUBE SUPPORT SETUP
echo ============================================================
echo This uses the same installer as WatchFusion Setup Health.
echo It installs portable host-local helpers under .\tools only.
echo Node 22+ is reused when available; otherwise portable Deno is used.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\SETUP-YOUTUBE.ps1" -Force
if errorlevel 1 (
    echo.
    echo [ERROR] YouTube helper setup failed.
    pause
    goto :MENU
)
echo.
echo [OK] Shared YouTube helper setup completed.
pause
goto :MENU

:CHECK_YTDLP
set "YTDLP_READY="
set "YTDLP_PROVIDER="
if exist "tools\yt-dlp.exe" (
    "tools\yt-dlp.exe" --version >nul 2>nul
    if not errorlevel 1 (
        set "YTDLP_READY=1"
        set "YTDLP_PROVIDER=tools\yt-dlp.exe"
    )
)
goto :eof

:CHECK_JS_RUNTIME
set "JS_RUNTIME_READY="
set "JS_RUNTIME_PROVIDER="
set "NODE_MAJOR="
where node >nul 2>nul
if not errorlevel 1 (
    for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node" 2^>nul') do set "NODE_MAJOR=%%V"
)
if defined NODE_MAJOR (
    set /a NODE_MAJOR_NUM=!NODE_MAJOR! 2>nul
    if !NODE_MAJOR_NUM! GEQ 22 (
        set "JS_RUNTIME_READY=1"
        set "JS_RUNTIME_PROVIDER=Node !NODE_MAJOR_NUM!+"
        goto :eof
    )
)
if exist "tools\deno.exe" (
    "tools\deno.exe" --version >nul 2>nul
    if not errorlevel 1 (
        set "JS_RUNTIME_READY=1"
        set "JS_RUNTIME_PROVIDER=tools\deno.exe"
    )
)
goto :eof

:CHECK_FFMPEG
set "FFMPEG_READY="
set "FFMPEG_PROVIDER="
if exist "tools\ffmpeg.exe" (
    "tools\ffmpeg.exe" -version >nul 2>nul
    if not errorlevel 1 (
        set "FFMPEG_READY=1"
        set "FFMPEG_PROVIDER=tools\ffmpeg.exe"
    )
)
goto :eof

:CHECK_FFPROBE
set "FFPROBE_READY="
set "FFPROBE_PROVIDER="
if exist "tools\ffprobe.exe" (
    "tools\ffprobe.exe" -version >nul 2>nul
    if not errorlevel 1 (
        set "FFPROBE_READY=1"
        set "FFPROBE_PROVIDER=tools\ffprobe.exe"
    )
)
goto :eof
