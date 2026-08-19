Option Explicit

Dim shell, fso, projectDir, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
command = "cmd.exe /d /s /c ""cd /d """ & projectDir & """ && npm start"""

' Window style 0 keeps the npm/cmd console hidden. The Electron app itself
' still opens normally. False means the launcher does not wait for Electron.
shell.Run command, 0, False
