$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir

$target = Join-Path $scriptDir 'start-desktop-pet.vbs'
$icon = Join-Path $projectDir 'assets\tray.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'AI Desk Companion.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = 'wscript.exe'
$shortcut.Arguments = '"' + $target + '"'
$shortcut.WorkingDirectory = $projectDir
$shortcut.IconLocation = $icon
$shortcut.Description = 'Launch AI Desk Companion'
$shortcut.Save()

Write-Host "Desktop shortcut created: $shortcutPath"
