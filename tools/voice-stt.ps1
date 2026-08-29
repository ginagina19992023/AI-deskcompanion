# Offline speech-to-text helper using Windows' built-in SAPI dictation
# engine (System.Speech.Recognition) -- no cloud call, no model download.
# Same shape as watch-companion.ps1: a long-lived process, JSON lines on
# stdout. Unlike that script, this one is *driven* rather than polling:
# it sits idle until "START" arrives on stdin, recognizes continuously
# until "STOP" arrives, then goes idle again -- so the mic is never open
# outside of an explicit start/stop window from the caller.
#
# Output while running: {"text":"..."}   one line per recognized utterance
# Fatal init failure:    {"error":"..."} then the process exits
#
# Stdin commands: START | STOP | EXIT

$ErrorActionPreference = 'Stop'

# Without this, [Console]::Out writes using the console's default codepage
# (e.g. GBK on zh-CN Windows), which mangles any recognized Chinese text
# into mojibake by the time Node reads it as UTF-8 on the other end of the
# pipe. Confirmed by an actual smoke test: recognized text came through as
# "????" before this line was added.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

Add-Type -AssemblyName System.Speech

function Write-Json($obj) {
  [Console]::Out.WriteLine((ConvertTo-Json $obj -Compress))
  [Console]::Out.Flush()
}

try {
  $recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  $chosen = $recognizers | Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
  if (-not $chosen) { $chosen = $recognizers | Select-Object -First 1 }
  if (-not $chosen) {
    Write-Json @{ error = 'no SAPI recognizer installed on this machine' }
    exit 1
  }
} catch {
  Write-Json @{ error = "init failed: $($_.Exception.Message)" }
  exit 1
}

$subId = 'VoiceSttRecognized'
$script:engine = $null

# Builds a fresh engine and only *now* claims the microphone
# (SetInputToDefaultAudioDevice actually opens the capture device -- this
# must not happen until a START is in hand, or the header comment's promise
# above is broken and the mic stays claimed for the helper's entire
# lifetime instead of just the start/stop window).
function New-SttEngine {
  $e = New-Object System.Speech.Recognition.SpeechRecognitionEngine($chosen)
  $e.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $e.SetInputToDefaultAudioDevice()
  Register-ObjectEvent -InputObject $e -EventName SpeechRecognized -SourceIdentifier $subId -Action {
    $text = $Event.SourceEventArgs.Result.Text
    if ($text) {
      [Console]::Out.WriteLine((ConvertTo-Json @{ text = $text } -Compress))
      [Console]::Out.Flush()
    }
  } | Out-Null
  return $e
}

# Tears the engine all the way down (not just RecognizeAsyncStop) so the
# audio device is actually released between a STOP and the next START,
# rather than staying open-but-idle for the rest of the process's life.
function Remove-SttEngine {
  if ($script:engine) {
    try { $script:engine.RecognizeAsyncStop() } catch {}
    Unregister-Event -SourceIdentifier $subId -ErrorAction SilentlyContinue
    Get-Job -Name $subId -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue
    try { $script:engine.Dispose() } catch {}
    $script:engine = $null
  }
}

$running = $false
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break } # stdin closed -- caller went away
  $cmd = $line.Trim()
  if ($cmd -eq 'EXIT') { break }
  switch ($cmd) {
    'START' {
      if (-not $running) {
        try {
          $script:engine = New-SttEngine
          $script:engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
          $running = $true
        } catch {
          Write-Json @{ error = "start failed: $($_.Exception.Message)" }
          Remove-SttEngine
        }
      }
    }
    'STOP' {
      if ($running) {
        Remove-SttEngine
        $running = $false
      }
    }
    default { } # ignore unknown lines
  }
}

Remove-SttEngine

# Belt and suspenders: force the process to actually end even if some
# other lingering handle/subscription would otherwise keep the runspace
# alive -- this is a long-running helper process, not a script whose
# natural fall-through exit can be trusted blindly.
[Environment]::Exit(0)
