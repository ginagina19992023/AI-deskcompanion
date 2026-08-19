// Awareness of the *other* desktop pet -- the one the Codex/ChatGPT app draws
// in its own click-through overlay window.
//
// Everything here is read-only observation of a window rectangle. Nothing
// attaches to, injects into, or modifies the Codex process.
//
// IMPORTANT: this module is imported by the renderer, which runs with
// nodeIntegration disabled. It must stay free of node: imports -- the process
// spawning lives in companion-watcher.js, which only the main process loads.

/** Parse one JSON line from the watcher. Returns null for junk. */
export function parseWatcherLine(line) {
  const text = String(line ?? '').trim();
  if (!text || text[0] !== '{') return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || data.present !== true) {
    const absent = { present: false };
    // Diagnostics the watcher may attach so a silent "absent" is explainable.
    if (Number.isFinite(data?.pids)) absent.pids = data.pids;
    if (Number.isFinite(data?.scanned)) absent.scanned = data.scanned;
    return absent;
  }
  const { x, y, w, h } = data;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { present: true, x, y, w, h };
}

/**
 * Where the companion sprite actually is inside its overlay window.
 *
 * The overlay is much larger than the sprite (measured: a 613x602 window
 * holding a 168x261 sprite), so the rect alone would point at empty air.
 * Fractions measured from a real capture; the sprite may drift within the
 * window, so treat this as accurate to a few tens of pixels.
 */
export function companionAnchor(rect, anchor = {}) {
  const fx = anchor.fx ?? 0.498;
  const fyHead = anchor.fyHead ?? 0.572;
  return {
    x: rect.x + rect.w * fx,
    y: rect.y + rect.h * fyHead,
  };
}

/**
 * Decides when to greet. Bows on the *transition* into range, never
 * repeatedly while the companion loiters nearby, and not more often than
 * the cooldown allows.
 */
export function createGreeter({ nearDist = 420, cooldownMs = 25000 } = {}) {
  let wasNear = false;
  let lastGreetAt = -Infinity;

  return {
    get near() {
      return wasNear;
    },
    reset() {
      wasNear = false;
    },
    /** @returns {boolean} true exactly on the frames a greeting should start */
    update(distance, nowMs) {
      const isNear = Number.isFinite(distance) && distance <= nearDist;
      const entering = isNear && !wasNear;
      wasNear = isNear;
      if (!entering) return false;
      if (nowMs - lastGreetAt < cooldownMs) return false;
      lastGreetAt = nowMs;
      return true;
    },
  };
}
