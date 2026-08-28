// Renderer-side only: window.speechSynthesis doesn't exist in the main
// process. Kept separate from voice-stt.js, which is main-process-only
// for the opposite reason (node:child_process doesn't exist in the
// renderer).

/** Pick a voice by exact name from speechSynthesis.getVoices()'s list. Null = system default. */
export function resolveVoice(voices, name) {
  if (!name) return null;
  return voices.find((v) => v.name === name) ?? null;
}

/** Speak `text` aloud if cfg.enabled. No-op (not an error) if speechSynthesis is unavailable. */
export function speak(text, cfg = {}) {
  if (!cfg.enabled || !text) return;
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const utter = new SpeechSynthesisUtterance(text);
  const voice = resolveVoice(window.speechSynthesis.getVoices(), cfg.voiceName);
  if (voice) utter.voice = voice;
  utter.rate = cfg.rate ?? 1.0;
  utter.pitch = cfg.pitch ?? 1.0;
  utter.volume = cfg.volume ?? 1.0;
  window.speechSynthesis.speak(utter);
}
