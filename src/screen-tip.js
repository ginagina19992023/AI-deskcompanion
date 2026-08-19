// Periodic screen-context tips via a vision model -- a *local* one via
// Ollama by default, or a cloud API (anything with an OpenAI-compatible
// chat/completions endpoint, e.g. DeepSeek) if you configure one. Main
// process only: desktopCapturer and fetch-to-a-network-endpoint have no
// business in the renderer's module graph.
//
// Privacy: with the default 'ollama' provider, the screenshot and the
// model's response never leave this machine -- the only network call is to
// `ollamaUrl`, which defaults to http://localhost:11434 and is expected to
// stay localhost. Switching `provider` to 'openai-compatible' means the
// cropped screenshot IS sent off-machine, to whatever `baseUrl` you point
// it at -- that's an explicit opt-in, not the default. Nothing is written
// to disk either way. If the provider is unreachable or misconfigured,
// this fails silently and keeps retrying on the same interval -- an
// optional ambient feature should never nag or crash the app over it.

import { desktopCapturer, screen } from 'electron';

const DEFAULT_PROMPT =
  'Describe what is on this computer screen in one short sentence.';

// Ollama's /api/generate: local, no auth, single base64 image per call.
async function callOllama(cfg, base64) {
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
}

// Any provider exposing an OpenAI-style /chat/completions endpoint with
// vision support -- DeepSeek and most other hosted vision APIs included.
// The API key is read from an environment variable named by
// cfg.apiKeyEnv, never from config.json -- keeps a real credential out of
// a file that's easy to accidentally share/commit.
async function callOpenAiCompatible(cfg, base64) {
  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : null;
  if (!apiKey) {
    throw new Error(
      `screenTips.provider is 'openai-compatible' but ${cfg.apiKeyEnv ?? '(apiKeyEnv not set)'} isn't set in the environment`,
    );
  }
  const baseUrl = (cfg.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error("screenTips.provider is 'openai-compatible' but baseUrl isn't set");

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

async function callVisionModel(cfg, base64) {
  switch (cfg.provider ?? 'ollama') {
    case 'openai-compatible':
      return callOpenAiCompatible(cfg, base64);
    case 'ollama':
    default:
      return callOllama(cfg, base64);
  }
}

// Just the capture+crop, no model call -- shared by captureAndDescribe
// below and by chat's "screenshot and ask" flow, which needs the raw image
// itself (to hand straight to a vision-capable chat model) rather than a
// pre-baked text description of it. Returns null if there was nothing to
// capture (e.g. no display source).
export async function captureCroppedScreenshot(cfg = {}) {
  // Capture at (near) full physical resolution rather than a small
  // thumbnail -- a downscaled whole-screen glance has no detail left to
  // crop from. The model still only ever sees a small image (see the
  // crop+resize below); this just controls what that small image is *of*.
  const display = screen.getPrimaryDisplay();
  const scaleFactor = display.scaleFactor || 1;
  const physW = Math.round(display.size.width * scaleFactor);
  const physH = Math.round(display.size.height * scaleFactor);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: physW, height: physH },
  });
  const primary = sources[0];
  if (!primary || primary.thumbnail.isEmpty()) return null;

  // Crop to a window around the *cursor*, not the whole monitor -- otherwise
  // the tip is about whatever happens to be biggest on screen, unrelated to
  // where the user is actually looking/working.
  const full = primary.thumbnail.getSize();
  const cursor = screen.getCursorScreenPoint(); // DIP
  const cx = Math.round(cursor.x * scaleFactor);
  const cy = Math.round(cursor.y * scaleFactor);
  const cropSize = Math.min(cfg.cropSize ?? 900, full.width, full.height);
  const cropRect = {
    x: Math.max(0, Math.min(full.width - cropSize, cx - cropSize / 2)),
    y: Math.max(0, Math.min(full.height - cropSize, cy - cropSize / 2)),
    width: cropSize,
    height: cropSize,
  };
  const focused = primary.thumbnail.crop(cropRect).resize({ width: cfg.thumbnailSize ?? 640 });
  return focused.toPNG().toString('base64');
}

// The full ambient-tip work: capture + ask the vision model for a text
// description. Returns null if there was nothing to capture, throws on a
// real error (network, model).
export async function captureAndDescribe(cfg = {}) {
  const base64 = await captureCroppedScreenshot(cfg);
  if (!base64) return null;
  const text = await callVisionModel(cfg, base64);
  if (!text) return null;
  return { text, ts: Date.now(), imageBase64: base64 };
}

export function createScreenTipWatcher({ cfg = {}, onTip, onError, isPaused } = {}) {
  let timer = null;
  let stopped = false;

  // `force` is set by the manual trigger() below -- bypasses isPaused (a
  // deliberate "look right now" request should work even while the
  // ambient timer is paused). Never throws (setTimeout(tick, ms) below
  // calls this bare, with no catch of its own) -- errors go through
  // onError same as always; trigger() re-derives a rejection from the
  // returned shape for its own caller instead.
  async function tick(force = false) {
    if (stopped) return { ok: true, tip: null };
    let result = null;
    let failure = null;
    try {
      if (force || !isPaused?.()) {
        result = await captureAndDescribe(cfg);
        // Manual trigger() calls get their own source tag so the history
        // filter can tell "you asked for this one look" apart from the
        // regular timer -- both still land in the same watcher/onTip, this
        // is the only thing that distinguishes them downstream.
        if (result && force) result.source = 'manual';
        if (result) onTip?.(result);
      }
    } catch (err) {
      onError?.(err);
      failure = err;
    } finally {
      if (!stopped && !force) timer = setTimeout(tick, cfg.intervalMs ?? 90000);
    }
    return failure ? { ok: false, error: failure } : { ok: true, tip: result };
  }

  // Small initial delay so this never fires before the window itself is up.
  timer = setTimeout(tick, 3000);

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    // Manual "look right now" -- cancels whatever's pending on the normal
    // interval and reschedules fresh from this point, so triggering it
    // doesn't just mean an extra look on top of the one already due soon.
    // Resolves with the new tip, or rejects with the capture/model error,
    // for a caller that wants to await a concrete result (unlike the
    // timer-driven path, which only ever reports through onTip/onError).
    async trigger() {
      clearTimeout(timer);
      const { ok, tip, error } = await tick(true);
      if (!stopped) timer = setTimeout(tick, cfg.intervalMs ?? 90000);
      if (!ok) throw error;
      return tip;
    },
  };
}
