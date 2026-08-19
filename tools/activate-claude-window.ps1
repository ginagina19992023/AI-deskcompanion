# One-shot: find a Claude-related top-level window and bring it to the
# foreground. Read-only discovery (EnumWindows) + a single focus-switch
# call -- never touches window content, never sends keystrokes to it.
#
# Windows blocks a plain SetForegroundWindow call from a background process
# with no UI focus of its own (this pet's window is focusable:false and
# never has focus), so the request is normally silently ignored. The
# standard workaround is to temporarily attach this thread's input queue to
# the current foreground window's thread, which is exempt from that lock.
#
# Match order: window title contains "claude" (case-insensitive) OR process
# name contains "claude". Among matches, prefers the largest non-minimized
# window, since that's more likely to be a real app window than a stray
# tooltip/helper window.

param(
  [string]$TitlePattern = 'claude'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;using System.Text;
public class ClaudeFocus {
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
 public delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 public struct RECT { public int L,T,R,B; }
}
"@

function Get-ProcessNameSafe($processId) {
  try { return (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { return '' }
}

$candidates = @()
$cb = [ClaudeFocus+EnumProc] {
  param($h, $l)
  if ([ClaudeFocus]::IsWindowVisible($h)) {
    $sb = New-Object Text.StringBuilder 256
    [ClaudeFocus]::GetWindowText($h, $sb, 256) | Out-Null
    $title = $sb.ToString()
    $procId = 0
    [ClaudeFocus]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $procName = Get-ProcessNameSafe $procId

    if ($title -match $TitlePattern -or $procName -match $TitlePattern) {
      $r = New-Object ClaudeFocus+RECT
      [ClaudeFocus]::GetWindowRect($h, [ref]$r) | Out-Null
      $area = [Math]::Max(0, ($r.R - $r.L)) * [Math]::Max(0, ($r.B - $r.T))
      if ($area -gt 4000) {
        $script:candidates += [pscustomobject]@{
          hwnd = $h; title = $title; proc = $procName; area = $area
          minimized = [ClaudeFocus]::IsIconic($h)
        }
      }
    }
  }
  return $true
}
[ClaudeFocus]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($candidates.Count -eq 0) {
  Write-Output (ConvertTo-Json ([pscustomobject]@{ ok = $false; reason = 'no matching window' }) -Compress)
  exit 0
}

$target = $candidates | Sort-Object -Property @{Expression = 'minimized'; Descending = $false}, @{Expression = 'area'; Descending = $true} | Select-Object -First 1

if ($target.minimized) {
  [ClaudeFocus]::ShowWindow($target.hwnd, 9) | Out-Null # SW_RESTORE
}

$fg = [ClaudeFocus]::GetForegroundWindow()
$myThread = [ClaudeFocus]::GetCurrentThreadId()
$fgProcId = 0
$fgThread = [ClaudeFocus]::GetWindowThreadProcessId($fg, [ref]$fgProcId)

$attached = $false
if ($fgThread -ne 0 -and $fgThread -ne $myThread) {
  $attached = [ClaudeFocus]::AttachThreadInput($myThread, $fgThread, $true)
}

[ClaudeFocus]::BringWindowToTop($target.hwnd) | Out-Null
$ok = [ClaudeFocus]::SetForegroundWindow($target.hwnd)

if ($attached) {
  [ClaudeFocus]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null
}

Write-Output (ConvertTo-Json ([pscustomobject]@{
  ok = $ok; title = $target.title; proc = $target.proc; candidateCount = $candidates.Count
}) -Compress)
