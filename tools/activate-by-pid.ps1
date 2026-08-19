# One-shot: given a comma-separated PID chain (deepest/most-specific first,
# as resolved once by resolve-ancestor-chain.ps1 and cached in the session
# file), find whichever entry owns a visible top-level window and bring it
# to the foreground -- same read-only-discovery + AttachThreadInput pattern
# as activate-claude-window.ps1, just keyed by process ancestry instead of a
# title/process-name text match.
#
# Takes the *whole* chain, not just one PID: the hook process and its
# immediate parent shell are typically short-lived (exit right after the
# hook finishes), so by the time you actually click "jump" -- maybe minutes
# later -- those specific PIDs are long gone. Only an outer ancestor (the
# terminal emulator, IDE, or Claude Desktop itself) is likely to still be
# alive; checking the whole chain directly is more resilient than re-walking
# from a single now-dead starting point. Falls back to a fresh walk-up from
# the last (shallowest, most likely still-alive) chain entry if none of the
# saved PIDs directly own a window.

param(
  [Parameter(Mandatory = $true)]
  [string]$PidChain
)

$chainPids = $PidChain.Split(',') | ForEach-Object { [int]$_.Trim() } | Where-Object { $_ -gt 0 }
if ($chainPids.Count -eq 0) {
  Write-Output (ConvertTo-Json ([pscustomobject]@{ ok = $false; reason = 'empty pid chain' }) -Compress)
  exit 0
}

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;using System.Text;
public class PidFocus {
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
 public struct RECT { public int L,T,R,B; }
}
"@

# All visible top-level windows with area > trivial, grouped by owning PID.
# Enumerated once (not per ancestor candidate) since EnumWindows is the
# expensive part of this whole script.
$windowsByPid = @{}
$cb = [PidFocus+EnumProc] {
  param($h, $l)
  if ([PidFocus]::IsWindowVisible($h)) {
    $procId = 0
    [PidFocus]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $r = New-Object PidFocus+RECT
    [PidFocus]::GetWindowRect($h, [ref]$r) | Out-Null
    $area = [Math]::Max(0, ($r.R - $r.L)) * [Math]::Max(0, ($r.B - $r.T))
    if ($area -gt 4000) {
      $sb = New-Object Text.StringBuilder 256
      [PidFocus]::GetWindowText($h, $sb, 256) | Out-Null
      if (-not $windowsByPid.ContainsKey([int]$procId)) { $windowsByPid[[int]$procId] = @() }
      $windowsByPid[[int]$procId] += [pscustomobject]@{ hwnd = $h; title = $sb.ToString(); area = $area; minimized = [PidFocus]::IsIconic($h) }
    }
  }
  return $true
}
[PidFocus]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

$target = $null
$ownerPid = $null

# Pass 1: does any PID already in the saved chain directly own a window?
foreach ($p in $chainPids) {
  if ($windowsByPid.ContainsKey($p)) {
    $target = ($windowsByPid[$p] | Sort-Object -Property @{Expression = 'minimized'; Descending = $false}, @{Expression = 'area'; Descending = $true} | Select-Object -First 1)
    $ownerPid = $p
    break
  }
}

# Pass 2: none did (maybe the chain wasn't deep enough, or ownership moved)
# -- walk up fresh from the shallowest (last, most likely still-alive) entry.
$hops = 0
if (-not $target) {
  $currentPid = $chainPids[$chainPids.Count - 1]
  for ($i = 0; $i -lt 12; $i++) {
    if ($windowsByPid.ContainsKey($currentPid)) {
      $target = ($windowsByPid[$currentPid] | Sort-Object -Property @{Expression = 'minimized'; Descending = $false}, @{Expression = 'area'; Descending = $true} | Select-Object -First 1)
      $ownerPid = $currentPid
      break
    }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$currentPid" -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.ParentProcessId -eq 0 -or $proc.ParentProcessId -eq $currentPid) { break }
    $currentPid = [int]$proc.ParentProcessId
    $hops++
  }
}

if (-not $target) {
  Write-Output (ConvertTo-Json ([pscustomobject]@{ ok = $false; reason = 'no window-owning ancestor found'; chain = $chainPids; hops = $hops }) -Compress)
  exit 0
}

if ($target.minimized) {
  [PidFocus]::ShowWindow($target.hwnd, 9) | Out-Null # SW_RESTORE
}

$fg = [PidFocus]::GetForegroundWindow()
$myThread = [PidFocus]::GetCurrentThreadId()
$fgProcId = 0
$fgThread = [PidFocus]::GetWindowThreadProcessId($fg, [ref]$fgProcId)

$attached = $false
if ($fgThread -ne 0 -and $fgThread -ne $myThread) {
  $attached = [PidFocus]::AttachThreadInput($myThread, $fgThread, $true)
}

[PidFocus]::BringWindowToTop($target.hwnd) | Out-Null
$ok = [PidFocus]::SetForegroundWindow($target.hwnd)

if ($attached) {
  [PidFocus]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null
}

Write-Output (ConvertTo-Json ([pscustomobject]@{ ok = $ok; title = $target.title; chain = $chainPids; ownerPid = $ownerPid; hops = $hops }) -Compress)
