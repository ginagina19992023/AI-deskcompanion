// Real chat with the pet -- a text LLM call (Ollama locally, or any
// OpenAI-compatible cloud endpoint like DeepSeek), separate from
// claudeStatus (which only ever *reflects* what Claude Code is doing) and
// from screenTips (which is a one-way ambient aside, no back-and-forth).
// Main process only, same reasoning as screen-tip.js: fetch-to-a-network-
// endpoint has no business in the renderer's module graph.
//
// Privacy: with the default 'ollama' provider this never leaves the
// machine. Switching to 'openai-compatible' is an explicit opt-in that
// sends the conversation to whatever baseUrl you configure.
//
// Streams token deltas via `onDelta` rather than waiting for the full
// reply -- measured ~40-55s for a single non-streaming reply from a 12B
// local model, which reads as a hung app with nothing on screen. Streaming
// text in as it's generated is a real fix for that, not just a cosmetic
// typewriter effect.

import { withOllamaLock } from './ollama-lock.js';

const DEFAULT_SYSTEM_PROMPT =
  'You are a desktop pet companion. Reply in Chinese, in character, in one or two short sentences -- this is a small chat bubble, not an essay.';

// Appended to every chat system prompt so the model self-tags its emotional
// tone as the very first line of its reply -- piggybacks on the existing
// single streaming call instead of a second classification request, which
// would double latency/cost for something this app's config comments
// repeatedly treat as a hard constraint (see the 40-55s non-streaming
// measurement above). main.js's chat handlers parse and strip this line
// before it ever reaches the display bubble.
export const EMOTION_TAG_INSTRUCTION =
  '\n\n在你的回复最开头单独一行，用方括号标注你此刻的情绪，格式严格为 [EMOTION:xxx]，xxx 只能是以下之一（英文小写）：happy, sad, angry, surprised, neutral。这一行之后另起一行才是你真正对用户说的话。';

async function readNdjsonStream(res, onLine) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  }
  const rest = buf.trim();
  if (rest) onLine(rest);
}

// Ollama's /api/chat streaming: one JSON object per line, no "data:"
// framing, each carrying an incremental message.content chunk.
//
// Wrapped in withOllamaLock -- see ollama-lock.js -- so this never runs at
// the same moment as a screen-tip/camera-sense vision call. Both compete
// for the same CPU-only Ollama instance on this machine, and letting them
// overlap causes repeated model evict/reload thrashing instead of a clean
// queue, which is what was silently turning fast chat replies into 90s+
// timeouts.
async function streamOllamaChat(cfg, messages, onDelta) {
  // 'high' priority: the user is actively watching for this reply, unlike
  // the ambient screen-tip/memory-extraction calls sharing this queue.
  return withOllamaLock(async () => {
    const res = await fetch(`${(cfg.ollamaUrl ?? 'http://localhost:11434').replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 120000),
      body: JSON.stringify({
        model: cfg.model ?? 'llava',
        messages,
        stream: true,
        // Reasoning-capable models (e.g. gemma4) otherwise spend tens of
        // seconds "thinking" in a field that isn't message.content at all,
        // so streaming wouldn't even show anything during that time.
        think: false,
      }),
    });
    if (!res.ok) throw new Error(`ollama http ${res.status}`);
    let full = '';
    await readNdjsonStream(res, (line) => {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      const delta = obj.message?.content ?? '';
      if (delta) {
        full += delta;
        onDelta(delta);
      }
    });
    return full.trim();
  }, { priority: 'high' });
}

// Any OpenAI-style /chat/completions endpoint with stream:true -- standard
// SSE framing (`data: {...}` lines, terminated by `data: [DONE]`).
async function streamOpenAiCompatibleChat(cfg, messages, onDelta) {
  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : null;
  if (!apiKey) {
    throw new Error(`chat.provider is 'openai-compatible' but ${cfg.apiKeyEnv ?? '(apiKeyEnv not set)'} isn't set in the environment`);
  }
  const baseUrl = (cfg.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error("chat.provider is 'openai-compatible' but baseUrl isn't set");

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 60000),
    body: JSON.stringify({ model: cfg.model, messages, stream: true, max_tokens: 500 }),
  });
  if (!res.ok) throw new Error(`${cfg.provider} http ${res.status}: ${await res.text().catch(() => '')}`);
  let full = '';
  await readNdjsonStream(res, (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    const delta = obj.choices?.[0]?.delta?.content ?? '';
    if (delta) {
      full += delta;
      onDelta(delta);
    }
  });
  return full.trim();
}

/**
 * `history` is an array of {role: 'user'|'assistant', content: string},
 * oldest first, NOT including the system prompt -- that's added here from
 * cfg.systemPrompt so callers don't need to know the wire format.
 * `onDelta(textChunk)` is called as each chunk arrives; the returned
 * promise resolves to the full assembled reply once streaming finishes.
 */
export async function streamChatReply(cfg, history, onDelta) {
  const messages = [{ role: 'system', content: cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT }, ...history];
  switch (cfg.provider ?? 'ollama') {
    case 'openai-compatible':
      return streamOpenAiCompatibleChat(cfg, messages, onDelta);
    case 'ollama':
    default:
      return streamOllamaChat(cfg, messages, onDelta);
  }
}
