// Pure pomodoro-timer math. main.js owns the actual setTimeout/IPC; this is
// just "given a state and a clock reading, what's true" so it's testable
// without touching Electron.

export function startPomodoro(durationMs, now = Date.now()) {
  return { startedAt: now, durationMs, endsAt: now + durationMs };
}

export function pomodoroRemainingMs(state, now = Date.now()) {
  if (!state) return 0;
  return Math.max(0, state.endsAt - now);
}

export function isPomodoroDone(state, now = Date.now()) {
  return !!state && now >= state.endsAt;
}
