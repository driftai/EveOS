@echo off
if not defined PROJECT_ROOT for %%R in ("%~dp0..\..") do set "PROJECT_ROOT=%%~fR"
if not defined LAST_USED_PACK_FILE set "LAST_USED_PACK_FILE=%PROJECT_ROOT%\data\launcher-last-pack.txt"
if not defined LAST_USED_PORT_FILE set "LAST_USED_PORT_FILE=%PROJECT_ROOT%\data\runtime\eveos-last-launcher-port.txt"
if "%~1"=="" exit /b 0
set "_START_SERVER_PATHS_LABEL=%~1"
shift
goto %_START_SERVER_PATHS_LABEL%

:ResolveMainDataPackPath
set "MAIN_DATA_PACK=%PROJECT_ROOT%\data\modular-state"
set "SETTINGS_FILE=%PROJECT_ROOT%\data\modular-store-settings.json"
if exist "%SETTINGS_FILE%" (
    for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$p = '%SETTINGS_FILE%'; try { $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json; if ($j.activePath) { [Console]::WriteLine($j.activePath) } } catch { }"`) do (
        if not "%%P"=="" set "MAIN_DATA_PACK=%%P"
    )
)
call :ResolveAbsolutePath "%MAIN_DATA_PACK%" MAIN_DATA_PACK
exit /b 0

:LoadLastUsedPackPath
set "LAST_USED_PACK_PATH="
if exist "%LAST_USED_PACK_FILE%" (
    for /f "usebackq delims=" %%P in ("%LAST_USED_PACK_FILE%") do (
        if not "%%P"=="" (
            set "LAST_USED_PACK_PATH=%%P"
            goto :LoadLastUsedPackPathDone
        )
    )
)
:LoadLastUsedPackPathDone
if defined LAST_USED_PACK_PATH call :ResolveAbsolutePath "%LAST_USED_PACK_PATH%" LAST_USED_PACK_PATH
exit /b 0

:PersistLastUsedPackPath
set "SAVE_PACK_PATH=%~1"
if "%SAVE_PACK_PATH%"=="" exit /b 0
if not exist "%PROJECT_ROOT%\data" mkdir "%PROJECT_ROOT%\data" >nul 2>nul
> "%LAST_USED_PACK_FILE%" (
    echo %SAVE_PACK_PATH%
)
exit /b 0

:PersistLastUsedPort
set "SAVE_PORT=%~1"
if "%SAVE_PORT%"=="" exit /b 0
if not exist "%PROJECT_ROOT%\data\runtime" mkdir "%PROJECT_ROOT%\data\runtime" >nul 2>nul
> "%LAST_USED_PORT_FILE%" echo %SAVE_PORT%
exit /b 0

:PromptDataPackPath
setlocal EnableDelayedExpansion
set "DEFAULT_PACK_PATH=%~1"
set "SELECTED_PACK_PATH="

if not defined DEFAULT_PACK_PATH set "DEFAULT_PACK_PATH=%PROJECT_ROOT%\data\modular-state"
call :ResolveAbsolutePath "!DEFAULT_PACK_PATH!" DEFAULT_PACK_PATH
if defined LAST_USED_PACK_PATH call :ResolveAbsolutePath "!LAST_USED_PACK_PATH!" LAST_USED_PACK_PATH

echo.
echo Data-pack selection:
echo   [1] Default path
echo       !DEFAULT_PACK_PATH!
if defined LAST_USED_PACK_PATH (
    echo   [2] Last used path
    echo       !LAST_USED_PACK_PATH!
) else (
    echo   [2] Last used path
    echo       ^(not set yet^)
)
echo   [3] New custom path
echo.
set /p "PACK_PICK=Choose data-pack option (default 1): "
if not defined PACK_PICK set "PACK_PICK=1"

