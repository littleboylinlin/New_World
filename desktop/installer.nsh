!macro customHeader
  LangString nwDescription 1033 "Local novel library and writing workspace"
  LangString nwDescription 2052 "本地小说管理器与写作工作台"
  LangString nwCloseFirst 1033 "Save your work and close New World before installing or uninstalling."
  LangString nwCloseFirst 2052 "请先保存稿件并关闭 New World，再运行安装或卸载程序。"
  LangString nwInvalidDirectory 1033 "Choose a new or empty installation folder, or keep the current installation location. Do not select your library data folder."
  LangString nwInvalidDirectory 2052 "请选择新建或空的安装文件夹，或保留当前安装位置。请勿选择书库数据目录。"
  LangString nwDirectoryHelp 1033 "Choose the New World installation folder. Your library stays in your current user data folder."
  LangString nwDirectoryHelp 2052 "请选择 New World 的安装文件夹。书库数据仍保存在当前用户的数据目录。"
  LangString nwFinish 1033 "New World has been installed to:$\r$\n$INSTDIR$\r$\n$\r$\nYou can also open New World from the Start menu."
  LangString nwFinish 2052 "New World 已安装到：$\r$\n$INSTDIR$\r$\n$\r$\n你也可以从开始菜单打开 New World。"
  LangString nwLaunch 1033 "Launch New World"
  LangString nwLaunch 2052 "启动 New World"
  LangString nwDesktopShortcut 1033 "Create desktop shortcut"
  LangString nwDesktopShortcut 2052 "创建桌面快捷方式"
  LangString nwLanguageFailed 1033 "The selected language pack could not be downloaded or verified. Check your connection and try again."
  LangString nwLanguageFailed 2052 "无法下载或校验所选语言包，请检查网络后重试。"
!macroend

!macro customCheckAppRunning
  StrCpy $R1 0
  ${Do}
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${nsProcess::Unload}
    ${If} $R0 != 0
      ${ExitDo}
    ${EndIf}
    ${IfNot} ${isUpdated}
    ${OrIf} $R1 >= 100
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(nwCloseFirst)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    IntOp $R1 $R1 + 1
    Sleep 200
  ${Loop}
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
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(nwInvalidDirectory)"
      Abort
    ${EndIf}
  FunctionEnd

  !define MUI_DIRECTORYPAGE_TEXT_TOP "$(nwDirectoryHelp)"
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE LeaveNewWorldDirectory
  !insertmacro MUI_PAGE_DIRECTORY
!macroend

!macro customInit
  SetShellVarContext current
  System::Call 'kernel32::GetUserDefaultUILanguage() i.r0'
  IntOp $R0 $0 & 0x3ff
  ${If} $R0 == 4
    StrCpy $LANGUAGE 2052
  ${Else}
    StrCpy $LANGUAGE 1033
  ${EndIf}
  ${If} ${Silent}
    ${If} ${isUpdated}
      ReadEnvStr $R0 "NEW_WORLD_UPDATE_INSTALL_DIR"
      ${If} $R0 == ""
      ${OrIf} $INSTDIR != $R0
        SetErrorLevel 3
        Quit
      ${EndIf}
    ${EndIf}
    Call CheckNewWorldDirectory
    ${If} $R9 == "0"
      SetErrorLevel 3
      Quit
    ${EndIf}
  ${EndIf}
  InitPluginsDir
  File /oname=$PLUGINSDIR\install-language.ps1 "${PROJECT_DIR}\desktop\install-language.ps1"
  File /oname=$PLUGINSDIR\language-manifest.json "${PROJECT_DIR}\public\locales\manifest.json"
  ${GetOptions} $CMDLINE "/APP_LANGUAGE=" $R8
  ${If} ${Errors}
    StrCpy $R8 ""
  ${EndIf}
  StrCpy $R7 ""
  ${If} $R8 != ""
    StrCpy $R7 '-Locale "$R8"'
  ${EndIf}
  downloadLanguage:
    nsExec::ExecToStack /TIMEOUT=45000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-language.ps1" -Root "$APPDATA\NewWorld-languages" -Manifest "$PLUGINSDIR\language-manifest.json" $R7 -Selection "$PLUGINSDIR\language.txt"'
    Pop $R0
    Pop $R1
    ${If} $R0 != "0"
      FileOpen $R2 "$TEMP\NewWorld-language-install.log" w
      FileWrite $R2 "$R1"
      FileClose $R2
      ${IfNot} ${Silent}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(nwLanguageFailed)" /SD IDCANCEL IDRETRY downloadLanguage
      ${EndIf}
      SetErrorLevel 4
      Quit
    ${EndIf}
    FileOpen $R0 "$PLUGINSDIR\language.txt" r
    FileRead $R0 $R1
    FileClose $R0
    ${If} $R1 == "zh-CN"
      StrCpy $LANGUAGE 2052
    ${Else}
      StrCpy $LANGUAGE 1033
    ${EndIf}

!macroend

!macro customFinishPage
  Function LaunchNewWorld
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd

  Function CreateNewWorldDesktopLink
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "$(nwDescription)"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  FunctionEnd

  !define MUI_FINISHPAGE_TEXT "$(nwFinish)"
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "$(nwLaunch)"
  !define MUI_FINISHPAGE_RUN_FUNCTION LaunchNewWorld
  !define MUI_FINISHPAGE_RUN_NOTCHECKED
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "$(nwDesktopShortcut)"
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
