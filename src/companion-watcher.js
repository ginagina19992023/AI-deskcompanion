// Spawns the PowerShell companion watcher. Main-process only: it uses
// node:child_process, which the renderer cannot load.

import { spawn } from 'node:child_process';
import { parseWatcherLine } from './companion.js';

/**
 * Spawns the PowerShell watcher and keeps the latest rect. Degrades quietly:
 * if PowerShell is missing or the script dies, the companion is simply
 * reported absent and the pet behaves normally.
 */
export function createCompanionWatcher({ scriptPath, intervalMs = 200, onError } = {}) {
  let latest = { present: false };
  let child = null;
  let stopped = false;

  try {
    child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-IntervalMs',
        String(intervalMs),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    onError?.(err);
    return {
      get rect() {
        return { present: false };
      },
      stop() {},
    };
  }

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const parsed = parseWatcherLine(line);
      if (parsed) latest = parsed;
    }
    if (buffer.length > 4096) buffer = '';
  });

  // Must be drained: an unread stderr pipe fills and then blocks the child.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) onError?.(new Error(`watcher stderr: ${text.slice(0, 400)}`));
  });

  child.on('error', (err) => {
    latest = { present: false };
    if (!stopped) onError?.(err);
  });

  child.on('exit', (code, signal) => {
    latest = { present: false };
    if (!stopped) onError?.(new Error(`watcher exited (code=${code} signal=${signal})`));
  });

  return {
    get rect() {
      return latest;
    },
    stop() {
      stopped = true;
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
