; DropWave installer extras (per-machine install, runs elevated).
;  - Windows Firewall rule so other devices can find and send to this PC without a prompt.
;  - Explorer right-click "Send with DropWave" for files and folders.
;  - "DropWave Camera" (Windows 11): the phone as a webcam in Zoom, Meet, Teams…
; All are removed again on uninstall.

; ---- Look: dark brand colours on the Welcome / Finish pages and the top band (pictures: scripts/installer-art.cjs) ----
!define MUI_BGCOLOR "0B0D14"
!define MUI_TEXTCOLOR "FFFFFF"
!define MUI_FINISHPAGE_LINK_COLOR "8B7DFF"

!ifndef BUILD_UNINSTALLER
  !macro customWelcomePage
    !define MUI_WELCOMEPAGE_TITLE "Welcome to DropWave"
    !define MUI_WELCOMEPAGE_TEXT "Your Android phone on your Windows PC: calls, messages, OTPs, photos, the camera as a webcam and every app.$\r$\n$\r$\nFiles to any PC, phone or TV, one mouse for two PCs, print and scan from the phone.$\r$\n$\r$\nFree and open source. Everything stays on your own Wi-Fi: no cloud, no account.$\r$\n$\r$\nClick Next to continue."
    !insertmacro MUI_PAGE_WELCOME
  !macroend

  !define MUI_FINISHPAGE_TITLE "DropWave is ready"
  !define MUI_FINISHPAGE_TEXT "Open DropWave and scan the QR code on its Home screen with your phone to connect.$\r$\n$\r$\nOther PCs with DropWave on the same Wi-Fi show up by themselves."
  !define MUI_FINISHPAGE_LINK "DropWave on GitHub: guides, updates and the Android app"
  !define MUI_FINISHPAGE_LINK_LOCATION "https://github.com/lalitaryan1993/dropwave"
!endif

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

  IfFileExists "$INSTDIR\resources\vcam\dwcam.exe" 0 +2
    nsExec::Exec '"$INSTDIR\resources\vcam\dwcam.exe" install "$INSTDIR\resources\vcam\DropWaveCam.dll"'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="DropWave"'
  DeleteRegKey HKLM "Software\Classes\*\shell\DropWave"
  DeleteRegKey HKLM "Software\Classes\Directory\shell\DropWave"
  IfFileExists "$INSTDIR\resources\vcam\dwcam.exe" 0 +2
    nsExec::Exec '"$INSTDIR\resources\vcam\dwcam.exe" uninstall'
!macroend
