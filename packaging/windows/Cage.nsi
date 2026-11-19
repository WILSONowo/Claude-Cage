Unicode true
RequestExecutionLevel user
; Per-file decompression avoids a full payload copy in the system TEMP drive.
SetCompressor lzma
SetCompressorDictSize 32
ManifestDPIAware true
ManifestSupportedOS all

!include MUI2.nsh
!define MUI_ICON "Cage.ico"
!define MUI_UNICON "Cage.ico"
!include LogicLib.nsh
!include FileFunc.nsh
!include x64.nsh
!include WinVer.nsh
!include nsDialogs.nsh

!ifndef APP_DIR
  !error "APP_DIR is required"
!endif
!ifndef VERSION
  !error "VERSION is required"
!endif
!ifndef VERSION_NUMERIC
  !error "VERSION_NUMERIC is required"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif

!define APP_ID "io.github.lee-xeo.claude-cage"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClaudeCage"
!define WEBVIEW2_APP_ID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
Name "Cage ${VERSION}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Cage"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
VIProductVersion "${VERSION_NUMERIC}"
VIAddVersionKey /LANG=1033 "ProductName" "Cage"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "Cage Windows Installer"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Cage contributors"

!ifdef SIGN_SCRIPT
  !uninstfinalize '"${SIGN_PWSH}" -NoProfile -File "${SIGN_SCRIPT}" -Path "%1"' = 0
!endif

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Cage.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_TEXT "Cage is installed.$\r$\n$\r$\nIf virtualization is unavailable, enable Windows Hypervisor Platform in Windows Features and restart Windows. Your projects and Cage data are preserved during upgrades and uninstall."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${APP_DIR}/LICENSE.txt"
!define MUI_DIRECTORYPAGE_TEXT_TOP "$(CageDirectoryHelp)"
!insertmacro MUI_PAGE_DIRECTORY
Page custom ShortcutOptionsPage ShortcutOptionsLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

LangString CageDirectoryHelp ${LANG_ENGLISH} "Choose where to install the Cage application. On first launch, you can choose a separate drive for the Linux image, download cache, and virtual disks before starting the environment."
LangString CageDirectoryHelp ${LANG_SIMPCHINESE} "请选择 Cage 程序的安装目录。首次打开 Cage 后，可以在启动环境前单独选择存放 Linux 镜像、下载缓存和虚拟磁盘的磁盘。"
LangString CageShortcutsTitle ${LANG_ENGLISH} "Shortcuts"
LangString CageShortcutsTitle ${LANG_SIMPCHINESE} "快捷方式"
LangString CageShortcutsHelp ${LANG_ENGLISH} "Choose where to add Cage shortcuts for your Windows account."
LangString CageShortcutsHelp ${LANG_SIMPCHINESE} "选择为当前 Windows 用户添加的 Cage 快捷方式。"
LangString CageDesktopShortcut ${LANG_ENGLISH} "Add a desktop shortcut"
LangString CageDesktopShortcut ${LANG_SIMPCHINESE} "添加桌面快捷方式"
LangString CageStartMenuShortcuts ${LANG_ENGLISH} "Add to the Start menu"
LangString CageStartMenuShortcuts ${LANG_SIMPCHINESE} "添加到开始菜单"
LangString CageConfirmStop ${LANG_ENGLISH} "Stop the local Cage environment and continue installing? Running terminal tasks will end. Save your work before continuing."
LangString CageConfirmStop ${LANG_SIMPCHINESE} "停止本地 Cage 环境并继续安装？运行中的终端任务会结束，请先保存工作。"

!include "CageInstallerOptions.nsh"
Var StageDir
Var BackupDir
Var ExistingInstall
Var DesktopShortcutControl
Var StartMenuShortcutsControl
Var InstallationMutex
Var TransactionRecord
Var InstallPhase
Var InstallOutcome
Var HelperExit
Var DiagnosticArguments
Var CloseBackend
Var CloseHelperDir
Var CloseProof
Var CloseInteractive
Var ClosePipe
Var BrokerPid

Function WriteInstallDiagnostic
  ${If} $DiagnosticFile != ""
    Push $2
    Push $3
    StrCpy $3 0
    IfErrors 0 +2
      StrCpy $3 1
    ClearErrors
    FileOpen $2 "$DiagnosticFile" w
    ${IfNot} ${Errors}
      FileWrite $2 '{"phase":"$InstallPhase","status":"$InstallOutcome","helperExit":"$HelperExit"}$\r$\n'
      FileClose $2
    ${EndIf}
    ${If} $3 == 1
      SetErrors
    ${Else}
      ClearErrors
    ${EndIf}
    Pop $3
    Pop $2
  ${EndIf}
FunctionEnd

!macro InstallPhase NAME
  StrCpy $InstallPhase "${NAME}"
  Call WriteInstallDiagnostic
!macroend

Function un.WriteInstallDiagnostic
  ${If} $DiagnosticFile != ""
    Push $2
    Push $3
    StrCpy $3 0
    IfErrors 0 +2
      StrCpy $3 1
    ClearErrors
    FileOpen $2 "$DiagnosticFile" w
    ${IfNot} ${Errors}
      FileWrite $2 '{"phase":"$InstallPhase","status":"$InstallOutcome","helperExit":"$HelperExit"}$\r$\n'
      FileClose $2
    ${EndIf}
    ${If} $3 == 1
      SetErrors
    ${Else}
      ClearErrors
    ${EndIf}
    Pop $3
    Pop $2
  ${EndIf}
