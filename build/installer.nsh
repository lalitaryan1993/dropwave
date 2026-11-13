; Open LANDrop's ports on private networks so other devices can find and send to this PC
; without a Windows Firewall prompt. Removed again on uninstall.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LANDrop"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="LANDrop" dir=in action=allow program="$INSTDIR\LANDrop.exe" enable=yes profile=private,domain'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LANDrop"'
!macroend
