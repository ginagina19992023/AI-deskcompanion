# Whole-machine migration helper: bundles the parts of this install that
# aren't in git (config.json + data/, both deliberately .gitignore'd since
# they're per-machine/personal, not code) into one zip, and restores that
# zip on another machine. Two modes because both ends need the same
# "safely move a pile of files" logic and Compress-Archive/Expand-Archive
# already ship with PowerShell 5.1+ -- no new dependency to pull in for
# what's fundamentally a copy+zip operation.
#
# Import never deletes: anything about to be overwritten is renamed aside
# with a .backup-<timestamp> suffix first, so a bad import is always a
# rename away from undone.

param(
  [Parameter(Mandatory=$true)][ValidateSet('Export','Import')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$RootDir,
  [string]$DestZip,
  [string]$SrcZip,
  [switch]$IncludeScreenTips,
  [switch]$IncludeVocalSplits,
  [switch]$IncludeVoiceSamples,
  [switch]$IncludeTestSongs
)

$ErrorActionPreference = 'Stop'

function Write-ErrorJson([string]$msg) {
  $obj = @{ error = $msg }
  [Console]::Error.WriteLine(($obj | ConvertTo-Json -Compress))
}

# Small state files that live directly under data/ -- always included,
# they're each a few KB to a few MB (pet-memory.json is the largest at
# ~3MB) so bundling them unconditionally costs nothing.
$AlwaysIncludeDataFiles = @(
  'activity-memory-state.json',
  'chat-conversations.json',
  'chat-log.json',
  'claude-status-tracking.json',
  'pet-memory.json',
  'pomodoro-sessions.json',
  'reports.json',
  'todos.json',
  'vocal-history.json'
)

# Large media folders under data/ -- opt-in, since screen-tips + vocal-splits
# alone run into the hundreds of MB and most migrations don't need every
# screenshot/converted song carried along automatically.
$OptionalDataDirs = @{
  'screen-tips'   = [bool]$IncludeScreenTips
  'vocal-splits'  = [bool]$IncludeVocalSplits
  'voice-samples' = [bool]$IncludeVoiceSamples
  'test-songs'    = [bool]$IncludeTestSongs
}

try {
  $dataDir = Join-Path $RootDir 'data'
  $configPath = Join-Path $RootDir 'config.json'

  if ($Mode -eq 'Export') {
    if (-not $DestZip) { throw 'DestZip is required for Export' }

    $stamp = Get-Date -Format 'yyyyMMddHHmmss'
    $staging = Join-Path $env:TEMP "ai-deskcompanion-export-$stamp"
    New-Item -ItemType Directory -Path $staging | Out-Null
    $stagingData = Join-Path $staging 'data'
    New-Item -ItemType Directory -Path $stagingData | Out-Null

    if (Test-Path $configPath) {
      Copy-Item $configPath (Join-Path $staging 'config.json')
    }

    foreach ($name in $AlwaysIncludeDataFiles) {
      $src = Join-Path $dataDir $name
      if (Test-Path $src) { Copy-Item $src (Join-Path $stagingData $name) }
    }

    $includedDirs = @()
    foreach ($name in $OptionalDataDirs.Keys) {
      if ($OptionalDataDirs[$name]) {
        $src = Join-Path $dataDir $name
        if (Test-Path $src) {
          Copy-Item $src (Join-Path $stagingData $name) -Recurse
          $includedDirs += $name
        }
      }
    }

    if (Test-Path $DestZip) { Remove-Item $DestZip -Force }
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $DestZip -Force
    Remove-Item $staging -Recurse -Force

    $sizeBytes = (Get-Item $DestZip).Length
    $result = @{ output = $DestZip; sizeBytes = $sizeBytes; includedDirs = $includedDirs }
    Write-Output ($result | ConvertTo-Json -Compress)
    exit 0
  }

  if ($Mode -eq 'Import') {
    if (-not $SrcZip) { throw 'SrcZip is required for Import' }
    if (-not (Test-Path $SrcZip)) { throw "Backup file not found: $SrcZip" }

    $stamp = Get-Date -Format 'yyyyMMddHHmmss'
    $staging = Join-Path $env:TEMP "ai-deskcompanion-import-$stamp"
    Expand-Archive -Path $SrcZip -DestinationPath $staging -Force

    $backups = @()
    $restored = @()

    $stagedConfig = Join-Path $staging 'config.json'
    if (Test-Path $stagedConfig) {
      if (Test-Path $configPath) {
        $bak = "$configPath.backup-$stamp"
        Move-Item $configPath $bak
        $backups += $bak
      }
      Move-Item $stagedConfig $configPath
      $restored += 'config.json'
    }

    $stagedData = Join-Path $staging 'data'
    if (Test-Path $stagedData) {
      if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
      Get-ChildItem $stagedData | ForEach-Object {
        $destItem = Join-Path $dataDir $_.Name
        if (Test-Path $destItem) {
          $bak = "$destItem.backup-$stamp"
          Move-Item $destItem $bak
          $backups += $bak
        }
        Move-Item $_.FullName $destItem
        $restored += "data/$($_.Name)"
      }
    }

    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue

    $result = @{ output = 'imported'; restored = $restored; backups = $backups }
    Write-Output ($result | ConvertTo-Json -Compress)
    exit 0
  }
}
catch {
  Write-ErrorJson $_.Exception.Message
  exit 1
}