FunctionEnd

!macro UninstallPhase NAME
  StrCpy $InstallPhase "${NAME}"
  Call un.WriteInstallDiagnostic
!macroend

!macro ReleaseInstallationMutex
  ${If} $InstallationMutex != ""
    System::Call 'kernel32::CloseHandle(p $InstallationMutex)'
    StrCpy $InstallationMutex ""
  ${EndIf}
!macroend

Function un.onUninstFailed
  StrCpy $InstallOutcome "failed"
  Call un.WriteInstallDiagnostic
FunctionEnd

Function un.onUninstSuccess
  StrCpy $InstallOutcome "success"
  !insertmacro UninstallPhase "completed"
FunctionEnd

Function .onInstFailed
  Call CloseBroker
  StrCpy $InstallOutcome "failed"
  Call WriteInstallDiagnostic
FunctionEnd

Function .onInstSuccess
  Call CloseBroker
  StrCpy $InstallOutcome "success"
  Call WriteInstallDiagnostic
FunctionEnd

!macro AbortTransaction MESSAGE
  !insertmacro ReleaseInstallationMutex
  Abort "${MESSAGE}"
!macroend

!macro AcquireInstallationMutex
  ; NSIS and UpdateInstaller both reject an existing named object and keep
  ; their handle until the transaction ends. No caller waits for ownership.
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Global\Cage.Installation") p.r0 ?e'
  Pop $1
  ${If} $0 == 0
    SetErrorLevel 2
    !insertmacro AbortTransaction "无法锁定 Cage 安装操作，请核对系统权限后重试。"
  ${EndIf}
  StrCpy $InstallationMutex $0
  ${If} $1 == 183
    SetErrorLevel 2
    !insertmacro AbortTransaction "另一个 Cage 安装或卸载仍在进行，请等待完成后重试。"
  ${EndIf}
!macroend

Function .onGUIEnd
  Call CloseBroker
  !insertmacro ReleaseInstallationMutex
FunctionEnd

Function un.onGUIEnd
  !insertmacro ReleaseInstallationMutex
FunctionEnd

Function LoadShortcutOptions
  ; Fresh installs enable both entries. Older installs inherit actual shortcuts.
  StrCpy $DesktopShortcut 1
  StrCpy $StartMenuShortcuts 1
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 != ""
    StrCpy $DesktopShortcut 0
    StrCpy $StartMenuShortcuts 0
    ${If} ${FileExists} "$DESKTOP\Cage.lnk"
      StrCpy $DesktopShortcut 1
    ${EndIf}
    ${If} ${FileExists} "$SMPROGRAMS\Cage\Cage.lnk"
      StrCpy $StartMenuShortcuts 1
    ${EndIf}
  ${EndIf}
  ClearErrors
  ReadRegDWORD $0 HKCU "${UNINSTALL_KEY}" "DesktopShortcut"
  ${IfNot} ${Errors}
    StrCpy $DesktopShortcut $0
  ${EndIf}
  ClearErrors
  ReadRegDWORD $0 HKCU "${UNINSTALL_KEY}" "StartMenuShortcuts"
  ${IfNot} ${Errors}
    StrCpy $StartMenuShortcuts $0
  ${EndIf}
FunctionEnd

Function ShortcutOptionsPage
  !insertmacro MUI_HEADER_TEXT "$(CageShortcutsTitle)" "$(CageShortcutsHelp)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 8u 100% 16u "$(CageDesktopShortcut)"
  Pop $DesktopShortcutControl
  ${NSD_SetState} $DesktopShortcutControl $DesktopShortcut
  ${NSD_CreateCheckbox} 0 36u 100% 16u "$(CageStartMenuShortcuts)"
  Pop $StartMenuShortcutsControl
  ${NSD_SetState} $StartMenuShortcutsControl $StartMenuShortcuts
  ${NSD_OnBack} ShortcutOptionsLeave
  nsDialogs::Show
FunctionEnd

Function ShortcutOptionsLeave
  ${NSD_GetState} $DesktopShortcutControl $DesktopShortcut
  ${NSD_GetState} $StartMenuShortcutsControl $StartMenuShortcuts
FunctionEnd

Function SetDefaultInstallDirectory
  ${If} $CageInstallDirectory != ""
    StrCpy $INSTDIR $CageInstallDirectory
    Return
  ${EndIf}
  ; Keep upgrades in the registered location, including installations on C:.
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
    Return
  ${EndIf}
  System::Call 'kernel32::GetDriveTypeW(w "D:\") i .r0'
  ${If} $0 == 3
    StrCpy $INSTDIR "D:\Cage"
  ${EndIf}
FunctionEnd

!macro CheckStopped FILE ID INSTALL
  ${If} ${FileExists} "$INSTDIR\${FILE}"
    ; An exiting process or a scanner can retain its image after controller handoff.
    StrCpy $3 0
    check_${ID}:
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\${FILE}", i 0x40000000, i 0, p 0, i 3, i 0, p 0) p .r0 ?e'
    Pop $1
    ${If} $0 == -1
      ${If} $1 == 5
      ${OrIf} $1 == 32
      ${OrIf} $1 == 33
      ${OrIf} $1 == 1224
        ${If} $3 < 80
          ${If} $3 == 0
            DetailPrint "正在等待 ${FILE} 释放…"
          ${EndIf}
          Sleep 250
          IntOp $3 $3 + 1
          Goto check_${ID}
        ${EndIf}
      ${EndIf}
      StrCpy $HelperExit "${ID}_win32_$1"
