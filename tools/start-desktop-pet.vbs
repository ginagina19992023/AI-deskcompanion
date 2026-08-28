Option Explicit

' Hidden launcher for AI Desk Companion: runs `npm start` with no visible
' console window. Invoked by the desktop shortcut created via
' INSTALL-DESKTOP-SHORTCUT.bat (or double-clicked directly).

Dim fso, shell, scriptDir, projectDir, comspec

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)

shell.CurrentDirectory = projectDir
comspec = shell.ExpandEnvironmentStrings("%ComSpec%")

' Window style 0 = hidden, wait = False (fire and forget)
shell.Run comspec & " /c npm start", 0, False
