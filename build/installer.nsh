; Open DropWave's ports on private networks so other devices can find and send to this PC
; without a Windows Firewall prompt. Removed again on uninstall.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="DropWave"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="DropWave" dir=in action=allow program="$INSTDIR\DropWave.exe" enable=yes profile=private,domain'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="DropWave"'
!macroend
