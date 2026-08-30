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

// A voice that isn't tagged "Multilingual" in Azure's catalog flatly
// rejects text in a script it doesn't cover (confirmed live: an en-GB
// voice given Chinese text raises NoAudioReceived, not a mangled attempt
// at reading it) -- so a character voiced by one of those needs a second,
// separate voice for the other language rather than one shared identity.
// voiceNameZh/voiceNameEn (both optional) cover that pairing; voiceName
// stays as the single-voice fallback for a plain multilingual pick or
// when only one of the pair is configured.
function pickVoiceName(text, { voiceName, voiceNameZh, voiceNameEn }) {
  const isChinese = /[一-鿿]/.test(text);
  if (isChinese && voiceNameZh) return voiceNameZh;
  if (!isChinese && voiceNameEn) return voiceNameEn;
  return voiceName ?? voiceNameZh ?? voiceNameEn ?? 'zh-CN-YunxiNeural';
}

export function synthesizeEdge(text, { pythonPath = 'python', voiceName, voiceNameZh, voiceNameEn, rateZh, pitchZh, timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const outPath = join(tmpdir(), `edge-tts-${randomUUID()}.mp3`);
    const isChinese = /[一-鿿]/.test(text);
    const resolvedVoice = pickVoiceName(text, { voiceName, voiceNameZh, voiceNameEn });
    const args = ['-m', 'edge_tts', '--voice', resolvedVoice, '--text', text, '--write-media', outPath];
    // Prosody tweak applied only on the zh-CN side: none of Azure's zh-CN
    // male voices are actually tagged with a composed/dignified character
    // on their own (Professional/Reliable is the closest, still reads as
    // plain and brisk at default rate/pitch) -- a bit slower and a touch
    // lower reads as noticeably more measured without this becoming a
    // slow-motion caricature. Left off the separately-chosen English voice,
    // which didn't need it.
    if (isChinese && rateZh) args.push('--rate', rateZh);
    if (isChinese && pitchZh) args.push('--pitch', pitchZh);
    const proc = spawn(pythonPath, args, {
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
