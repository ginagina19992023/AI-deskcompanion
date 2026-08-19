# Reports the Codex/ChatGPT desktop-pet overlay window rect on stdout as JSON
# lines, forever. Read-only: it never touches the Codex process, only asks
# Windows where its window is.
#
# The pet overlay is identified by its extended window style rather than by
# title, so a Codex update that renames the window still works:
#   WS_EX_LAYERED (0x80000) + WS_EX_TOOLWINDOW (0x80) + WS_EX_TOPMOST (0x8)
# i.e. a layered (per-pixel-alpha), no-taskbar, always-on-top overlay.
#
# WS_EX_TRANSPARENT (0x20, click-through) is deliberately NOT required: the
# Codex pet toggles that bit off while the cursor hovers it (same technique
# this app uses for its own window), so requiring it made detection miss the
# window intermittently -- specifically while the user's real cursor was
# sitting on top of it, which is exactly when accurate detection matters most.
#
# Output: {"present":true,"x":650,"y":1001,"w":613,"h":602}  (physical pixels)
#         {"present":false}

param(
  [int]$IntervalMs = 200,
  [string]$ProcessPattern = 'ChatGPT|Codex'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;using System.Text;
public class PetWatch {
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
 public delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int i);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 public struct RECT { public int L,T,R,B; }
}
"@

[PetWatch]::SetProcessDPIAware() | Out-Null

$pidsCheckedAt = [datetime]::MinValue
$targetPids = @()

while ($true) {
  # Refresh the process list occasionally so a Codex restart is picked up.
  if (([datetime]::UtcNow - $pidsCheckedAt).TotalSeconds -gt 3) {
    $targetPids = @(Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ProcessName -match $ProcessPattern } |
      Select-Object -ExpandProperty Id)
    $pidsCheckedAt = [datetime]::UtcNow
  }

  $global:found = $null
  $global:scanned = 0
  if ($targetPids.Count -gt 0) {
    $cb = [PetWatch+EnumProc] {
      param($h, $l)
      $p = 0
      [PetWatch]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
      if ($targetPids -contains $p -and [PetWatch]::IsWindowVisible($h)) {
        $global:scanned++
        $ex = [PetWatch]::GetWindowLong($h, -20)
        $isLayered = ($ex -band 0x80000) -ne 0
        $isToolwindow = ($ex -band 0x80) -ne 0
        $isTopmost = ($ex -band 0x8) -ne 0
        if ($isLayered -and $isToolwindow -and $isTopmost) {
          $r = New-Object PetWatch+RECT
          [PetWatch]::GetWindowRect($h, [ref]$r) | Out-Null
          $w = $r.R - $r.L; $ht = $r.B - $r.T
          # Ignore degenerate, off-screen, or implausibly huge windows (a
          # bound here is cheap insurance against ever matching the wrong
          # window and feeding a pet-sized app a screen-sized rect).
          if ($w -gt 40 -and $ht -gt 40 -and $w -lt 3000 -and $ht -lt 3000 -and $r.L -gt -10000 -and $r.T -gt -10000) {
            $global:found = [pscustomobject]@{ present = $true; x = $r.L; y = $r.T; w = $w; h = $ht }
          }
        }
      }
      return $true
    }
    [PetWatch]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  }

  if ($null -eq $global:found) {
    # Include what we saw, so a silent "absent" can be diagnosed.
    [Console]::Out.WriteLine((ConvertTo-Json ([pscustomobject]@{
      present = $false; pids = $targetPids.Count; scanned = $global:scanned
    }) -Compress))
  } else {
    [Console]::Out.WriteLine((ConvertTo-Json $global:found -Compress))
  }
  [Console]::Out.Flush()

  Start-Sleep -Milliseconds $IntervalMs
}
