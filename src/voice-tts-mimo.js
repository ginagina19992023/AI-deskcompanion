// Main-process only. Calls Xiaomi's MiMo-V2.5-TTS cloud API (OpenAI-style
// audio chat-completions format) -- no local model, no GPU needed, which
// is why this exists alongside Edge as a second cloud option: this app's
// machine has no NVIDIA GPU, ruling out every local voice-cloning model
// (IndexTTS2/OpenVoice/Fish Speech all assume CUDA), so a cloud API is the
// only practical way to get character-voice-quality Mandarin here. Request
// shape confirmed against a working reference client (github.com/
// tiantianfly/mimo-tts), not just the marketing docs -- those never show
// the actual JSON schema.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// The 9 preset voices as of the MiMo-V2.5-TTS launch. mimo_default is
// bilingual; the rest are single-language. Exported so the dashboard can
// populate a dropdown without duplicating this list.
export const MIMO_PRESET_VOICES = [
  { id: 'mimo_default', label: 'MiMo 默认（中/英双语）' },
  { id: '冰糖', label: '冰糖（中文·女声）' },
  { id: '茉莉', label: '茉莉（中文·女声）' },
  { id: '苏打', label: '苏打（中文·男声）' },
  { id: '白桦', label: '白桦（中文·男声）' },
  { id: 'Mia', label: 'Mia (English, Female)' },
  { id: 'Chloe', label: 'Chloe (English, Female)' },
  { id: 'Milo', label: 'Milo (English, Male)' },
  { id: 'Dean', label: 'Dean (English, Male)' },
];

// Same reasoning as voice-tts-edge.js's pickVoiceName: a Chinese preset
// voice (苏打/白桦/冰糖/茉莉) and an English one (Mia/Chloe/Milo/Dean) are
// different characters, not the same voice in two languages, so a butler
// voiced by one needs a separate explicit pick for the other language
// rather than reusing whichever was configured for the other one.
function pickVoiceAndStyle(text, { voice, voiceZh, voiceEn, styleTag, styleTagZh }) {
  const isChinese = /[一-鿿]/.test(text);
  if (isChinese && voiceZh) return { voice: voiceZh, styleTag: styleTagZh ?? styleTag };
  if (!isChinese && voiceEn) return { voice: voiceEn, styleTag: undefined }; // style tags are Chinese mood words; skip on English text
  return { voice: voice ?? voiceZh ?? voiceEn ?? 'mimo_default', styleTag };
}

export function synthesizeMimo(text, {
  apiKey,
  baseUrl = 'https://api.xiaomimimo.com',
  voice = 'mimo_default',
  voiceZh,        // optional: Chinese-text-only preset voice override
  voiceEn,        // optional: English-text-only preset voice override
  styleTag,       // optional Chinese style word, e.g. "磁性" / "沉稳" / "温柔"
  styleTagZh,     // optional: Chinese-text-only style tag override
  styleInstruction = '',
  timeoutMs = 15000,
} = {}) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      reject(new Error('mimo: no API key configured'));
      return;
    }

    const resolved = pickVoiceAndStyle(text, { voice, voiceZh, voiceEn, styleTag, styleTagZh });
    const assistantContent = resolved.styleTag ? `(${resolved.styleTag})${text}` : text;
    const body = {
      model: 'mimo-v2.5-tts',
      messages: [
        { role: 'user', content: styleInstruction },
        { role: 'assistant', content: assistantContent },
      ],
      audio: { format: 'wav', voice: resolved.voice },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    fetch(`${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then(async (res) => {
        clearTimeout(timer);
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`mimo API HTTP ${res.status}: ${errText.slice(0, 300)}`);
        }
        const data = await res.json();
        const audioB64 = data?.choices?.[0]?.message?.audio?.data;
        if (!audioB64) throw new Error('mimo API: no audio in response');

        const outPath = join(tmpdir(), `mimo-tts-${randomUUID()}.wav`);
        writeFileSync(outPath, Buffer.from(audioB64, 'base64'));
        resolve({ filePath: outPath });
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err.name === 'AbortError' ? new Error('mimo API timed out') : err);
      });
  });
}
