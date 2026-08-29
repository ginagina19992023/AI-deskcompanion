// Main-process only, same reasoning as voice-tts-piper.js. Spawns the
// `edge-tts` Python package (pip install edge-tts), which calls Microsoft
// Edge's free cloud neural-voice service over the network -- the one
// piece of this app's voice stack that isn't fully local, used only when
// the user opts into ttsEngine 'edge-cloud' and only for the duration of
// this one request (a hard timeout treats "can't reach it" the same as
// any other failure, so the caller falls back to a local engine instead
// of hanging).
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function synthesizeEdge(text, { pythonPath = 'python', voiceName = 'zh-CN-YunxiNeural', timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const outPath = join(tmpdir(), `edge-tts-${randomUUID()}.mp3`);
    const proc = spawn(pythonPath, ['-m', 'edge_tts', '--voice', voiceName, '--text', text, '--write-media', outPath], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error('edge-tts timed out (no network / service unreachable)'));
    }, timeoutMs);
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ filePath: outPath });
      else reject(new Error(`edge-tts exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}