!if ${INSTALL} == 1
      ${If} $DiagnosticFile == ""
        GetTempFileName $DiagnosticFile "$TEMP"
      ${EndIf}
      Call WriteInstallDiagnostic
      DetailPrint "安装诊断：$DiagnosticFile"
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "暂时无法替换 ${FILE}（Windows 错误 $1）。重试会再次检查并等待文件释放。" /SD IDCANCEL IDRETRY retry_replacement
      RMDir /r "$StageDir"
!else
      Call un.WriteInstallDiagnostic
!endif
      SetErrorLevel 2
      !insertmacro AbortTransaction "无法访问 ${FILE}（$HelperExit）。原安装已保留。"
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
!macroend

Function .onInit
  StrCpy $InstallOutcome "running"
  StrCpy $HelperExit ""
  SetShellVarContext current
  SetRegView 64
  Call LoadShortcutOptions
  Call ParseCageInstallOptions
  ${If} $CloseWizardPid != ""
    ; Only close Cage in this instance. The original installer retains the
    ; transaction, registration, destination and shortcut choices.
    SetErrorLevel 2
    ${If} $CageOptionError == ""
    ${AndIf} $CageInstallDirectory == ""
    ${AndIf} $DiagnosticFile == ""
    ${AndIf} $UpdateMode == "0"
      Call RunElevatedClose
      SetErrorLevel $0
    ${EndIf}
    Quit
  ${EndIf}
  ${If} $CageOptionError != ""
    StrCpy $InstallPhase "parsing_arguments"
    StrCpy $InstallOutcome "failed"
    StrCpy $HelperExit "invalid_installer_arguments"
    Call WriteInstallDiagnostic
    MessageBox MB_ICONSTOP "$CageOptionError" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $DiagnosticArguments ""
  ${If} $DiagnosticFile != ""
    StrCpy $DiagnosticArguments '-Diagnostics "$DiagnosticFile.helper.json"'
  ${EndIf}
  !insertmacro InstallPhase "initializing"
  ${IfNot} ${IsNativeAMD64}
    MessageBox MB_ICONSTOP "This Cage package requires an Intel/AMD 64-bit version of Windows. Windows on ARM and 32-bit Windows are not supported."
    SetErrorLevel 1633
    Quit
  ${EndIf}
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $0 < 19045
    MessageBox MB_ICONSTOP "Cage requires Windows 10 22H2 (build 19045) or Windows 11. Update Windows and try again."
    SetErrorLevel 1633
    Quit
  ${EndIf}
  Call SetDefaultInstallDirectory
  ${IfNot} ${Silent}
    Call StartCloseBroker
    ${If} $0 != 0
      ${If} $0 != 1223
        MessageBox MB_ICONSTOP "无法初始化 Windows 安装授权（$0）。"
      ${EndIf}
      SetErrorLevel $0
      Quit
    ${EndIf}
  ${EndIf}
FunctionEnd

Function CheckDestination
  ${GetRoot} "$INSTDIR" $0
  ${If} $0 == ""
  ${OrIf} $INSTDIR == $0
  ${OrIf} $INSTDIR == "$0\"
    SetErrorLevel 2
    !insertmacro AbortTransaction "Choose a dedicated application folder."
  ${EndIf}
  StrCpy $ExistingInstall "0"
  IfFileExists "$INSTDIR\Cage.install-id" existing
  ; IfFileExists with a wildcard also matches an empty directory.
  ${DirState} "$INSTDIR" $0
  StrCmp $0 1 foreign done
  existing:
    FileOpen $0 "$INSTDIR\Cage.install-id" r
    FileRead $0 $1
    FileClose $0
    ${If} $1 != "${APP_ID}"
      Goto foreign
    ${EndIf}
    StrCpy $ExistingInstall "1"
    Goto done
  foreign:
    SetErrorLevel 2
    !insertmacro AbortTransaction "The destination contains files from another installation. Choose an empty folder."
  done:
    ClearErrors
FunctionEnd

Function RestorePreservedFiles
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\installation-files.ps1" -Operation restore -Target "$BackupDir" -Source "$StageDir" -Receipt "$TransactionRecord" $DiagnosticArguments'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    SetErrorLevel 2
    !insertmacro AbortTransaction "安装恢复尚未完成。文件分别保留在 $BackupDir 和 $StageDir，请保留这两个目录后重试。"
  ${EndIf}
  ; The installation folder was kept, so the previous entries move back into it.
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\installation-files.ps1" -Operation attach -Target "$INSTDIR" -Source "$BackupDir" $DiagnosticArguments'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    SetErrorLevel 2
    !insertmacro AbortTransaction "原安装目录未能恢复。文件保留在 $BackupDir，新程序保留在 $StageDir。"
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\installation-files.ps1" -Operation complete -Target "$INSTDIR" -Receipt "$TransactionRecord" $DiagnosticArguments'
  Pop $0
  Pop $1
  ${If} $0 != 0
    SetErrorLevel 2
    !insertmacro AbortTransaction "仍有文件需要核对，安装回执保留在 $TransactionRecord。请保留相关目录后处理。"
  ${EndIf}
