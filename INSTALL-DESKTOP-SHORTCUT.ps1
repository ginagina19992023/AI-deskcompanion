$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $projectDir 'tools\start-desktop-pet.vbs'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'AI Desk Companion.lnk'

if (!(Test-Path $launcher)) {
    throw "Launcher not found: $launcher"
}

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$shortcut.Arguments = '"' + $launcher + '"'
$shortcut.WorkingDirectory = $projectDir
$shortcut.Description = 'AI Desk Companion'

# Prefer a custom icon if one is added later. Until then, use Electron's icon
# from this project's node_modules; if dependencies are not installed yet,
# Windows falls back to the system application icon.
$customIcon = Join-Path $projectDir 'assets\app-icon.ico'
$electronExe = Join-Path $projectDir 'node_modules\electron\dist\electron.exe'
if (Test-Path $customIcon) {
    $shortcut.IconLocation = "$customIcon,0"
} elseif (Test-Path $electronExe) {
    $shortcut.IconLocation = "$electronExe,0"
} else {
    $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,167"
}

$shortcut.Save()

Write-Host ''
Write-Host 'Desktop shortcut created:' -ForegroundColor Green
Write-Host $shortcutPath
Write-Host ''
Write-Host 'Double-click "AI Desk Companion" on your desktop from now on.' -ForegroundColor Cyan
