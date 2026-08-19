const TAU = Math.PI * 2;
export const CLAUDE_SUN_RAY_COUNT = 10;

export function contextSunMotion(nowMs = 0) {
  const safeNow = Number.isFinite(nowMs) ? nowMs : 0;
  const breathPhase = (safeNow % 3200) / 3200;
  const swayPhase = (safeNow % 5200) / 5200;
  const blinkPhase = safeNow % 4300;

  return {
    scale: 1 + Math.sin(breathPhase * TAU) * 0.045,
    rotation: Math.sin(swayPhase * TAU) * 0.075,
    rayPulse: 0.5 + 0.5 * Math.sin(breathPhase * TAU),
    blink: (blinkPhase >= 3320 && blinkPhase < 3460) || (blinkPhase >= 3580 && blinkPhase < 3660),
  };
}