FunctionEnd

Function RunCloseWithConsent
  probe:
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$CloseHelperDir\close-installation.ps1" -Target "$INSTDIR" -Backend "$CloseBackend" $CloseProof $2'
    Pop $0
    Pop $1
    DetailPrint "$1"
    ${If} $0 == 109
    ${AndIf} $CloseInteractive == 1
    ${AndIf} $2 != "-StopEnvironment"
      ; The elevated close-only process has no wizard, but this decision must
      ; still be interactive there. Do not supply a silent default.
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2|MB_SETFOREGROUND "$(CageConfirmStop)" IDYES confirmed
      StrCpy $0 1223
      Return
      confirmed:
        StrCpy $2 "-StopEnvironment"
        Goto probe
    ${EndIf}
FunctionEnd

Function CloseBroker
  ${If} $ClosePipe != ""
    System::Call 'kernel32::CloseHandle(p $ClosePipe)'
    StrCpy $ClosePipe ""
  ${EndIf}
FunctionEnd

Function LaunchCloseBroker
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\launch"
  File /oname=close-installation.ps1 "close-installation.ps1"
  File /oname=installer-process.cs "installer-process.cs"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$OUTDIR\close-installation.ps1" -RequestElevation -WizardProcessId $3 -Installer "$EXEPATH"'
  Pop $0
  Pop $1
  SetOutPath "$TEMP"
FunctionEnd

Function StartCloseBroker
  System::Call 'shell32::IsUserAnAdmin() i.r0'
  ${If} $0 != 0
    StrCpy $0 0
    Return
  ${EndIf}
  System::Call 'kernel32::GetCurrentProcessId() i.r3'
  ; Local message pipe, first instance only. Poll only until the specific
  ; elevated installer connects, then use blocking messages on that connection.
  System::Call 'kernel32::CreateNamedPipeW(w "\\.\pipe\Cage.Setup.$3", i 0x80003, i 15, i 1, i 4096, i 4096, i 0, p 0) p.r0'
  ${If} $0 == -1
    StrCpy $0 111
    Return
  ${EndIf}
  StrCpy $ClosePipe $0
  Call LaunchCloseBroker
  ${If} $0 != 0
    Return
  ${EndIf}
  StrCpy $BrokerPid $1
  System::Call 'kernel32::OpenProcess(i 0x101000, i 0, i $BrokerPid) p.r4'
  ${If} $4 == 0
    StrCpy $0 111
    Return
  ${EndIf}
  StrCpy $5 0
  connect:
    System::Call 'kernel32::ConnectNamedPipe(p $ClosePipe, p 0) i.r0'
    System::Call 'kernel32::GetNamedPipeClientProcessId(p $ClosePipe, *i .r1) i.r0'
    ${If} $0 != 0
      ${If} $1 == $BrokerPid
        System::Call 'kernel32::SetNamedPipeHandleState(p $ClosePipe, *i 2, p 0, p 0) i.r0'
        ${If} $0 != 0
          System::Call 'kernel32::CloseHandle(p r4)'
          StrCpy $0 0
          Return
        ${EndIf}
      ${EndIf}
      System::Call 'kernel32::DisconnectNamedPipe(p $ClosePipe)'
    ${EndIf}
    System::Call 'kernel32::WaitForSingleObject(p r4, i 50) i.r0'
    IntOp $5 $5 + 1
    ${If} $0 == 258
    ${AndIf} $5 < 1200
      Goto connect
    ${EndIf}
  System::Call 'kernel32::GetExitCodeProcess(p r4, *i .r1) i.r0'
  System::Call 'kernel32::CloseHandle(p r4)'
  StrCpy $0 111
  ${If} $1 == 116
    StrCpy $0 116
  ${EndIf}
FunctionEnd

Function RequestBrokerClose
  ; The only request is an installation directory. The privileged side owns
  ; the stop confirmation, backend and script; replies are fixed-size codes.
  StrLen $2 $INSTDIR
  IntOp $2 $2 + 1
  IntOp $2 $2 * 2
  System::Call 'kernel32::WriteFile(p $ClosePipe, w "$INSTDIR", i r2, *i .r3, p 0) i.r0'
  ${If} $0 != 0
  ${AndIf} $3 == $2
    System::Call 'kernel32::ReadFile(p $ClosePipe, *i .r1, i 4, *i .r2, p 0) i.r0'
    ${If} $0 != 0
    ${AndIf} $2 == 4
      StrCpy $0 $1
      Return
    ${EndIf}
  ${EndIf}
  StrCpy $0 111
FunctionEnd

Function RunElevatedClose
  ; Extract trusted code afresh into this instance's restricted plugin
  ; directory. No executable or script is loaded from the parent's stage.
  InitPluginsDir
  ; Windows PowerShell's C# compiler resolves System.dll from its working
  ; directory. NSIS puts an unrelated native System.dll in the plugin root.
  StrCpy $CloseHelperDir "$PLUGINSDIR\shutdown"
  ClearErrors
  SetOutPath "$CloseHelperDir"
  File /oname=close-installation.ps1 "close-installation.ps1"
  File /oname=installer-process.cs "installer-process.cs"
