function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function classifyMusicPulse(samples) {
  const usable = samples.filter((s) => Number.isFinite(s?.energy) && Number.isFinite(s?.ts));
  if (usable.length < 6) return 'neutral';
  const energy = median(usable.map((s) => s.energy));
  const intervals = usable.slice(1).map((s, i) => s.ts - usable[i].ts).filter((v) => v > 0 && v < 4000);
  const interval = intervals.length ? median(intervals) : 700;
  if (energy <= 0.075 && interval >= 430) return 'delicate';
  if (energy >= 0.13 || interval <= 320) return 'intense';
  return 'neutral';
}

// Generic, character-neutral fallback for English -- the per-pet lines in
// config.json (delicateLines/neutralLines/intenseLines) are hand-written in
// the character's own voice and only exist in Chinese, so this only kicks
// in when lang is 'en' and the pet config hasn't grown an English-specific
// pool of its own (delicateLinesEn etc, checked first below).
const GENERIC_EN_LINES = {
  delicate: ['A quiet, gentle tune -- rather soothing.', 'Soft and understated. Not bad at all.'],
  neutral: ['A decent rhythm, nothing more, nothing less.', 'Ordinary, but not unpleasant.'],
  intense: ['Quite an energetic beat, that one.', 'Loud and lively -- a bit much, but lively.'],
};

export function pickMusicComment(samples, taste, random = Math.random, lang = 'zh') {
  const mood = classifyMusicPulse(samples);
  const lines =
    (lang === 'en' && taste?.[`${mood}LinesEn`]) ||
    (lang === 'en' && GENERIC_EN_LINES[mood]) ||
    (taste?.[`${mood}Lines`] ?? taste?.neutralLines ?? []);
  if (!lines.length) return null;
  const index = Math.min(lines.length - 1, Math.floor(Math.max(0, random()) * lines.length));
  return { mood, text: lines[index] };
}
