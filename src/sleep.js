// Pure schedule math for the late-night sleep pose, kept separate from
// renderer.js so it can be unit tested without a DOM/canvas.

/**
 * Is `now` within the configured sleep window? Handles windows that wrap
 * past midnight (e.g. startHour=23, endHour=6) the same as ones that
 * don't (startHour=1, endHour=6) -- a plain `hour >= start && hour < end`
 * only works for the non-wrapping case.
 */
export function isWithinSleepWindow(cfg, now) {
  if (!cfg?.enabled) return false;
  const { startHour, endHour } = cfg;
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return false;
  if (startHour === endHour) return false; // a zero-width window is never active
  const hour = now.getHours();
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  return hour >= startHour || hour < endHour;
}

/**
 * Which row to show while asleep, for the current pet. Only pets with the
 * 13-row extension have a real lying-down pose (row 12); everyone else
 * falls back to their profile's ordinary rest row -- a believable "settled
 * for the night" rather than the wrong species/pose.
 */
export function sleepRowFor(pet, rows) {
  if (pet?.hasExtendedRows && Number.isInteger(rows?.LIE_DOWN)) return rows.LIE_DOWN;
  return Number.isInteger(pet?.profile?.restRow) ? pet.profile.restRow : null;
}