!ifdef NSIS_WIN32_MAKENSIS
  File /oname=cage.exe "${APP_DIR}\resources\cage.exe"
!if /FileExists "${APP_DIR}\resources\client-only"
  File /oname=client-only "${APP_DIR}\resources\client-only"
!endif
!else
  File /oname=cage.exe "${APP_DIR}/resources/cage.exe"
!if /FileExists "${APP_DIR}/resources/client-only"
  File /oname=client-only "${APP_DIR}/resources/client-only"
!endif
!endif
  ${If} ${Errors}
    StrCpy $0 116
    Return
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$CloseHelperDir")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$CloseHelperDir")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "PSModulePath", w "$SYSDIR\WindowsPowerShell\v1.0\Modules")'
  StrCpy $CloseBackend "$CloseHelperDir\cage.exe"
  StrCpy $CloseProof '-WizardProcessId $CloseWizardPid -Installer "$EXEPATH"'
  StrCpy $CloseInteractive 1
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$CloseHelperDir\close-installation.ps1" -CheckWizard $CloseProof'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ${If} $0 != 116
      StrCpy $0 111
    ${EndIf}
    Return
  ${EndIf}
  ; Anonymous security QoS prevents the lower-privilege server from
  ; impersonating this client. Neither side ever reconnects to another peer.
  System::Call 'kernel32::WaitNamedPipeW(w "\\.\pipe\Cage.Setup.$CloseWizardPid", i 60000) i.r0'
  System::Call 'kernel32::CreateFileW(w "\\.\pipe\Cage.Setup.$CloseWizardPid", i 0xc0000000, i 0, p 0, i 3, i 0x100000, p 0) p.r0'
  ${If} $0 == -1
    StrCpy $0 111
    Return
  ${EndIf}
  StrCpy $ClosePipe $0
  System::Call 'kernel32::GetNamedPipeServerProcessId(p $ClosePipe, *i .r1) i.r0'
  ${If} $0 == 0
  ${OrIf} $1 != $CloseWizardPid
    Call CloseBroker
    StrCpy $0 111
    Return
  ${EndIf}
  IntOp $R8 ${NSIS_MAX_STRLEN} * 2
  StrCpy $R7 ""
  receive:
    System::Call 'kernel32::ReadFile(p $ClosePipe, w .r1, i R8, *i .r2, p 0) i.r0'
    ${If} $0 == 0
      Goto finished
    ${EndIf}
    StrLen $3 $1
    IntOp $3 $3 + 1
    IntOp $3 $3 * 2
    ${If} $3 != $2
    ${OrIf} $1 == ""
      Goto finished
    ${EndIf}
    ; Retrying a failed close may only target the original directory.
    ${If} $R7 == ""
      StrCpy $R7 $1
    ${EndIf}
    StrCpy $INSTDIR $1
    StrCpy $0 111
    ${If} $INSTDIR == $R7
    ${AndIf} ${FileExists} "$INSTDIR\Cage.install-id"
      StrCpy $2 "-CloseIdleClient"
      Call RunCloseWithConsent
    ${EndIf}
    ; nsExec launch errors are words; never serialize them as success.
    ${If} $0 == "error"
    ${OrIf} $0 == "timeout"
      StrCpy $0 110
    ${EndIf}
    System::Call 'kernel32::WriteFile(p $ClosePipe, *i r0, i 4, *i .r1, p 0) i.r2'
    ${If} $2 != 0
    ${AndIf} $1 == 4
      Goto receive
    ${EndIf}
  finished:
  Call CloseBroker
  SetOutPath "$SYSDIR"
  StrCpy $0 0
FunctionEnd

