// Shared vision-model calling code -- used by both the screen-tip
// (screenshot) and camera-sense (webcam) ambient features. Kept
// provider-agnostic and capture-source-agnostic: this module only ever
// sees a base64 image, never how it was obtained.

import { withOllamaLock } from './ollama-lock.js';

const DEFAULT_PROMPT = 'Describe what is in this image in one short sentence.';

// Ollama's /api/generate: local, no auth, single base64 image per call.
//
// Wrapped in withOllamaLock -- see ollama-lock.js -- so an ambient
// screen-tip/camera-sense call never overlaps a chat.js streamOllamaChat
// call. Both hit the same CPU-only Ollama instance on this machine
// (confirmed via `ollama ps`: size_vram 0 for every loaded model), and the
// ~42s cold-start cost noted below gets paid *again* by whichever call
// loses the race when two different models both need to be resident at
// once, instead of one call simply waiting its turn.
export async function callOllama(cfg, base64) {
  return withOllamaLock(async () => {
    const res = await fetch(`${(cfg.ollamaUrl ?? 'http://localhost:11434').replace(/\/+$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Measured: a cold-start call (model not yet loaded into memory) took
      // ~42s on this machine; a warm call was under a second. 20s killed the
      // very first real call every time.
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 90000),
      body: JSON.stringify({
        model: cfg.model ?? 'llava',
        prompt: cfg.prompt ?? DEFAULT_PROMPT,
        images: [base64],
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`ollama http ${res.status}`);
    const data = await res.json();
    return (data.response ?? '').trim();
  });
}

// Any provider exposing an OpenAI-style /chat/completions endpoint with
// vision support -- DeepSeek and most other hosted vision APIs included.
// The API key is read from an environment variable named by
// cfg.apiKeyEnv, never from config.json -- keeps a real credential out of
// a file that's easy to accidentally share/commit.
export async function callOpenAiCompatible(cfg, base64) {
  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : null;
  if (!apiKey) {
    throw new Error(
      `provider is 'openai-compatible' but ${cfg.apiKeyEnv ?? '(apiKeyEnv not set)'} isn't set in the environment`,
    );
  }
  const baseUrl = (cfg.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error("provider is 'openai-compatible' but baseUrl isn't set");

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 30000),
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: cfg.prompt ?? DEFAULT_PROMPT },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
          ],
        },
      ],
      max_tokens: 200,
    }),
  });
  if (!res.ok) throw new Error(`${cfg.provider} http ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

export async function callVisionModel(cfg, base64) {
  switch (cfg.provider ?? 'ollama') {
    case 'openai-compatible':
      return callOpenAiCompatible(cfg, base64);
    case 'ollama':
    default:
      return callOllama(cfg, base64);
  }
}
