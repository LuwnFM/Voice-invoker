@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal
set "ELECTRON_SKIP_BINARY_DOWNLOAD="
set "ELECTRON_OVERRIDE_DIST_PATH="
set "ELECTRON_RUN_AS_NODE="
if exist "%~dp0..\..\VoiceInvoker.exe" goto packaged
where node >nul 2>&1 || goto missing_node
where npm >nul 2>&1 || goto missing_node
node scripts\ensure-runtime.js
if errorlevel 1 goto error
call setup-run.bat -Launch -NoPrompt
if errorlevel 1 (
  echo Dota/GSI setup failed. Opening diagnostics instead of closing.
  set "VI_SETUP_FAILED=1"
  set "VI_REOPEN_SETTINGS=1"
)
node scripts\launch.js --background
if errorlevel 1 goto error
exit /b 0
:packaged
set "VI_PACKAGED=1"
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\VoiceInvoker.exe" scripts\check-packaged-runtime.js
if errorlevel 1 goto packaged_error
call setup-run.bat -Launch -NoPrompt
if errorlevel 1 (
  echo Dota/GSI setup failed. Opening diagnostics instead of closing.
  set "VI_SETUP_FAILED=1"
  set "VI_REOPEN_SETTINGS=1"
)
set "VI_PACKAGED=1"
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\VoiceInvoker.exe" scripts\launch.js --background
if errorlevel 1 goto packaged_error
exit /b 0
:missing_node
echo Source build requires Node.js 22.12+ x64 with npm.
choice /C YN /M "Open the official Node.js download page"
if not errorlevel 2 start "" "https://nodejs.org/en/download"
exit /b 1
:packaged_error
echo Installed runtime failed. Reinstall the current VoiceInvoker-Installer EXE. System Node.js is not needed.
if not defined VI_LIFECYCLE_DIR powershell.exe -NoProfile -NonInteractive -Command "$w=New-Object -ComObject WScript.Shell; $null=$w.Popup('The bundled runtime failed. Reinstall Voice Invoker from the official release. System Node.js is not required.',30,'Voice Invoker',16)"
exit /b 1
:error
echo Setup failed. See the exact error above. Source build: Node.js 22 or 26 x64 (22 recommended).
if not defined VI_LIFECYCLE_DIR pause
exit /b 1
