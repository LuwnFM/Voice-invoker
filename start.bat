@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal
set "ELECTRON_SKIP_BINARY_DOWNLOAD="
set "ELECTRON_OVERRIDE_DIST_PATH="
set "ELECTRON_RUN_AS_NODE="
if exist "%~dp0..\..\VoiceInvoker.exe" goto packaged
where node >nul 2>&1 || goto error
where npm >nul 2>&1 || goto error
node scripts\ensure-runtime.js
if errorlevel 1 goto error
call setup-run.bat -Launch
if errorlevel 1 goto error
node scripts\launch.js --background
if errorlevel 1 goto error
exit /b 0
:packaged
call setup-run.bat -Launch
if errorlevel 1 goto error
set "VI_PACKAGED=1"
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\VoiceInvoker.exe" scripts\launch.js --background
if errorlevel 1 goto error
exit /b 0
:error
echo Setup failed. See the exact error above. Node.js 22 x64 is recommended.
pause
exit /b 1
