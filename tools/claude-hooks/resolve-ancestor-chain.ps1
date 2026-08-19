# Background helper spawned (detached, fire-and-forget) from
# ~/.claude/hooks/pet-status.cjs the first time a session writes a status --
# walks the process ancestry from the hook's own PID and writes the
# resulting PID chain back into that session's JSON file, so
# tools/activate-by-pid.ps1 has something to search even after the hook's
# own short-lived process (and its immediate parent shell) have long since
# exited. Runs once per session (subsequent hook calls see ancestorChain
# already present and skip re-resolving), completely decoupled from the
# hook's own lifecycle -- the hook never waits for this.

param(
  [Parameter(Mandatory = $true)]
  [int]$StartPid,
  [Parameter(Mandatory = $true)]
  [string]$SessionPath
)

$ErrorActionPreference = 'SilentlyContinue'

$chain = @()
$cur = $StartPid
for ($i = 0; $i -lt 10; $i++) {
  $chain += $cur
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
  if (-not $p -or $p.ParentProcessId -eq 0 -or $p.ParentProcessId -eq $cur) { break }
  $cur = [int]$p.ParentProcessId
}

try {
  $raw = Get-Content -Path $SessionPath -Raw -ErrorAction Stop
  $obj = $raw | ConvertFrom-Json
  $obj | Add-Member -NotePropertyName ancestorChain -NotePropertyValue $chain -Force
  ($obj | ConvertTo-Json -Compress) | Set-Content -Path $SessionPath -Encoding utf8 -NoNewline
} catch {
  # Session file may have been removed already (task went idle before this
  # finished) -- nothing to attach the chain to, fine to just stop.
}

