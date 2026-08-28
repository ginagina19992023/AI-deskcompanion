// Main-process only (node:child_process). Spawns tools/voice-stt.ps1 --
// same "spawn PowerShell, parse newline-delimited JSON from stdout"
// shape as companion-watcher.js/watch-companion.ps1, but driven (this
// one is told when to listen) rather than polling.
import { spawn } from 'node:child_process';

/** Parse one line from the helper's stdout. Returns null for junk. */
export function parseVoiceLine(line) {
  const text = String(line ?? '').trim();
  if (!text || text[0] !== '{') return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data?.text === 'string' && data.text) return { text: data.text };
  if (typeof data?.error === 'string' && data.error) return { error: data.error };
  return null;
}

export function createVoiceSttWatcher({ scriptPath, onTranscript, onError, spawnFn = spawn } = {}) {
  let child = null;
  let disposed = false;

  try {
    child = spawnFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err) {
    onError?.(err);
    return { start() {}, stop() {}, dispose() {} };
  }

  let buffer = '';
  child.stdout.setEncoding?.('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const parsed = parseVoiceLine(line);
      if (parsed?.text) onTranscript?.(parsed.text);
      else if (parsed?.error) onError?.(new Error(parsed.error));
    }
    if (buffer.length > 4096) buffer = '';
  });

  child.stderr.setEncoding?.('utf8');
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) onError?.(new Error(`voice-stt stderr: ${text.slice(0, 400)}`));
  });

  child.on('error', (err) => {
    if (!disposed) onError?.(err);
  });
  child.on('exit', (code, signal) => {
    if (!disposed) onError?.(new Error(`voice-stt exited (code=${code} signal=${signal})`));
  });

  return {
    start() {
      child.stdin.write('START\n');
    },
    stop() {
      child.stdin.write('STOP\n');
    },
    dispose() {
      disposed = true;
      try {
        child.stdin.write('EXIT\n');
      } catch {
        /* already gone */
      }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
