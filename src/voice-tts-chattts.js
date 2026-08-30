// Main-process only. Spawns Python to run ChatTTS (开源中文TTS，比Piper音质更好).
// ChatTTS is a pure-Chinese-optimized TTS, deployed locally via:
//   pip install ChatTTS
// It provides good quality Mandarin synthesis without network dependency,
// making it a good fallback to Edge cloud for Chinese text.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Python script to synthesize with ChatTTS and output WAV file
const CHATTTS_SCRIPT = `
import sys
from ChatTTS import Chat
import torchaudio

text = sys.argv[1]
out_path = sys.argv[2]

chat = Chat()
# download_models() downloads from local cache if exists, else from huggingface
chat.download_models()

# Synthesize to WAV (infer returns tensor directly in v0.2.5)
wavs = chat.infer(text, use_decoder=True)
if wavs is not None:
    torchaudio.save(out_path, wavs.unsqueeze(0), 24000)
    print("OK")
else:
    print("FAILED")
`;

export function synthesizeChattts(text, { pythonPath = 'python' } = {}) {
  return new Promise((resolve, reject) => {
    const outPath = join(tmpdir(), `chattts-tts-${randomUUID()}.wav`);
    // Write script to temp file
    const scriptPath = join(tmpdir(), `chattts-${randomUUID()}.py`);
    const fs = require('node:fs');
    fs.writeFileSync(scriptPath, CHATTTS_SCRIPT);

    const proc = spawn(pythonPath, [scriptPath, text, outPath], { windowsHide: true });
    let stderr = '';
    let stdout = '';

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('chattts timed out (10s)'));
    }, 10000);

    proc.on('error', reject);
    proc.on('close', (code) => {
      clearTimeout(timeout);
      // Cleanup script
      try { fs.unlinkSync(scriptPath); } catch (e) {}

      if (code === 0 && stdout.includes('OK')) {
        resolve({ filePath: outPath });
      } else {
        reject(new Error(`chattts exited ${code}: ${stderr.slice(-400)}`));
      }
    });
  });
}
