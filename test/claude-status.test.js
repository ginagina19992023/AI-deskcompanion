import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeOverrideRow, filterStaleRateLimits } from '../src/claude-status.js';

const rows = { working: 8, waiting: 6, error: 5 };
const cfg = { enabled: true, staleMs: 120000 };

test('returns null when the brain is not idle -- never interrupts wander/drag/visit', () => {
  const status = { status: 'working', ts: 1000 };
  assert.equal(claudeOverrideRow(cfg, status, rows, false, 1000), null);
});

test('returns null when disabled', () => {
  const status = { status: 'working', ts: 1000 };
  assert.equal(claudeOverrideRow({ enabled: false }, status, rows, true, 1000), null);
});

test('returns null when there is no status yet', () => {
  assert.equal(claudeOverrideRow(cfg, null, rows, true, 1000), null);
});

test('status "idle" defers to normal personality behaviour, not a special row', () => {
  const status = { status: 'idle', ts: 1000 };
  assert.equal(claudeOverrideRow(cfg, status, rows, true, 1000), null);
});

test('maps a fresh working/waiting/error status to its configured row', () => {
  assert.equal(claudeOverrideRow(cfg, { status: 'working', ts: 1000 }, rows, true, 1000), 8);
  assert.equal(claudeOverrideRow(cfg, { status: 'waiting', ts: 1000 }, rows, true, 1000), 6);
  assert.equal(claudeOverrideRow(cfg, { status: 'error', ts: 1000 }, rows, true, 1000), 5);
});

test('an unmapped status (pet has no row for it) is ignored', () => {
  const status = { status: 'review', ts: 1000 }; // not in `rows`
  assert.equal(claudeOverrideRow(cfg, status, rows, true, 1000), null);
});

test('a stale status is ignored so the pet never gets stuck mid-pose forever', () => {
  const status = { status: 'working', ts: 1000 };
  assert.equal(claudeOverrideRow(cfg, status, rows, true, 1000 + 120000), 8, 'exactly at the boundary still counts');
  assert.equal(claudeOverrideRow(cfg, status, rows, true, 1000 + 120001), null, 'one ms past the boundary is stale');
});

test('staleMs is configurable per pet/config', () => {
  const status = { status: 'working', ts: 1000 };
  const shortCfg = { enabled: true, staleMs: 5000 };
  assert.equal(claudeOverrideRow(shortCfg, status, rows, true, 1000 + 4000), 8);
  assert.equal(claudeOverrideRow(shortCfg, status, rows, true, 1000 + 6000), null);
});

test('an invalid timestamp is treated as stale rather than throwing', () => {
  assert.equal(claudeOverrideRow(cfg, { status: 'working', ts: NaN }, rows, true, 1000), null);
  assert.equal(claudeOverrideRow(cfg, { status: 'working' }, rows, true, 1000), null);
});

// filterStaleRateLimits -- the official statusLine hook that writes these
// numbers doesn't fire reliably in every harness, so a stale snapshot can
// otherwise get displayed as if it were still live.
test('filterStaleRateLimits: null input stays null', () => {
  assert.equal(filterStaleRateLimits(null, 1000, 60000), null);
});

test('filterStaleRateLimits: a fresh snapshot with no reset times passes through unchanged', () => {
  const raw = { ts: 1000, fiveHourUsedPercent: 62, weekUsedPercent: 38 };
  assert.deepEqual(filterStaleRateLimits(raw, 1000, 60000), raw);
});

test('filterStaleRateLimits: staleness boundary is inclusive at exactly staleMs, stale one ms past it', () => {
  const raw = { ts: 1000, fiveHourUsedPercent: 62, weekUsedPercent: 38 };
  assert.notEqual(filterStaleRateLimits(raw, 1000 + 60000, 60000), null, 'exactly at the boundary still counts');
  assert.equal(filterStaleRateLimits(raw, 1000 + 60001, 60000), null, 'one ms past the boundary is stale');
});

test('filterStaleRateLimits: a missing/invalid ts is treated as stale rather than throwing', () => {
  assert.equal(filterStaleRateLimits({ fiveHourUsedPercent: 62 }, 1000, 60000), null);
  assert.equal(filterStaleRateLimits({ ts: NaN, fiveHourUsedPercent: 62 }, 1000, 60000), null);
});

test('filterStaleRateLimits: nulls out only the window whose own reset time has passed', () => {
  const raw = {
    ts: 1000,
    fiveHourUsedPercent: 62,
    fiveHourResetsAt: 1500, // already passed by "now" below
    weekUsedPercent: 38,
    weekResetsAt: 9000, // still in the future
  };
  const result = filterStaleRateLimits(raw, 2000, 60000);
  assert.equal(result.fiveHourUsedPercent, null, 'the 5h window already reset -- the old percentage is no longer true');
  assert.equal(result.weekUsedPercent, 38, 'the weekly window has not reset yet -- still valid');
});

test('filterStaleRateLimits: this exact real bug -- a many-hours-old snapshot past its own resetsAt is dropped, not shown', () => {
  const nowMs = 1786306873000; // "now" from the session that surfaced this bug
  const raw = {
    ts: 1786270547070, // ~10 hours earlier
    fiveHourUsedPercent: 62,
    fiveHourResetsAt: 1786282000000, // already passed
    weekUsedPercent: 38,
    weekResetsAt: 1786700400000, // still in the future, but irrelevant -- whole snapshot is stale
  };
  assert.equal(filterStaleRateLimits(raw, nowMs, 1800000), null);
});
