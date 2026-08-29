// Main-process only: spawns the local `piper` Python package (pip install
// piper-tts[zh]) to synthesize one line of text into a WAV file. Kept
// separate from voice-tts.js, which is renderer-only (browser
// speechSynthesis) for the opposite reason -- node:child_process doesn't
// exist there.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Synthesize `text` with a local Piper voice model, writing a WAV file to
 * the OS temp dir. Rejects on any failure (missing python/model, bad
 * phonemizer install, etc.) so the caller can fall back to another engine
 * -- this never silently returns something unplayable.
 */
export function synthesizePiper(text, { pythonPath = 'python', modelPath, dataDir } = {}) {
  return new Promise((resolve, reject) => {
    if (!modelPath) {
      reject(new Error('未配置本地 Piper 语音模型路径'));
      return;
    }
    const outPath = join(tmpdir(), `piper-tts-${randomUUID()}.wav`);
    const args = ['-m', 'piper', '-m', modelPath, '-f', outPath, '--'];
    if (dataDir) args.splice(2, 0, '--data-dir', dataDir);
    args.push(text);
    const proc = spawn(pythonPath, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, // avoid the GBK console-encode crash seen with Chinese text on this locale
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ filePath: outPath });
      else reject(new Error(`piper exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}
