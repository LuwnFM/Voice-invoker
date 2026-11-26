@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -File "%~dp0setup-dota.ps1" -Uninstall
if errorlevel 1 (
  pause
  exit /b 1
)
pause