Function PrepareReplacement
  !insertmacro InstallPhase "closing_target_application"
  DetailPrint "正在准备关闭本地环境和 Cage…"
  retry_close:
    StrCpy $CloseHelperDir "$PLUGINSDIR"
    StrCpy $CloseBackend "$StageDir\resources\cage.exe"
    StrCpy $CloseProof ""
    StrCpy $CloseInteractive 0
    StrCpy $2 ""
    ${If} $UpdateMode == "1"
      StrCpy $2 "-StopEnvironment"
    ${ElseIfNot} ${Silent}
      StrCpy $2 "-CloseIdleClient"
      StrCpy $CloseInteractive 1
    ${EndIf}
    ${If} $ClosePipe != ""
      Call RequestBrokerClose
    ${Else}
      Call RunCloseWithConsent
    ${EndIf}
    StrCpy $HelperExit $0
    ${If} $0 == 1223
      SetErrorLevel 1223
      RMDir /r "$StageDir"
      !insertmacro AbortTransaction "已取消升级，原安装已保留。"
    ${EndIf}
    ${If} $0 == 0
      Return
    ${EndIf}
    ${If} $0 == 109
      DetailPrint "本地环境仍在运行。请打开安装向导，或在静默升级时使用 /UPDATE。"
    ${ElseIf} $0 == 111
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "检测到其他配置或安装的 Cage 后台进程。请确认对应环境已退出后重试。" /SD IDCANCEL IDRETRY retry_close
    ${ElseIf} $0 == 112
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "此安装仍有虚拟机在运行。请保存文件并停止 Cage 环境，然后重试。" /SD IDCANCEL IDRETRY retry_close
    ${ElseIf} $0 == 113
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "无法确认代理进程归属。请关闭占用此安装 resources\mihomo.exe 的代理，然后重试。" /SD IDCANCEL IDRETRY retry_close
    ${ElseIf} $0 == 115
      DetailPrint "正在运行的 Cage 需要管理员权限。请使用交互式安装向导，或在同一账户的管理员会话中静默升级。"
    ${ElseIf} $0 == 114
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Windows 拒绝了关闭请求。请使用运行 Cage 的同一账户和权限重新打开安装程序。" /SD IDCANCEL IDRETRY retry_close
    ${ElseIf} $0 == 116
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "安装程序无法加载进程检测组件（116）。请重新打开安装包。" /SD IDCANCEL IDRETRY retry_close
    ${ElseIf} $0 == 117
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "尚未确认环境已正常停止，安装已暂停。请在 Cage 的操作详情中查看停止结果，再重试。" /SD IDCANCEL IDRETRY retry_close
    ${Else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Cage 尚未完成关闭。请重试；如仍失败，请查看安装详情（$0）。" /SD IDCANCEL IDRETRY retry_close
    ${EndIf}
    Call WriteInstallDiagnostic
    SetErrorLevel 2
    RMDir /r "$StageDir"
    !insertmacro AbortTransaction "Cage 未关闭，原安装已保留。"
FunctionEnd

Section "Cage" Main
  !insertmacro InstallPhase "acquiring_installation_lock"
  !insertmacro AcquireInstallationMutex
  StrCpy $TransactionRecord "$INSTDIR.cage-installation.json"
  ${If} ${FileExists} "$TransactionRecord"
    SetErrorLevel 2
    !insertmacro AbortTransaction "存在未处理的安装事务记录：$TransactionRecord。请先按记录恢复保留的目录，再重试。"
  ${EndIf}
  !insertmacro InstallPhase "checking_destination"
  Call CheckDestination
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=close-installation.ps1 "close-installation.ps1"
  File /oname=installer-process.cs "installer-process.cs"
  File /oname=installation-files.ps1 "installation-files.ps1"
  File /oname=verified-file-deletion.cs "verified-file-deletion.cs"
  SetOutPath "$TEMP"
  ${If} $ExistingInstall == "1"
    !insertmacro InstallPhase "checking_bound_vm_location"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\installation-files.ps1" -Operation check-vm-location -Target "$INSTDIR" $DiagnosticArguments'
    Pop $0
    Pop $1
    ${If} $0 != 0
      StrCpy $HelperExit $0
      Call WriteInstallDiagnostic
      DetailPrint "$1"
      SetErrorLevel 2
      ${If} $0 == 108
        MessageBox MB_OK|MB_ICONEXCLAMATION "此程序目录中有已绑定的 Windows 虚拟机。请重新运行安装包，选择另一个空目录安装 Cage。保留原目录和虚拟磁盘，勿运行旧卸载程序。" /SD IDOK
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "无法确认现有 Windows 虚拟机的位置。请将新版 Cage 安装到另一个空目录，并保留原目录。" /SD IDOK
      ${EndIf}
      !insertmacro AbortTransaction "请保留原目录，并将新程序安装到另一个空目录。"
    ${EndIf}
  ${EndIf}
  ${GetParent} "$INSTDIR" $0
  CreateDirectory "$0"
  GetTempFileName $StageDir "$0"
  Delete "$StageDir"
  CreateDirectory "$StageDir"
  !insertmacro InstallPhase "unpacking_application"
  SetOutPath "$StageDir"
  ClearErrors
!ifdef NSIS_WIN32_MAKENSIS
  File /r "${APP_DIR}\*"
!else
  File /r "${APP_DIR}/*"
!endif
  WriteUninstaller "$StageDir\Uninstall.exe"
  ${If} ${Errors}
    SetOutPath "$TEMP"
    RMDir /r "$StageDir"
    SetErrorLevel 2
    !insertmacro AbortTransaction "Could not unpack Cage. Check free disk space and folder permissions."
  ${EndIf}

  ; Install the bundled offline runtime only when WebView2 is absent.
  !insertmacro InstallPhase "detecting_webview_runtime"
  SetRegView 32
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_APP_ID}" "pv"
  ReadRegStr $1 HKCU "Software\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_APP_ID}" "pv"
  SetRegView 64
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ${If} $1 == ""
    ${OrIf} $1 == "0.0.0.0"
      DetailPrint "Installing the bundled Microsoft WebView2 runtime..."
      !insertmacro InstallPhase "installing_webview_runtime"
      ExecWait '"$StageDir\resources\runtime\MicrosoftEdgeWebView2RuntimeInstallerX64.exe" /silent /install' $0
      StrCpy $HelperExit $0
      Call WriteInstallDiagnostic
      ${If} $0 != 0
        SetOutPath "$TEMP"
        RMDir /r "$StageDir"
        SetErrorLevel 2
        !insertmacro AbortTransaction "Microsoft WebView2 installation failed ($0). Install the runtime and retry."
      ${EndIf}
    ${EndIf}
  ${EndIf}

  SetOutPath "$TEMP"
  StrCpy $BackupDir ""
  ${If} $ExistingInstall == "1"
    retry_replacement:
    Call PrepareReplacement
    !insertmacro InstallPhase "checking_stopped_processes"
    !insertmacro CheckStopped "Cage.exe" desktop 1
    !insertmacro CheckStopped "resources\cage.exe" backend 1
    !insertmacro CheckStopped "resources\mihomo.exe" proxy 1
    !insertmacro CheckStopped "resources\runtime\qemu\qemu-system-x86_64.exe" vm 1
    ${GetParent} "$INSTDIR" $0
    GetTempFileName $BackupDir "$0"
    Delete "$BackupDir"
  ${EndIf}
  DetailPrint "正在检查并保留已有项目和修改文件…"
  !insertmacro InstallPhase "preparing_file_transaction"
  ; CageData is the default storage of a packaged Windows installation. It
  ; stays in place: a VM registered on it keeps its paths and open handles.
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\installation-files.ps1" -Operation prepare -Target "$StageDir" -Source "$INSTDIR" -Backup "$BackupDir" -Receipt "$TransactionRecord" -KeepInPlace CageData $DiagnosticArguments'
  Pop $0
  Pop $1
  StrCpy $HelperExit $0
  Call WriteInstallDiagnostic
  DetailPrint "$1"
  ${If} $0 != 0
    SetOutPath "$TEMP"
    RMDir /r "$StageDir"
    SetErrorLevel 2
    !insertmacro AbortTransaction "无法安全保留现有文件，安装已停止。原安装目录已保留，请检查磁盘空间、文件占用和安装日志。"
  ${EndIf}
  SetOutPath "$TEMP"
  ${If} $ExistingInstall == "1"
    !insertmacro InstallPhase "moving_previous_application"
    ; The installation folder itself stays; only its program and personal
    ; entries move, so kept data and open handles below it are untouched.
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\installation-files.ps1" -Operation detach -Target "$BackupDir" -Source "$INSTDIR" -Receipt "$TransactionRecord" $DiagnosticArguments'
    Pop $0
    Pop $1
    StrCpy $HelperExit $0
    Call WriteInstallDiagnostic
    ${If} $0 != 0
      DetailPrint "$1"
      ${If} $0 == 3
        SetErrorLevel 2
        !insertmacro AbortTransaction "部分旧文件未能移回。请保留 $BackupDir、$StageDir 和 $TransactionRecord 以便恢复。"
      ${EndIf}
      nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\installation-files.ps1" -Operation complete -Target "$INSTDIR" -Receipt "$TransactionRecord" $DiagnosticArguments'
      Pop $0
      Pop $1
      RMDir /r "$StageDir"
      SetErrorLevel 2
      !insertmacro AbortTransaction "无法替换旧程序文件。请关闭占用文件的程序后重试。"
    ${EndIf}
    DetailPrint "正在迁入个人文件并保留原有链接…"
    !insertmacro InstallPhase "moving_personal_files"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\installation-files.ps1" -Operation move -Target "$StageDir" -Source "$BackupDir" -Receipt "$TransactionRecord" $DiagnosticArguments'
    Pop $0
    Pop $1
    StrCpy $HelperExit $0
    Call WriteInstallDiagnostic
    DetailPrint "$1"
    ${If} $0 != 0
      Call RestorePreservedFiles
      RMDir /r "$StageDir"
      SetErrorLevel 2
      !insertmacro AbortTransaction "个人文件未能迁入新程序目录，原安装已恢复。请关闭占用文件的程序后重试。"
    ${EndIf}
  ${Else}
    RMDir "$INSTDIR"
  ${EndIf}
  !insertmacro InstallPhase "publishing_application"
  ClearErrors
  ${If} $BackupDir != ""
    ; The kept installation folder receives the staged entries one by one.
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\installation-files.ps1" -Operation attach -Target "$INSTDIR" -Source "$StageDir" $DiagnosticArguments'
    Pop $0
    Pop $1
    StrCpy $HelperExit $0
    Call WriteInstallDiagnostic
    ${If} $0 == 3
      SetErrorLevel 2
      !insertmacro AbortTransaction "部分新文件未能移回。请保留 $BackupDir、$StageDir 和 $TransactionRecord 以便恢复。"
    ${ElseIf} $0 != 0
      DetailPrint "$1"
      SetErrors
    ${EndIf}
  ${Else}
    Rename "$StageDir" "$INSTDIR"
  ${EndIf}
  ${If} ${Errors}
    ${If} $BackupDir != ""
      Call RestorePreservedFiles
    ${EndIf}
    RMDir /r "$StageDir"
    SetErrorLevel 2
    !insertmacro AbortTransaction "Could not install Cage. The previous installation has been restored."
  ${EndIf}
  ${If} $BackupDir != ""
    !insertmacro InstallPhase "cleaning_previous_application"
    DetailPrint "正在清理已核对的旧程序文件…"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\installation-files.ps1" -Operation cleanup -Target "$INSTDIR" -Source "$BackupDir" -Receipt "$TransactionRecord" $DiagnosticArguments'
    Pop $0
    Pop $1
    StrCpy $HelperExit $0
    Call WriteInstallDiagnostic
    DetailPrint "$1"
    ${If} $0 != 0
      DetailPrint "旧目录中仍有需要保留的文件：$BackupDir"
      SetErrorLevel 2
      !insertmacro AbortTransaction "安装仍有待恢复的文件。请保留 $TransactionRecord 及其中记录的目录，再处理恢复。"
    ${EndIf}
  ${Else}
    !insertmacro InstallPhase "completing_file_transaction"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\installation-files.ps1" -Operation complete -Target "$INSTDIR" -Receipt "$TransactionRecord" $DiagnosticArguments'
    Pop $0
    Pop $1
    StrCpy $HelperExit $0
    Call WriteInstallDiagnostic
    ${If} $0 != 0
      SetErrorLevel 2
      !insertmacro AbortTransaction "安装回执未能完成，记录保留在 $TransactionRecord。"
    ${EndIf}
  ${EndIf}
  !insertmacro InstallPhase "registering_installation"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Cage"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Cage contributors"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\Cage.exe,0"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  SetOutPath "$INSTDIR"
  ${If} $DesktopShortcut == 1
    CreateShortcut "$DESKTOP\Cage.lnk" "$INSTDIR\Cage.exe"
  ${Else}
    Delete "$DESKTOP\Cage.lnk"
  ${EndIf}
  ${If} $StartMenuShortcuts == 1
    CreateDirectory "$SMPROGRAMS\Cage"
    CreateShortcut "$SMPROGRAMS\Cage\Cage.lnk" "$INSTDIR\Cage.exe"
    CreateShortcut "$SMPROGRAMS\Cage\Uninstall Cage.lnk" "$INSTDIR\Uninstall.exe"
  ${Else}
    Delete "$SMPROGRAMS\Cage\Cage.lnk"
    Delete "$SMPROGRAMS\Cage\Uninstall Cage.lnk"
    RMDir "$SMPROGRAMS\Cage"
  ${EndIf}
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "DesktopShortcut" $DesktopShortcut
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "StartMenuShortcuts" $StartMenuShortcuts
  !insertmacro InstallPhase "completed"
  !insertmacro ReleaseInstallationMutex
  SetErrorLevel 0
