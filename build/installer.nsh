; Clic droit sur une vidéo dans l'Explorateur : « Ouvrir avec ChaosClip » (compte courant, sans droits admin).
!macro customInstall
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\video\shell\ChaosClip" "" "Ouvrir avec ChaosClip"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\video\shell\ChaosClip" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\video\shell\ChaosClip\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\video\shell\ChaosClip"
!macroend
