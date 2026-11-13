; DropWave installer extras (per-machine install, runs elevated).
;  - Windows Firewall rule so other devices can find and send to this PC without a prompt.
;  - Explorer right-click "Send with DropWave" for files and folders.
; Both are removed again on uninstall.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="DropWave"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="DropWave" dir=in action=allow program="$INSTDIR\DropWave.exe" enable=yes profile=private,domain'

  WriteRegStr HKLM "Software\Classes\*\shell\DropWave" "" "Send with DropWave"
  WriteRegStr HKLM "Software\Classes\*\shell\DropWave" "Icon" "$INSTDIR\DropWave.exe,0"
  WriteRegStr HKLM "Software\Classes\*\shell\DropWave" "MultiSelectModel" "Player"
  WriteRegStr HKLM "Software\Classes\*\shell\DropWave\command" "" '"$INSTDIR\DropWave.exe" --send "%1"'

  WriteRegStr HKLM "Software\Classes\Directory\shell\DropWave" "" "Send with DropWave"
  WriteRegStr HKLM "Software\Classes\Directory\shell\DropWave" "Icon" "$INSTDIR\DropWave.exe,0"
  WriteRegStr HKLM "Software\Classes\Directory\shell\DropWave" "MultiSelectModel" "Player"
  WriteRegStr HKLM "Software\Classes\Directory\shell\DropWave\command" "" '"$INSTDIR\DropWave.exe" --send "%1"'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="DropWave"'
  DeleteRegKey HKLM "Software\Classes\*\shell\DropWave"
  DeleteRegKey HKLM "Software\Classes\Directory\shell\DropWave"
!macroend
