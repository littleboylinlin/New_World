!macro customCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${nsProcess::Unload}
  ${If} $R0 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先保存稿件并关闭 New World，再运行安装或卸载程序。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
