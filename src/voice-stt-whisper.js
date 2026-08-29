// Local Whisper-based speech-to-text -- an alternative to voice-stt.js's
// Windows SAPI engine. SAPI's DictationGrammar accuracy on Chinese proved
// poor in practice (confirmed by direct user feedback); whisper.cpp is a
// meaningfully better local model at the cost of a one-shot (not
// streaming) recognition flow: record the whole utterance to a WAV file,
// then transcribe it in a single batch call, rather than SAPI's
// continuous per-phrase recognition events.
//
// Two child processes cooperate per utterance:
//   1. tools/mic-record/mic-record.exe -- WASAPI mic capture, driven the
//      same START/STOP/EXIT way voice-stt.ps1 is, but instead of emitting
//      recognized text it emits the path to a 16kHz mono WAV file once
//      STOP is sent.
//   2. whisper.cpp's CLI, invoked fresh per WAV file, printing the
//      transcribed text to stdout.
// The mic process stays alive across many START/STOP cycles (avoids
// re-opening the audio device each time); each whisper.cpp invocation is
// a short-lived one-shot process per utterance.
import { spawn } from 'node:child_process';
import { unlink } from 'node:fs';

/** Parse one line from mic-record.exe's stdout. Returns null for junk. */
export function parseMicLine(line) {
  const text = String(line ?? '').trim();
  if (!text || text[0] !== '{') return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data?.path === 'string' && data.path) return { path: data.path };
  if (typeof data?.message === 'string' && data.message) return { error: data.message };
  return null;
}

export function createWhisperSttWatcher({
  micRecordPath,
  whisperExePath,
  modelPath,
  outDir,
  language = 'zh',
  onTranscript,
  onError,
  spawnFn = spawn,
} = {}) {
  let mic = null;
  let disposed = false;

  try {
    mic = spawnFn(micRecordPath, [outDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    onError?.(err);
    return { start() {}, stop() {}, dispose() {} };
  }

  function transcribeFile(wavPath) {
    // -nt: no timestamps, -np: no progress spam, -l: language hint (a
    // fixed hint beats auto-detection for a single-language app -- with
    // short utterances, auto-detect is the more likely thing to guess
    // wrong, not the language itself).
    const args = ['-m', modelPath, '-f', wavPath, '-l', language, '-nt', '-np'];
    let proc;
    try {
      proc = spawnFn(whisperExePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      unlink(wavPath, () => {});
      onError?.(err);
      return;
    }
    let out = '';
    let errText = '';
    proc.stdout.setEncoding?.('utf8');
    proc.stdout.on('data', (c) => {
      out += c;
    });
    proc.stderr.setEncoding?.('utf8');
    proc.stderr.on('data', (c) => {
      errText += c;
    });
    proc.on('error', (err) => {
      unlink(wavPath, () => {});
      onError?.(err);
    });
    proc.on('close', (code) => {
      // Best-effort cleanup -- an utterance WAV is single-use scratch
      // data, not worth surfacing a cleanup failure as a user-facing error.
      unlink(wavPath, () => {});
      if (code !== 0) {
        onError?.(new Error(`whisper.cpp exited ${code}: ${errText.trim().slice(0, 300)}`));
        return;
      }
      const text = out.trim();
      if (text) onTranscript?.(text);
    });
  }

  let buffer = '';
  mic.stdout.setEncoding?.('utf8');
  mic.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const parsed = parseMicLine(line);
      if (parsed?.path) transcribeFile(parsed.path);
      else if (parsed?.error) onError?.(new Error(parsed.error));
    }
    if (buffer.length > 4096) buffer = '';
  });

  mic.stderr.setEncoding?.('utf8');
  mic.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) onError?.(new Error(`mic-record stderr: ${text.slice(0, 400)}`));
  });

  mic.on('error', (err) => {
    if (!disposed) onError?.(err);
  });
  mic.on('exit', (code, signal) => {
    if (!disposed) onError?.(new Error(`mic-record exited (code=${code} signal=${signal})`));
  });

  return {
    start() {
      mic.stdin.write('START\n');
    },
    stop() {
      mic.stdin.write('STOP\n');
    },
    dispose() {
      disposed = true;
      try {
        mic.stdin.write('EXIT\n');
      } catch {
        /* already gone */
      }
      try {
        mic.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
