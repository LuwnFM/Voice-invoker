@echo off
setlocal
cd /d "%~dp0"
set "VI_SETUP=%~dp0setup-dota.ps1"
powershell.exe -NoProfile -NonInteractive -Command "if (Get-Item -LiteralPath $env:VI_SETUP -Stream Zone.Identifier -ErrorAction SilentlyContinue) { exit 10 }"
if "%errorlevel%"=="10" (
  echo Windows marked setup-dota.ps1 as downloaded from the Internet.
  echo Only continue if you trust this Voice Invoker release.
  choice /C YN /M "Unblock this script only"
  if errorlevel 2 exit /b 1
  powershell.exe -NoProfile -NonInteractive -Command "Unblock-File -LiteralPath $env:VI_SETUP -ErrorAction Stop"
  if errorlevel 1 exit /b 1
)
powershell.exe -NoProfile -File "%VI_SETUP%" %*
if errorlevel 1 (
  echo Setup failed. Check PowerShell policy and permissions.
  echo Get-ExecutionPolicy -List
  exit /b 1
)
exit /b 0