if "!PACK_PICK!"=="1" (
    set "SELECTED_PACK_PATH=!DEFAULT_PACK_PATH!"
    goto :PromptDataPackPathDone
)
if "!PACK_PICK!"=="2" (
    if defined LAST_USED_PACK_PATH (
        set "SELECTED_PACK_PATH=!LAST_USED_PACK_PATH!"
    ) else (
        echo [WARN] No last used path found. Using default.
        set "SELECTED_PACK_PATH=!DEFAULT_PACK_PATH!"
    )
    goto :PromptDataPackPathDone
)
if "!PACK_PICK!"=="3" (
    set "CUSTOM_PACK_PATH="
    set /p "CUSTOM_PACK_PATH=Enter custom data-pack folder path: "
    if not defined CUSTOM_PACK_PATH (
        echo [WARN] Empty custom path. Using default.
        set "SELECTED_PACK_PATH=!DEFAULT_PACK_PATH!"
    ) else (
        call :ResolveAbsolutePath "!CUSTOM_PACK_PATH!" SELECTED_PACK_PATH
    )
    goto :PromptDataPackPathDone
)

echo [WARN] Invalid option. Using default.
set "SELECTED_PACK_PATH=!DEFAULT_PACK_PATH!"

:PromptDataPackPathDone
endlocal & set "%~2=%SELECTED_PACK_PATH%" & exit /b 0

:NormalizePortInput
setlocal EnableDelayedExpansion
set "raw=%~1"
set "defaultPort=%~2"

for /f "tokens=* delims= " %%A in ("!raw!") do set "raw=%%~A"
if not defined raw set "raw=!defaultPort!"

set "bad="
for /f "delims=0123456789" %%A in ("!raw!") do set "bad=%%A"
if defined bad (
    endlocal
    exit /b 1
)

set /a portValue=!raw!+0 >nul 2>&1
if errorlevel 1 (
    endlocal
    exit /b 1
)

if !portValue! LSS 1 (
    endlocal
    exit /b 1
)
if !portValue! GTR 65535 (
    endlocal
    exit /b 1
)

endlocal & set "%~3=%raw%" & exit /b 0

:ResolveAbsolutePath
setlocal EnableDelayedExpansion
set "raw=%~1"
set "resolved="

if not defined raw (
    set "resolved=%PROJECT_ROOT%"
) else (
    if /I "!raw:~0,2!"=="\\" (
        set "resolved=!raw!"
    ) else (
        if /I "!raw:~1,1!"==":" (
            set "resolved=!raw!"
        ) else (
            set "resolved=%PROJECT_ROOT%\!raw!"
        )
    )
)

endlocal & set "%~2=%resolved%" & exit /b 0

:TrackInstance
set "trackPort=%~1"
set "trackPath=%~2"
set "trackKind=%~3"
set "newPortList="
for %%P in (%ACTIVE_INSTANCE_PORTS%) do (
    if /I not "%%P"=="%trackPort%" set "newPortList=!newPortList! %%P"
)
set "ACTIVE_INSTANCE_PORTS=%trackPort% %newPortList%"
for /f "tokens=1,2,3,4,5" %%A in ("%ACTIVE_INSTANCE_PORTS%") do set "ACTIVE_INSTANCE_PORTS=%%A %%B %%C %%D %%E"
set "INSTANCE_DATA_%trackPort%=%trackPath%"
set "INSTANCE_KIND_%trackPort%=%trackKind%"
set "LAST_USED_PACK_PATH=%trackPath%"
call :PersistLastUsedPackPath "%trackPath%"
call :PersistLastUsedPort "%trackPort%"
exit /b 0

:ShowTrackedInstances
echo Tracked data-packs in this launcher session ^(up to 5^):
if "%ACTIVE_INSTANCE_PORTS%"=="" (
    echo   - none yet
    exit /b 0
)

for %%P in (%ACTIVE_INSTANCE_PORTS%) do (
    call set "entryPath=%%INSTANCE_DATA_%%P%%"
    call set "entryKind=%%INSTANCE_KIND_%%P%%"
    if defined entryPath (
        echo   - Port %%P ^| !entryKind! ^| !entryPath!
    )
)
exit /b 0
