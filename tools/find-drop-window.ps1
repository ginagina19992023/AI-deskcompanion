# One-shot: after a drag-drop that wasn't near a screen edge, look for the
# largest *other* visible top-level window the pet's drop rect actually
# touches, so main.js can decide whether it landed against that window's
# side (perch) or on top of it (lie-down). Read-only (EnumWindows +
# GetWindowRect) -- never touches window content.
#
# Excludes: minimized windows, our own "Pet" window, untitled/system-shell
# windows (Progman/WorkerW/taskbar), and anything implausibly small or huge
# (tooltips, or a window spanning the whole virtual desktop).

param(
  [int]$PetLeft,
  [int]$PetTop,
  [int]$PetRight,
  [int]$PetBottom
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;using System.Text;
public class DropTarget {
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
 public delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 public struct RECT { public int L,T,R,B; }
}
"@

$skipClasses = @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow')
$slack = 30
$candidates = @()

$cb = [DropTarget+EnumProc] {
  param($h, $l)
  if ([DropTarget]::IsWindowVisible($h) -and -not [DropTarget]::IsIconic($h)) {
    $csb = New-Object Text.StringBuilder 256
    [DropTarget]::GetClassName($h, $csb, 256) | Out-Null
    if ($skipClasses -notcontains $csb.ToString()) {
      $tsb = New-Object Text.StringBuilder 256
      [DropTarget]::GetWindowText($h, $tsb, 256) | Out-Null
      $title = $tsb.ToString()
      if ($title -ne '' -and $title -ne 'Pet') {
        $r = New-Object DropTarget+RECT
        [DropTarget]::GetWindowRect($h, [ref]$r) | Out-Null
        $w = $r.R - $r.L
        $ht = $r.B - $r.T
        if ($w -gt 60 -and $ht -gt 60 -and $w -lt 6000 -and $ht -lt 4000) {
          if ($PetRight -ge ($r.L - $slack) -and $PetLeft -le ($r.R + $slack) -and
              $PetBottom -ge ($r.T - $slack) -and $PetTop -le ($r.B + $slack)) {
            $script:candidates += [pscustomobject]@{ title = $title; L = $r.L; T = $r.T; R = $r.R; B = $r.B; area = $w * $ht }
          }
        }
      }
    }
  }
  return $true
}
[DropTarget]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($candidates.Count -eq 0) {
  Write-Output (ConvertTo-Json ([pscustomobject]@{ found = $false }) -Compress)
  exit 0
}

# Smallest touching window, not largest: dropping next to a small utility
# palette floating in front of a maximized editor should snap to the
# palette, not the editor behind it.
$best = $candidates | Sort-Object -Property area | Select-Object -First 1
Write-Output (ConvertTo-Json ([pscustomobject]@{
  found = $true; title = $best.title; L = $best.L; T = $best.T; R = $best.R; B = $best.B
}) -Compress)
