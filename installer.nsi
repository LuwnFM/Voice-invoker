Unicode true
!include "LogicLib.nsh"
Name "Voice Invoker ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\VoiceInvoker"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles
!macro RequireClosed
  nsExec::ExecToStack /TIMEOUT=15000 'powershell.exe -NoProfile -NonInteractive -Command "if (Get-Process -Name VoiceInvoker -ErrorAction SilentlyContinue) { exit 1 }"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    MessageBox MB_ICONEXCLAMATION "Close Voice Invoker from the system tray before continuing."
    Abort
  ${EndIf}
!macroend
Section "Install"
  !insertmacro RequireClosed
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r /x config.json /x model "${STAGE}\*"
  SetOverwrite off
  SetOutPath "$INSTDIR\resources\app"
  File "${STAGE}\resources\app\config.json"
  SetOutPath "$INSTDIR\resources\app\model"
  File "${STAGE}\resources\app\model\vosk-model-small-ru-invoker.tar.gz"
  SetOverwrite on
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Voice Invoker"
  CreateShortcut "$SMPROGRAMS\Voice Invoker\Voice Invoker.lnk" "$INSTDIR\Start Voice Invoker.bat" "" "$INSTDIR\VoiceInvoker.exe"
  CreateShortcut "$SMPROGRAMS\Voice Invoker\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvoker" "DisplayName" "Voice Invoker"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvoker" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvoker" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd
Section "Uninstall"
  !insertmacro RequireClosed
  IfFileExists "$INSTDIR\resources\app\.dota-install.json" 0 skipGsi
  ExecWait 'powershell.exe -NoProfile -File "$INSTDIR\resources\app\setup-dota.ps1" -Uninstall' $0
  ${If} $0 != "0"
    MessageBox MB_ICONEXCLAMATION "Could not restore the GSI backup. Nothing removed."
    Abort
  ${EndIf}
  skipGsi:
  !include "${REMOVEFILES}"
  Delete "$SMPROGRAMS\Voice Invoker\Voice Invoker.lnk"
  Delete "$SMPROGRAMS\Voice Invoker\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Voice Invoker"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvoker"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
