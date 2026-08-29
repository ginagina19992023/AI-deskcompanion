# One-time setup for the local Whisper STT engine (see
# docs/WHISPER_STT_SETUP.md). Downloads a prebuilt whisper.cpp CLI (CPU/BLAS
# build -- no GPU needed) and a ggml model file, placing both where
# src/voice-stt-whisper.js's defaults expect them.
#
# Safe to re-run: skips anything already downloaded.
#
# Usage: powershell -ExecutionPolicy Bypass -File tools\whisper\setup-whisper.ps1 [-Model base|small]

param(
  [ValidateSet('base', 'small')]
  [string]$Model = 'base'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$whisperDir = Join-Path $root 'tools\whisper'
$modelsDir = Join-Path $whisperDir 'models'
New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null

$exePath = Join-Path $whisperDir 'whisper-cli.exe'
if (Test-Path $exePath) {
  Write-Host "whisper-cli.exe already present, skipping binary download."
} else {
  Write-Host "Downloading whisper.cpp CLI (BLAS/CPU build)..."
  $zipPath = Join-Path $whisperDir 'whisper-bin.zip'
  # GitHub's release CDN has measured much slower/throttled throughput than
  # Hugging Face's from some networks -- if this hangs for a very long
  # time, downloading the same asset manually in a browser and dropping it
  # in tools\whisper\ (matching the exe name check above) works too.
  Invoke-WebRequest -Uri 'https://github.com/ggerganov/whisper.cpp/releases/download/b4938/whisper-blas-bin-x64.zip' -OutFile $zipPath
  Write-Host "Extracting..."
  Expand-Archive -Path $zipPath -DestinationPath $whisperDir -Force
  Remove-Item $zipPath -Force
  # Different whisper.cpp release versions have named the CLI differently
  # (main.exe in older releases, whisper-cli.exe in newer ones) and some
  # zips nest everything under a Release\ subfolder -- normalize both.
  $found = Get-ChildItem -Path $whisperDir -Recurse -Include 'whisper-cli.exe', 'main.exe' | Select-Object -First 1
  if ($found -and $found.FullName -ne $exePath) {
    Copy-Item $found.FullName $exePath -Force
  }
  if (-not (Test-Path $exePath)) {
    throw "whisper-cli.exe not found after extraction -- check $whisperDir for the actual binary name and copy it there manually."
  }
  # The BLAS build needs its DLLs alongside the exe -- copy anything the
  # zip extracted next to whichever exe we just found, not just the exe
  # itself.
  Get-ChildItem -Path (Split-Path $found.FullName) -Filter '*.dll' | Copy-Item -Destination $whisperDir -Force
}

$modelFile = "ggml-$Model.bin"
$modelPath = Join-Path $modelsDir $modelFile
if (Test-Path $modelPath) {
  Write-Host "$modelFile already present, skipping model download."
} else {
  Write-Host "Downloading $modelFile (this can take a while depending on your connection)..."
  Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$modelFile" -OutFile $modelPath
}

Write-Host ""
Write-Host "Done. Verify with:"
Write-Host "  $exePath -m $modelPath --help"
Write-Host ""
Write-Host "Then in the dashboard: 聊天 -> 语音设置 -> 语音识别引擎 -> 本地 Whisper"
if ($Model -ne 'base') {
  Write-Host "Since you picked '$Model', also set config.json's voice.whisper.modelPath to:"
  Write-Host "  $modelPath"
}
