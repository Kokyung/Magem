; electron-builder includes this file in the NSIS installer and uninstaller.

; "Launch at startup" writes a value under the user's Run key, named after the app's AppUserModelId
; (set to the appId in electron/main.mjs). Remove it with the app, or Windows keeps trying to start a
; program that is gone. Not on updates: the old version's uninstaller runs then, and the setting stays.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
  ${endIf}
!macroend
