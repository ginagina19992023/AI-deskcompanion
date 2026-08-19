# audio-nod

Real WASAPI loopback capture (reads whatever the system is currently playing)
with a simple instant-energy-vs-rolling-average beat detector. Emits one JSON
line per detected beat on stdout:

```
{"status":"started","sampleRate":44100,"channels":2,"bits":32}
{"beat":true,"energy":0.1103}
```

`src/main.js` spawns `audio-nod.exe` and forwards each beat to the renderer
as a `pet:beat` IPC event when `config.json`'s `musicNod.enabled` is true (or
the "听歌点头" tray/right-click checkbox is toggled on).

## Why raw P/Invoke instead of NAudio

This machine has the .NET **runtime** but no .NET **SDK** (`dotnet --list-sdks`
is empty), so `dotnet build`/`dotnet add package` aren't available. Rather
than requiring an SDK install, `Program.cs` talks to WASAPI directly via COM
interop (`IMMDeviceEnumerator` / `IAudioClient` / `IAudioCaptureClient`) and
compiles with the C# compiler that ships with every Windows install:

```powershell
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:exe /platform:x64 /out:audio-nod.exe Program.cs
```

Re-run that after editing `Program.cs`; `audio-nod.exe` is not rebuilt
automatically. `/platform:x64` matters because Electron itself is x64 -- the
default in-band CLSID/vtable interop is bitness-sensitive if the wrong
compiler is used, though in practice this rarely bites since csc.exe here is
already the x64 Framework compiler.

## Verifying it actually captures real audio

```powershell
$exe = ".\audio-nod.exe"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe; $psi.RedirectStandardOutput = $true; $psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
Start-Sleep -Milliseconds 800
(New-Object Media.SoundPlayer "C:\Windows\Media\Windows Notify System Generic.wav").PlaySync()
Start-Sleep -Milliseconds 500
$proc.Kill()
$proc.StandardOutput.ReadToEnd()
```

Should print a `"status":"started"` line followed by one or more
`"beat":true` lines timed to the sound. Silence produces no beat lines --
that's correct, not a bug (the point is it reacts to *real* audio, not a
timer).