SectionEnd

Function un.onInit
  StrCpy $InstallOutcome "running"
  StrCpy $HelperExit ""
  StrCpy $DiagnosticArguments ""
  ${GetParameters} $0
  ${GetOptions} $0 "/DIAGNOSTICS=" $DiagnosticFile
  ${If} $DiagnosticFile != ""
    StrCpy $DiagnosticArguments '-Diagnostics "$DiagnosticFile.helper.json"'
  ${EndIf}
  !insertmacro UninstallPhase "checking_installation_identity"
  SetShellVarContext current
  SetRegView 64
  FileOpen $0 "$INSTDIR\Cage.install-id" r
  FileRead $0 $1
  FileClose $0
  ${If} $1 != "${APP_ID}"
    StrCpy $HelperExit "identity_mismatch"
    Call un.WriteInstallDiagnostic
    SetErrorLevel 2
    !insertmacro AbortTransaction "This is not a Cage installation folder."
  ${EndIf}
  !insertmacro UninstallPhase "checking_stopped_processes"
  !insertmacro CheckStopped "Cage.exe" desktop 0
  !insertmacro CheckStopped "resources\cage.exe" backend 0
  !insertmacro CheckStopped "resources\mihomo.exe" proxy 0
  !insertmacro CheckStopped "resources\runtime\qemu\qemu-system-x86_64.exe" vm 0
