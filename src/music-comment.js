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

export function pickMusicComment(samples, taste, random = Math.random) {
  const mood = classifyMusicPulse(samples);
  const lines = taste?.[`${mood}Lines`] ?? taste?.neutralLines ?? [];
  if (!lines.length) return null;
  const index = Math.min(lines.length - 1, Math.floor(Math.max(0, random()) * lines.length));
  return { mood, text: lines[index] };
}
