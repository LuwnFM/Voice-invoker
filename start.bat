@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1 || goto error
where npm >nul 2>&1 || goto error
if not exist node_modules\.bin\electron.cmd (
  call npm ci
  if errorlevel 1 goto error
)
powershell.exe -NoProfile -File "%~dp0setup-dota.ps1" -Launch
if errorlevel 1 goto error
call npm start
if errorlevel 1 goto error
exit /b 0
:error
echo Setup failed. Check Node.js, dependencies, Steam and PowerShell output.
pause
exit /b 1
