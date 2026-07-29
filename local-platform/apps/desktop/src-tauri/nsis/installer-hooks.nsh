; 本文件负责反转卸载数据选项语义，并将大目录移出应用路径后交给后台进程清理。

Var DrawHimePreserveData

!macro DrawHimeQueueDataDirectoryForDeletion DIRECTORY_PATH
  ${If} ${FileExists} "${DIRECTORY_PATH}"
    GetTempFileName $R8 "$TEMP"
    Delete "$R8"
    ClearErrors
    Rename "${DIRECTORY_PATH}" "$R8"
    ${If} ${Errors}
      ; 路径被占用时回退为同步删除，确保用户明确选择的清理操作真实完成。
      RMDir /r "${DIRECTORY_PATH}"
    ${Else}
      ; 原子移出数据目录后异步删除，避免大量 Runtime 小文件让卸载窗口长时间无响应。
      Exec '"$SYSDIR\cmd.exe" /D /Q /C RMDIR /S /Q $\"$R8$\"'
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 图形界面的复选框表示“保留数据”；静默卸载可通过 /KEEPDATA 使用同一语义。
  StrCpy $R7 $DeleteAppDataCheckboxState
  ClearErrors
  ${GetOptions} $CMDLINE "/KEEPDATA" $R9
  ${IfNot} ${Errors}
    StrCpy $R7 1
  ${EndIf}
  StrCpy $DrawHimePreserveData $R7

  ${If} $UpdateMode <> 1
  ${AndIf} $R7 = 0
    SetShellVarContext current
    !insertmacro DrawHimeQueueDataDirectoryForDeletion "$APPDATA\${BUNDLEID}"
    !insertmacro DrawHimeQueueDataDirectoryForDeletion "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  ; 禁用 Tauri 模板原有的同步递归删除，数据已保留或已进入后台清理队列。
  StrCpy $DeleteAppDataCheckboxState 0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 静默安装也固定写入实际语言，避免卸载器因缺少语言登记额外弹出选择框。
  WriteRegStr HKCU "${MANUPRODUCTKEY}" "Installer Language" "$LANGUAGE"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
  ${AndIf} $DrawHimePreserveData = 0
    ; 默认清理同时移除安装器语言状态；选择保留时则与其他本地设置一起复用。
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"
  ${EndIf}
!macroend
