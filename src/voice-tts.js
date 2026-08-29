// Renderer-side only: window.speechSynthesis doesn't exist in the main
// process. Kept separate from voice-stt.js, which is main-process-only
// for the opposite reason (node:child_process doesn't exist in the
// renderer).

/** Pick a voice by exact name from speechSynthesis.getVoices()'s list. Null = system default. */
export function resolveVoice(voices, name) {
  if (!name) return null;
  return voices.find((v) => v.name === name) ?? null;
}

/**
 * Speak `text` aloud if cfg.enabled. Tries the main process's configured
 * engine first (Piper/Edge, see pet:synthesize-speech in main.js) and plays
 * back the resulting audio file; falls back to the browser's own
 * speechSynthesis whenever that returns null (engine set to 'sapi', or any
 * failure in the fallback chain already exhausted on the main-process
 * side) so this never ends up silent.
 */
export async function speak(text, cfg = {}) {
  if (!cfg.enabled || !text) return;
  const synthesizeSpeech = window.pet?.synthesizeSpeech ?? window.dash?.synthesizeSpeech;
  if (synthesizeSpeech) {
    try {
      const { fileUrl } = await synthesizeSpeech(text);
      if (fileUrl) {
        const audio = new Audio(fileUrl);
        audio.volume = cfg.volume ?? 1.0;
        audio.playbackRate = cfg.rate ?? 1.0;
        await audio.play();
        return;
      }
    } catch {
      // Falls through to the browser voice below -- a playback error here
      // (e.g. a corrupt temp file) shouldn't mean total silence.
    }
  }
  speakBrowser(text, cfg);
}

function speakBrowser(text, cfg) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const utter = new SpeechSynthesisUtterance(text);
  const voice = resolveVoice(window.speechSynthesis.getVoices(), cfg.voiceName);
  if (voice) utter.voice = voice;
  utter.rate = cfg.rate ?? 1.0;
  utter.pitch = cfg.pitch ?? 1.0;
  utter.volume = cfg.volume ?? 1.0;
  window.speechSynthesis.speak(utter);
}