FunctionEnd

Section "Uninstall"
  !insertmacro UninstallPhase "acquiring_installation_lock"
  !insertmacro AcquireInstallationMutex
  !insertmacro UninstallPhase "checking_pending_transaction"
  ${If} ${FileExists} "$INSTDIR.cage-installation.json"
    StrCpy $HelperExit "pending_install_transaction"
    Call un.WriteInstallDiagnostic
    SetErrorLevel 2
    !insertmacro AbortTransaction "存在待恢复的安装事务，请先处理 $INSTDIR.cage-installation.json 中记录的目录。"
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=installation-files.ps1 "installation-files.ps1"
  File /oname=verified-file-deletion.cs "verified-file-deletion.cs"
  File /oname=install-files.json "${FILE_MANIFEST}"
  ; PowerShell 5.1 Add-Type must not resolve NSIS's native System.dll as a
  ; managed compiler reference from the plugin working directory.
  SetOutPath "$TEMP"
  !insertmacro UninstallPhase "removing_owned_files"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\installation-files.ps1" -Operation uninstall -Target "$INSTDIR" -Manifest "$PLUGINSDIR\install-files.json" $DiagnosticArguments'
  Pop $0
  Pop $1
  StrCpy $HelperExit $0
  Call un.WriteInstallDiagnostic
  DetailPrint "$1"
  ${If} $0 != 0
    SetErrorLevel 2
    !insertmacro AbortTransaction "部分程序文件正在使用或无法读取，卸载未完成。个人文件已保留，请关闭占用程序后重试。"
  ${EndIf}
  !insertmacro UninstallPhase "removing_shortcuts_and_registration"
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 == $INSTDIR
    Delete "$DESKTOP\Cage.lnk"
    Delete "$SMPROGRAMS\Cage\Cage.lnk"
    Delete "$SMPROGRAMS\Cage\Uninstall Cage.lnk"
    RMDir "$SMPROGRAMS\Cage"
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ${EndIf}
  !insertmacro UninstallPhase "removing_install_directory"
  RMDir "$INSTDIR"
SectionEnd
