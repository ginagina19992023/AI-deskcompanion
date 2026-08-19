# One-shot: is a supported AI client window CURRENTLY the foreground window?
# Read-only (GetForegroundWindow + GetWindowText/GetWindowThreadProcessId) --
# no window is touched, focused, or otherwise changed. Used to clear the
# "you haven't checked yet" head marker once you've actually looked at the
# Claude window, whether you got there via the pet's own activate-on-
# double-click or by switching to it yourself (alt-tab, taskbar, ...).
#
# Same match rule as activate-claude-window.ps1: window title or process
# name contains "claude" (case-insensitive).

param(
  [string]$TitlePattern = 'claude|codex|deepseek|kimi'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;using System.Text;
public class ClaudeFocusCheck {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
"@

function Get-ProcessNameSafe($processId) {
  try { return (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { return '' }
}

$fg = [ClaudeFocusCheck]::GetForegroundWindow()
$sb = New-Object Text.StringBuilder 256
[ClaudeFocusCheck]::GetWindowText($fg, $sb, 256) | Out-Null
$title = $sb.ToString()
$procId = 0
[ClaudeFocusCheck]::GetWindowThreadProcessId($fg, [ref]$procId) | Out-Null
$procName = Get-ProcessNameSafe $procId

$focused = ($title -match $TitlePattern) -or ($procName -match $TitlePattern)

Write-Output (ConvertTo-Json ([pscustomobject]@{ focused = $focused; title = $title; proc = $procName }) -Compress)
