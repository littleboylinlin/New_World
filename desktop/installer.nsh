!macro customCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${nsProcess::Unload}
  ${If} $R0 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先保存稿件并关闭 New World，再运行安装或卸载程序。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customPageAfterChangeDir
Function CheckNewWorldDirectory
  StrCmp $INSTDIR "" invalid
  # The Win32 API also resolves new directories that have not been created yet.
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r0, p 0) i.r1'
  ${If} $1 == 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
    Goto invalid
  ${EndIf}
  StrCpy $INSTDIR $0
  StrCpy $R0 "$APPDATA\NewWorld"
  StrCpy $R1 "$INSTDIR"
  checkProfile:
    StrCmp $R1 $R0 invalid
    ${GetParent} "$R1" $R2
    StrCmp $R2 "" checkContents
    StrCmp $R2 $R1 checkContents
    StrCpy $R1 $R2
    Goto checkProfile

  checkContents:
    ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCmp $INSTDIR $R0 valid
    IfFileExists "$INSTDIR\*" 0 valid
    FindFirst $R0 $R1 "$INSTDIR\*"
  checkEntry:
    StrCmp $R1 "" noEntries
    StrCmp $R1 "." nextEntry
    StrCmp $R1 ".." nextEntry
    FindClose $R0
    Goto invalid
  nextEntry:
    FindNext $R0 $R1
    Goto checkEntry
  noEntries:
    FindClose $R0
  valid:
    StrCpy $R9 "1"
    Return
  invalid:
    StrCpy $R9 "0"
FunctionEnd

  Function LeaveNewWorldDirectory
    FindWindow $R0 "#32770" "" $HWNDPARENT
    GetDlgItem $R0 $R0 1019
    ${NSD_GetText} $R0 $INSTDIR
    Call CheckNewWorldDirectory
    ${If} $R9 == "0"
      MessageBox MB_OK|MB_ICONEXCLAMATION "请选择新建或空的安装文件夹，或保留当前安装位置。请勿选择书库数据目录。"
      Abort
    ${EndIf}
  FunctionEnd

  !define MUI_DIRECTORYPAGE_TEXT_TOP "请选择 New World 的安装文件夹。书库数据仍保存在当前用户的数据目录。"
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE LeaveNewWorldDirectory
  !insertmacro MUI_PAGE_DIRECTORY
!macroend

!macro customInit
  ${If} ${Silent}
    Call CheckNewWorldDirectory
    ${If} $R9 == "0"
      SetErrorLevel 3
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customFinishPage
  Function LaunchNewWorld
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd

  Function CreateNewWorldDesktopLink
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  FunctionEnd

  !define MUI_FINISHPAGE_TEXT "New World 已安装到：$\r$\n$INSTDIR$\r$\n$\r$\n你也可以从开始菜单打开 New World。"
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "启动 New World"
  !define MUI_FINISHPAGE_RUN_FUNCTION LaunchNewWorld
  !define MUI_FINISHPAGE_RUN_NOTCHECKED
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "创建桌面快捷方式"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateNewWorldDesktopLink
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnInstall
  ${IfNot} ${isKeepShortcuts}
    WinShell::UninstShortcut "$oldDesktopLink"
    Delete "$oldDesktopLink"
  ${EndIf}
!macroend
