Unicode true
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "MUI2.nsh"
!include "Sections.nsh"
Name "Voice Invoker Installer ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\VoiceInvoker"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvoker" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ICON "${ICONFILE}"
!define MUI_UNICON "${ICONFILE}"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Запустить Voice Invoker и Dota 2"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchVoiceInvoker
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"
Function LaunchVoiceInvoker
  SetOutPath "$INSTDIR"
  ExecShell "open" "$INSTDIR\VoiceInvoker-Launcher.exe"
FunctionEnd
!macro RequireClosed
  nsExec::ExecToStack /TIMEOUT=15000 'powershell.exe -NoProfile -NonInteractive -Command "if (Get-Process -Name VoiceInvoker,VoiceInvoker-Launcher -ErrorAction SilentlyContinue) { exit 1 }"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    MessageBox MB_ICONEXCLAMATION "Закрой Voice Invoker через системный трей перед продолжением." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend
!macro Maintenance MODE
  nsExec::ExecToStack /TIMEOUT=180000 '"$PLUGINSDIR\VoiceInvoker-Launcher.exe" --${MODE} "$INSTDIR" "$PLUGINSDIR"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP "Не удалось выполнить проверку установки. Подробности: %APPDATA%\VoiceInvoker\installer.log. Пользовательские настройки не удалены." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend
Section "Voice Invoker (обязательно)" SecMain
  SectionIn RO
  !insertmacro RequireClosed
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${STAGE}\VoiceInvoker-Launcher.exe"
  File "${PACKAGEMANIFEST}"
  !insertmacro Maintenance prepare
  SetOverwrite on
  !include "${COPYFILES}"
  SetOverwrite off
  SetOutPath "$INSTDIR\resources\app"
  File "${STAGE}\resources\app\config.json"
  SetOverwrite on
  !insertmacro Maintenance finalize
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Voice Invoker"
  CreateShortcut "$SMPROGRAMS\Voice Invoker\Voice Invoker.lnk" "$INSTDIR\VoiceInvoker-Launcher.exe" "" "$INSTDIR\VoiceInvoker-Launcher.exe"
  CreateShortcut "$DESKTOP\Voice Invoker.lnk" "$INSTDIR\VoiceInvoker-Launcher.exe" "" "$INSTDIR\VoiceInvoker-Launcher.exe"
  CreateShortcut "$SMPROGRAMS\Voice Invoker\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvoker" "DisplayName" "Voice Invoker"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvoker" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvoker" "DisplayIcon" "$INSTDIR\VoiceInvoker-Launcher.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvoker" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvoker" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd
Section /o "Автозапуск Voice Invoker с Windows (без запуска Dota)" SecAuto
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VoiceInvoker" '"$INSTDIR\VoiceInvoker-Launcher.exe" --no-dota'
SectionEnd
Section "-Autostart cleanup"
  ${IfNot} ${SectionIsSelected} ${SecAuto}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VoiceInvoker"
  ${EndIf}
SectionEnd
Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Voice Invoker requires Windows x64."
    SetErrorLevel 1
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "Voice Invoker requires Windows 10 or later."
    SetErrorLevel 1
    Abort
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VoiceInvoker"
  ${If} $0 != ""
    !insertmacro SelectSection ${SecAuto}
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvoker" "InstallLocation"
  ${If} $0 != ""
  ${AndIf} $0 != $INSTDIR
    IfFileExists "$0\resources\app\package.json" 0 noOldInstall
    MessageBox MB_ICONSTOP "Найдена другая зарегистрированная установка Voice Invoker. Обновляй её в исходной папке, чтобы сохранить резервную копию GSI." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  noOldInstall:
  IfSilent done
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvoker" "DisplayVersion"
  ${If} $0 == "${VERSION}"
    IfFileExists "$INSTDIR\VoiceInvoker-Launcher.exe" 0 done
    MessageBox MB_YESNOCANCEL|MB_ICONQUESTION "Версия ${VERSION} уже установлена.$\r$\nДа — запустить приложение.$\r$\nНет — проверить и восстановить файлы или изменить автозапуск.$\r$\nОтмена — выйти." /SD IDCANCEL IDYES launch IDNO done
    Quit
    launch:
      Call LaunchVoiceInvoker
      Quit
  ${EndIf}
  done:
FunctionEnd
Function un.onInit
  SetShellVarContext current
FunctionEnd
Section "Uninstall"
  !insertmacro RequireClosed
  IfFileExists "$INSTDIR\resources\app\.dota-install.json" 0 skipGsi
  ExecWait 'powershell.exe -NoProfile -File "$INSTDIR\resources\app\setup-dota.ps1" -Uninstall' $0
  ${If} $0 != "0"
    MessageBox MB_ICONEXCLAMATION "Could not restore the GSI backup. Nothing removed." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  skipGsi:
  !include "${REMOVEFILES}"
  Delete "$INSTDIR\install-manifest.json"
  Delete "$SMPROGRAMS\Voice Invoker\Voice Invoker.lnk"
  Delete "$SMPROGRAMS\Voice Invoker\Uninstall.lnk"
  Delete "$DESKTOP\Voice Invoker.lnk"
  RMDir "$SMPROGRAMS\Voice Invoker"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VoiceInvoker"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvoker"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
