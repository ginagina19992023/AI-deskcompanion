const TAU = Math.PI * 2;
export const CLAUDE_SUN_RAY_COUNT = 10;

// intensity multiplies the breathing amplitude only (not its speed) --
// used to make the badge visibly more agitated once 5-hour usage crosses
// 80%, without changing how often it breathes.
export function contextSunMotion(nowMs = 0, intensity = 1) {
  const safeNow = Number.isFinite(nowMs) ? nowMs : 0;
  const breathPhase = (safeNow % 3200) / 3200;
  const swayPhase = (safeNow % 5200) / 5200;
  const blinkPhase = safeNow % 4300;
  const breath = Math.sin(breathPhase * TAU);

  return {
    scale: 1 + breath * 0.045 * intensity,
    rotation: Math.sin(swayPhase * TAU) * 0.075 * intensity,
    rayPulse: Math.max(0, Math.min(1, 0.5 + 0.5 * breath * intensity)),
    blink: (blinkPhase >= 3320 && blinkPhase < 3460) || (blinkPhase >= 3580 && blinkPhase < 3660),
  };
}
