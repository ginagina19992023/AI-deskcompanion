# Synthesizes one line of text to a WAV file using Windows' built-in SAPI
# voices (System.Speech.Synthesis) with an explicitly selected voice.
#
# Why this exists instead of just using the browser's speechSynthesis: on
# Windows, Chromium/Electron's SpeechSynthesisUtterance.voice assignment is
# unreliable -- confirmed live, switching "音色" in the dashboard produced no
# audible change even though the correct SpeechSynthesisVoice object was
# attached to the utterance. Driving System.Speech directly from the main
# process, the same way voice-stt.ps1 already does for recognition, sidesteps
# that browser quirk entirely.
#
# One-shot process (unlike voice-stt.ps1's long-lived start/stop watcher) --
# synthesis is quick enough that spawning fresh per line is simpler than
# keeping a synthesizer process alive, and matches the piper/edge helpers'
# own one-shot shape.

param(
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$VoiceName = '',
  [Parameter(Mandatory = $true)][string]$OutPath,
  [int]$Rate = 0,
  [int]$Volume = 100
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($VoiceName) {
  # System.Speech.Synthesis only ever sees the older "Desktop" SAPI5 voices
  # (HKLM...\Speech\Voices\Tokens) -- confirmed on a real machine to be a
  # much shorter list (here: just Huihui/Zira/Hazel) than what Chromium's
  # speechSynthesis.getVoices() reports, which also pulls in the newer
  # per-language OneCore voices (e.g. Kangkang, Yaoyao) that this classic
  # API cannot reach at all. Dashboard-configured names come from that
  # browser list and often won't match a Desktop voice's name exactly (e.g.
  # "Microsoft Huihui - Chinese (Simplified, PRC)" vs the installed
  # "Microsoft Huihui Desktop") -- try an exact match first, then fall back
  # to a substring match on the proper noun so at least the voices that do
  # exist in both lists actually get selected instead of silently no-op'ing
  # onto whatever the synthesizer's own default happens to be.
  $installed = $synth.GetInstalledVoices() | Where-Object { $_.Enabled }
  $match = $installed | Where-Object { $_.VoiceInfo.Name -eq $VoiceName } | Select-Object -First 1
  if (-not $match) {
    $keyword = (($VoiceName -replace '^Microsoft\s+', '') -split '\s+')[0]
    if ($keyword) {
      $match = $installed | Where-Object { $_.VoiceInfo.Name -like "*$keyword*" } | Select-Object -First 1
    }
  }
  if ($match) { $synth.SelectVoice($match.VoiceInfo.Name) }
}
$synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
$synth.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))
$synth.SetOutputToWaveFile($OutPath)
$synth.Speak($Text)
$synth.Dispose()
