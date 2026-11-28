Unicode true
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "MUI2.nsh"
Name "Voice Invoker Native ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\VoiceInvokerNative"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ICON "${ICONFILE}"
!define MUI_UNICON "${ICONFILE}"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_RUN_TEXT "Start native test mode (no game input)"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchTest
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Windows x64 required." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "Windows 10 or later required." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
FunctionEnd
Function LaunchTest
  SetOutPath "$INSTDIR"
  Exec '"$INSTDIR\voice-invoker-native.exe" launch'
FunctionEnd
!macro RequireClosed
  System::Call 'kernel32::OpenMutexW(i 0x00100000, i 0, w "Local\VoiceInvokerNativeSession") p.r0'
  ${If} $0 != 0
    System::Call 'kernel32::CloseHandle(p r0)'
    MessageBox MB_ICONEXCLAMATION "Close Voice Invoker Native before continuing." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
Section "Install"
  !insertmacro RequireClosed
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${STAGE}\*"
  nsExec::ExecToStack /TIMEOUT=120000 '"$INSTDIR\voice-invoker-native.exe" check-install'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP "Native runtime or V2 verification failed. $1" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Voice Invoker Native"
  CreateShortcut "$SMPROGRAMS\Voice Invoker Native\Voice Invoker Native.lnk" "$INSTDIR\voice-invoker-native.exe" "launch --live --dota"
  CreateShortcut "$SMPROGRAMS\Voice Invoker Native\Test recognition.lnk" "$INSTDIR\voice-invoker-native.exe" "launch"
  CreateShortcut "$SMPROGRAMS\Voice Invoker Native\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvokerNative" "DisplayName" "Voice Invoker Native"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvokerNative" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvokerNative" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd
Section "Uninstall"
  !insertmacro RequireClosed
  ExecWait '"$INSTDIR\voice-invoker-native.exe" gsi-remove' $0
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP "Could not restore GSI; backup and installation kept." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  !include "${REMOVEFILES}"
  Delete "$SMPROGRAMS\Voice Invoker Native\Voice Invoker Native.lnk"
  Delete "$SMPROGRAMS\Voice Invoker Native\Test recognition.lnk"
  Delete "$SMPROGRAMS\Voice Invoker Native\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Voice Invoker Native"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VoiceInvokerNative"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
