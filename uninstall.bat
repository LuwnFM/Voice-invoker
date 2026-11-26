@echo off
cd /d "%~dp0"
call setup-run.bat -Uninstall
if errorlevel 1 (
  pause
  exit /b 1
)
pause
