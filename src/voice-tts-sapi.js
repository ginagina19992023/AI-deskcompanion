// Main-process only, same reasoning as voice-tts-piper.js. Spawns
// tools/sapi-tts.ps1 to synthesize one line of text into a WAV file using
// Windows' own SAPI voices with an explicitly selected voice name --
// see that script's header comment for why this exists instead of just
// using the renderer's browser speechSynthesis.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Synthesize `text` with a named Windows SAPI voice, writing a WAV file to
 * the OS temp dir. Rejects on any failure so the caller can fall back to
 * the browser's own speechSynthesis as a last resort.
 */
export function synthesizeSapi(text, { voiceName = '', rate = 1, volume = 1, scriptPath } = {}) {
  return new Promise((resolve, reject) => {
    const outPath = join(tmpdir(), `sapi-tts-${randomUUID()}.wav`);
    // cfg.voice.rate is a 0.5-2 multiplier (1 = normal); SAPI's own Rate is
    // an integer -10..10 around 0 = normal. cfg.voice.volume is 0-1; SAPI's
    // Volume is 0-100. Pitch isn't adjustable through this API (would need
    // SSML), so it's not passed through here.
    const rateInt = Math.round(Math.max(-10, Math.min(10, (Number(rate) - 1) * 10)));
    const volumeInt = Math.round(Math.max(0, Math.min(100, Number(volume) * 100)));
    const proc = spawn(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        '-Text', text,
        '-VoiceName', voiceName ?? '',
        '-OutPath', outPath,
        '-Rate', String(rateInt),
        '-Volume', String(volumeInt),
      ],
      { windowsHide: true },
    );
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ filePath: outPath });
      else reject(new Error(`sapi-tts exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}
