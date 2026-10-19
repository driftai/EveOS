@echo off
setlocal
node "%~dp0scripts\dex-tui.js"
exit /b %ERRORLEVEL%
