// Pure decision logic for overriding the pet's pose with Claude Code's
// current activity, as reported by hooks writing to ~/.claude/pet-status.json.
//
// This only decides *whether* and *which row* to show; polling the file and
// drawing the frame live in main.js/renderer.js.

/**
 * @param {{enabled?: boolean, staleMs?: number}} cfg
 * @param {{status: string, ts: number}|null} claudeStatus
 * @param {Record<string, number>|undefined} statusRows - per-pet mapping,
 *   e.g. { working: 8, waiting: 6, error: 5 }
 * @param {boolean} brainIsIdle - only preempt the pet's own idle behaviour;
 *   never interrupt a wander, drag, visit, or edge-perch already in progress
 * @param {number} nowMs
 * @returns {number|null} the row to display, or null to defer to normal behaviour
 */
export function aiActivityOverrideRow(cfg, claudeStatus, statusRows, brainIsIdle, nowMs) {
  if (!brainIsIdle) return null;
  if (!cfg?.enabled || !claudeStatus) return null;
  if (claudeStatus.status === 'idle') return null;

  const staleMs = cfg.staleMs ?? 120000;
  if (!Number.isFinite(claudeStatus.ts) || nowMs - claudeStatus.ts > staleMs) return null;

  const row = statusRows?.[claudeStatus.status];
  return Number.isInteger(row) ? row : null;
}

// Backward-compatible export for existing pet packs/tests.
export const claudeOverrideRow = aiActivityOverrideRow;

// The official statusLine hook (which writes account-wide 5h/weekly rate
// limits) doesn't fire reliably in every harness -- confirmed going quiet
// for hours at a time in one real environment while the separate
// PreToolUse/UserPromptSubmit hooks kept firing throughout. Left unfiltered,
// the last snapshot it wrote gets displayed as if live long after it's
// stopped being true, including past its own recorded resetsAt (which a
// real reset would already have zeroed) -- reads as fabricated numbers, not
// just outdated ones. Drops the whole snapshot once it's older than
// staleMs, and independently nulls out either window whose own reset time
// has already passed even if the snapshot itself is still fresh enough.
/**
 * @param {{ts?: number, fiveHourUsedPercent?: number|null, fiveHourResetsAt?: number|null, weekUsedPercent?: number|null, weekResetsAt?: number|null}|null} raw
 * @param {number} nowMs
 * @param {number} staleMs
 */
export function filterStaleRateLimits(raw, nowMs, staleMs) {
  if (!raw || !Number.isFinite(raw.ts) || nowMs - raw.ts > staleMs) return null;
  return {
    ...raw,
    fiveHourUsedPercent: Number.isFinite(raw.fiveHourResetsAt) && nowMs > raw.fiveHourResetsAt ? null : raw.fiveHourUsedPercent,
    weekUsedPercent: Number.isFinite(raw.weekResetsAt) && nowMs > raw.weekResetsAt ? null : raw.weekUsedPercent,
  };
}
