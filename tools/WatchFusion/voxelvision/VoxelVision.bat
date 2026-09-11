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
echo   [4] Setup / Update YouTube Support (yt-dlp + FFmpeg)
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
if defined YTDLP_READY (
    echo [OK] YouTube extractor: !YTDLP_PROVIDER!
) else (
    echo [OPTIONAL] yt-dlp is not installed. Choose menu option 4.
)

call :CHECK_FFMPEG
if defined FFMPEG_READY (
    echo [OK] Adaptive video/audio merge: !FFMPEG_PROVIDER!
) else (
    echo [OPTIONAL] FFmpeg is missing. Some YouTube videos may not import.
    echo            Choose menu option 4 to install portable FFmpeg.
)
echo ============================================================
pause
goto :MENU

:SETUP_YOUTUBE
cls
echo ============================================================
echo              VOXELVISION YOUTUBE SUPPORT SETUP
echo ============================================================
echo This setup keeps VoxelVision independent from your Python version.
echo It downloads the official standalone yt-dlp.exe into .\tools and
echo a portable FFmpeg build for videos that expose separate video/audio.
echo.

if not exist "tools" mkdir "tools"

echo [1/2] Installing/updating standalone yt-dlp.exe...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'tools\yt-dlp.exe'"
if errorlevel 1 (
    echo [WARNING] Standalone yt-dlp download failed. Trying existing Python installation...
    goto :SETUP_YTDLP_FALLBACK
)

"tools\yt-dlp.exe" --version >nul 2>nul
if errorlevel 1 (
    echo [WARNING] Downloaded yt-dlp.exe did not start. Trying Python fallback...
    del /q "tools\yt-dlp.exe" >nul 2>nul
    goto :SETUP_YTDLP_FALLBACK
)
echo [OK] Standalone yt-dlp.exe is ready.
goto :SETUP_FFMPEG

:SETUP_YTDLP_FALLBACK
where py >nul 2>nul
if not errorlevel 1 (
    py -m pip install --upgrade yt-dlp
    if not errorlevel 1 goto :SETUP_FFMPEG
)
where python >nul 2>nul
if not errorlevel 1 (
    python -m pip install --upgrade yt-dlp
    if not errorlevel 1 goto :SETUP_FFMPEG
)
echo [ERROR] Could not install yt-dlp.
echo Check your internet connection and try option 4 again.
pause
goto :MENU

:SETUP_FFMPEG
call :CHECK_FFMPEG
if defined FFMPEG_READY (
    echo [2/2] FFmpeg already available: !FFMPEG_PROVIDER!
    goto :SETUP_VERIFY
)

echo [2/2] Downloading portable FFmpeg essentials...
echo       This is a larger one-time download and may take a moment.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $zip='tools\ffmpeg-essentials.zip'; $tmp='tools\ffmpeg-tmp'; Invoke-WebRequest -UseBasicParsing -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip; if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }; Expand-Archive -Path $zip -DestinationPath $tmp -Force; $ff=Get-ChildItem $tmp -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1; if (-not $ff) { throw 'ffmpeg.exe was not found in the archive' }; Copy-Item $ff.FullName 'tools\ffmpeg.exe' -Force; $fp=Get-ChildItem $tmp -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1; if ($fp) { Copy-Item $fp.FullName 'tools\ffprobe.exe' -Force }; Remove-Item $zip -Force; Remove-Item $tmp -Recurse -Force"
if errorlevel 1 (
    echo [WARNING] Portable FFmpeg download failed.
    echo Combined-stream YouTube videos can still work, but adaptive-only videos may fail.
) else (
    echo [OK] Portable FFmpeg is ready.
)

goto :SETUP_VERIFY

:SETUP_VERIFY
call :CHECK_YTDLP
call :CHECK_FFMPEG
echo.
echo ============================================================
if defined YTDLP_READY (
    echo [OK] YouTube extractor: !YTDLP_PROVIDER!
) else (
    echo [ERROR] No working yt-dlp provider was found.
)
if defined FFMPEG_READY (
    echo [OK] Adaptive stream merge: !FFMPEG_PROVIDER!
) else (
    echo [WARNING] FFmpeg is unavailable. Some videos may still fail.
)
echo ============================================================
echo Setup complete. Restart VoxelVision if the server was already running.
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
        goto :eof
    )
)
where yt-dlp >nul 2>nul
if not errorlevel 1 (
    yt-dlp --version >nul 2>nul
    if not errorlevel 1 (
        set "YTDLP_READY=1"
        set "YTDLP_PROVIDER=yt-dlp on PATH"
        goto :eof
    )
)
where py >nul 2>nul
if not errorlevel 1 (
    py -m yt_dlp --version >nul 2>nul
    if not errorlevel 1 (
        set "YTDLP_READY=1"
        set "YTDLP_PROVIDER=py -m yt_dlp"
        goto :eof
    )
)
where python >nul 2>nul
if not errorlevel 1 (
    python -m yt_dlp --version >nul 2>nul
    if not errorlevel 1 (
        set "YTDLP_READY=1"
        set "YTDLP_PROVIDER=python -m yt_dlp"
        goto :eof
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
        goto :eof
    )
)
where ffmpeg >nul 2>nul
if not errorlevel 1 (
    ffmpeg -version >nul 2>nul
    if not errorlevel 1 (
        set "FFMPEG_READY=1"
        set "FFMPEG_PROVIDER=ffmpeg on PATH"
        goto :eof
    )
)
goto :eof
