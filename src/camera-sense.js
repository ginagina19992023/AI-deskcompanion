// Webcam-driven counterpart to screen-tip.js: same "periodic capture ->
// vision model -> reaction" shape, but the capture step is a caller-
// supplied getFrame() rather than a hardcoded desktopCapturer call --
// Electron's desktopCapturer only covers screens/windows, not physical
// cameras, and a webcam frame has to come from the renderer's
// getUserMedia. Keeping getFrame() as a parameter (rather than importing
// a fixed implementation here) is also the seam a future non-webcam
// frame source (e.g. a robot's own camera) would plug into -- this file
// never assumes where the frame came from.
//
// `visionCall` defaults to the real callVisionModel but is injectable so
// tests don't need a live Ollama server.
import { callVisionModel } from './vision-provider.js';

export async function captureAndDescribe(cfg = {}, getFrame, visionCall = callVisionModel) {
  const base64 = await getFrame();
  if (!base64) return null;
  const text = await visionCall(cfg, base64);
  if (!text) return null;
  return { text, ts: Date.now(), imageBase64: base64, source: 'camera' };
}

export function createCameraSenseWatcher({ cfg = {}, getFrame, onTip, onError, isPaused, visionCall } = {}) {
  let timer = null;
  let stopped = false;

  async function tick(force = false) {
    if (stopped) return { ok: true, tip: null };
    let result = null;
    let failure = null;
    try {
      if (force || !isPaused?.()) {
        result = await captureAndDescribe(cfg, getFrame, visionCall);
        if (result) onTip?.(result);
      }
    } catch (err) {
      onError?.(err);
      failure = err;
    } finally {
      if (!stopped && !force) timer = setTimeout(tick, cfg.intervalMs ?? 120000);
    }
    return failure ? { ok: false, error: failure } : { ok: true, tip: result };
  }

  timer = setTimeout(tick, 3000);

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    async trigger() {
      clearTimeout(timer);
      const { ok, tip, error } = await tick(true);
      if (!stopped) timer = setTimeout(tick, cfg.intervalMs ?? 120000);
      if (!ok) throw error;
      return tip;
    },
  };
}
