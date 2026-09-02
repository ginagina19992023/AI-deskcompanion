import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ROWS, ROW_FRAME_COUNTS } from '../src/atlas.js';
import { STATES, createBrain, allowsHeadFollow } from '../src/brain.js';

const ctx = (over = {}) => ({ userIdleMs: 0, cursorMoved: false, arrived: false, ...over });
const seeded = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
const petCfg = (id) => cfg.pets.find((p) => p.id === id);

test('head-follow is allowed only while idle', () => {
  assert.equal(allowsHeadFollow(STATES.IDLE), true);
  for (const s of [STATES.PERFORM, STATES.FILLER, STATES.REST, STATES.WANDER, STATES.DRAG, STATES.SPIN]) {
    assert.equal(allowsHeadFollow(s), false, `${s} must not steal the head`);
  }
});

test('brain starts idle and stays idle before its dwell elapses', () => {
  const brain = createBrain({ rng: seeded([0.5]) });
  assert.equal(brain.state, STATES.IDLE);
  const r = brain.update(1000, ctx());
  assert.equal(r.state, STATES.IDLE);
  assert.equal(r.changed, false);
});

test('brain leaves idle after the dwell window', () => {
  const brain = createBrain({ rng: seeded([0.0]) });
  const r = brain.update(40000, ctx());
  assert.notEqual(r.state, STATES.IDLE);
  assert.equal(r.changed, true);
});

test('randomActionsEnabled: false in ctx never picks PERFORM or FILLER, but still picks WANDER/REST', () => {
  // rng sweeps the whole [0,1) range across calls; with perform+filler
  // weighted out entirely, every roll must land on wander or rest.
  const brain = createBrain({
    rng: seeded([0.05, 0.2, 0.4, 0.6, 0.8, 0.95]),
    profile: { weights: { wander: 0.25, perform: 0.25, filler: 0.25, rest: 0.25 } },
  });
  for (let i = 0; i < 6; i++) {
    brain.forceState(STATES.IDLE);
    const r = brain.update(999999, ctx({ randomActionsEnabled: false }));
    assert.ok(
      r.state === STATES.WANDER || r.state === STATES.REST,
      `expected WANDER or REST, got ${r.state}`,
    );
  }
});

test('randomActionsEnabled defaults to true (undefined ctx field behaves like enabled)', () => {
  const brain = createBrain({
    rng: seeded([0.3]), // with equal weights, [0.25, 0.5) is the PERFORM slice
    profile: { weights: { wander: 0.25, perform: 0.25, filler: 0.25, rest: 0.25 } },
  });
  const r = brain.update(999999, ctx());
  assert.equal(r.state, STATES.PERFORM);
});

test('wanderEnabled: false in ctx never picks WANDER -- regression for the "stuck mid-stride forever" bug', () => {
  // main.js silently no-ops a wander-start while wandering is disabled, so
  // if choose() ever picked WANDER anyway the brain would never receive
  // the "arrived" event needed to leave it -- frozen showing the walk
  // frame indefinitely. Excluding it from the roll is the actual fix.
  const brain = createBrain({
    rng: seeded([0.05, 0.2, 0.4, 0.6, 0.8, 0.95]),
    profile: { weights: { wander: 0.25, perform: 0.25, filler: 0.25, rest: 0.25 } },
  });
  for (let i = 0; i < 6; i++) {
    brain.forceState(STATES.IDLE);
    const r = brain.update(999999, ctx({ wanderEnabled: false }));
    assert.notEqual(r.state, STATES.WANDER, `must never pick WANDER while disabled, got ${r.state}`);
  }
});

test('wanderEnabled and randomActionsEnabled both false still resolves to REST, never a stuck state', () => {
  const brain = createBrain({
    rng: seeded([0.1, 0.5, 0.9]),
    profile: { weights: { wander: 0.25, perform: 0.25, filler: 0.25, rest: 0.25 } },
  });
  for (let i = 0; i < 3; i++) {
    brain.forceState(STATES.IDLE);
    const r = brain.update(999999, ctx({ wanderEnabled: false, randomActionsEnabled: false }));
    assert.equal(r.state, STATES.REST);
  }
});

test('currentRow uses the profile rows, not hardcoded ones', () => {
  const brain = createBrain({
    rng: seeded([0.5]),
    profile: { performRows: [ROWS.REVIEW], restRow: ROWS.REVIEW, fillerRow: ROWS.WAITING },
  });
  brain.forceState(STATES.REST);
  assert.equal(brain.currentRow({}), ROWS.REVIEW);
  brain.forceState(STATES.FILLER);
  assert.equal(brain.currentRow({}), ROWS.WAITING);
  brain.forceState(STATES.IDLE);
  assert.equal(brain.currentRow({}), ROWS.IDLE);
});

test('forceState(REST, { restRow }) overrides the profile restRow, like performRow does for PERFORM', () => {
  const brain = createBrain({ rng: seeded([0.5]), profile: { restRow: ROWS.DOZE } });
  brain.forceState(STATES.REST, { restRow: ROWS.PERCH });
  assert.equal(brain.currentRow({}), ROWS.PERCH);
  // Ordinary REST entry (no opts, e.g. chosen by the idle state machine
  // itself) must still fall back to the profile's row, not leak the
  // previous override.
  brain.forceState(STATES.REST);
  assert.equal(brain.currentRow({}), ROWS.DOZE);
});

test('forceState(REST, { ignoreCursorMoved }) survives a stale cursorMoved on the very next tick', () => {
  // Regression: a forced pose (edge-perch, drag-drop lie-down) is entered
  // right after the pet's own window just moved a lot, so the first
  // cursorMoved reading afterwards is often stale motion, not real input --
  // it used to bounce the pose back to IDLE before it was ever visible.
  const brain = createBrain({ rng: seeded([0.5]) });
  brain.forceState(STATES.REST, { restRow: ROWS.PERCH, ignoreCursorMoved: true });
  const r = brain.update(16, ctx({ cursorMoved: true }));
  assert.equal(r.state, STATES.REST, 'a forced pose must not exit on a stale post-move cursorMoved');
  assert.equal(brain.currentRow({}), ROWS.PERCH);
});

test('ordinary REST (no ignoreCursorMoved) still wakes on the first real cursor move', () => {
  const brain = createBrain({ rng: seeded([0.5]) });
  brain.forceState(STATES.REST);
  const r = brain.update(16, ctx({ cursorMoved: true }));
  assert.equal(r.state, STATES.IDLE);
});

test('movement direction picks the directional rows', () => {
  const brain = createBrain({ rng: seeded([0.5]) });
  brain.forceState(STATES.WANDER);
  assert.equal(brain.currentRow({ movingRight: true }), ROWS.RUN_RIGHT);
  assert.equal(brain.currentRow({ movingRight: false }), ROWS.RUN_LEFT);
});

test('wander ends when the mover reports arrival, not on a timer', () => {
  const brain = createBrain({ rng: seeded([0.5]) });
  brain.forceState(STATES.WANDER);
  assert.equal(brain.update(60000, ctx({ arrived: false })).state, STATES.WANDER);
  assert.equal(brain.update(16, ctx({ arrived: true })).state, STATES.IDLE);
});

test('timed states return to idle after their profile duration', () => {
  const profile = { performMs: 1000, fillerMs: 2000, spinMs: 500 };
  for (const [state, ms] of [
    [STATES.PERFORM, 1000],
    [STATES.FILLER, 2000],
    [STATES.SPIN, 500],
  ]) {
    const brain = createBrain({ rng: seeded([0.5]), profile });
    brain.forceState(state);
    assert.equal(brain.update(ms - 1, ctx()).state, state, `${state} ended early`);
    assert.equal(brain.update(2, ctx()).state, STATES.IDLE, `${state} did not end`);
  }
});

test('rest is interrupted by cursor movement', () => {
  const brain = createBrain({ rng: seeded([0.5]), profile: { restMs: 99999 } });
  brain.forceState(STATES.REST);
  assert.equal(brain.update(16, ctx({ cursorMoved: false })).state, STATES.REST);
  assert.equal(brain.update(16, ctx({ cursorMoved: true })).state, STATES.IDLE);
});

test('drag is only left explicitly, never on a timer', () => {
  const brain = createBrain({ rng: seeded([0.5]) });
  brain.forceState(STATES.DRAG);
  assert.equal(brain.update(120000, ctx({ arrived: true, cursorMoved: true })).state, STATES.DRAG);
  brain.forceState(STATES.IDLE);
  assert.equal(brain.state, STATES.IDLE);
});

test('spinEnabled=false keeps a pet out of the spin easter egg', () => {
  const brain = createBrain({ rng: seeded([0.0]), profile: { spinEnabled: false } });
  for (let i = 0; i < 200; i++) {
    brain.forceState(STATES.IDLE);
    const r = brain.update(40000, ctx({ userIdleMs: 999999 }));
    assert.notEqual(r.state, STATES.SPIN);
  }
});

test('spinEnabled=true can reach spin after long user inactivity', () => {
  const brain = createBrain({ rng: seeded([0.0]), profile: { spinEnabled: true } });
  brain.forceState(STATES.IDLE);
  assert.equal(brain.update(40000, ctx({ userIdleMs: 999999 })).state, STATES.SPIN);
});

test('weights are normalised, so they need not sum to 1', () => {
  const brain = createBrain({
    rng: seeded([0.99]),
    profile: { weights: { wander: 10, perform: 0, filler: 0, rest: 0 } },
  });
  brain.forceState(STATES.IDLE);
  assert.equal(brain.update(40000, ctx()).state, STATES.WANDER);
});

// --- personality checks against the real shipped config -------------------

test('both shipped profiles reference rows that actually exist', () => {
  for (const pet of cfg.pets) {
    const p = pet.profile;
    const rows = [...p.performRows, p.restRow, p.fillerRow];
    for (const row of rows) {
      assert.ok(
        Number.isInteger(row) && row >= 0 && row < ROW_FRAME_COUNTS.length,
        `${pet.id} references non-existent row ${row}`,
      );
    }
    assert.ok(new Set(p.performRows).size === p.performRows.length, `${pet.id} has duplicate perform rows`);
  }
});

test('rowLabels index is the row number; every row has a label except the head-turn sweep', () => {
  for (const pet of cfg.pets) {
    assert.ok(Array.isArray(pet.rowLabels), `${pet.id} is missing rowLabels`);
    // Array index is the row number (see buildFullMenuTemplate in main.js).
    // Rows 9/10 are the raw head-turn sweep, previewed separately via the
    // spin state rather than through the per-row menu, so they're `null`
    // placeholders rather than shifting every later row's index.
    assert.ok(pet.rowLabels.length >= 9, `${pet.id} rowLabels should cover at least rows 0-8`);
    pet.rowLabels.forEach((label, row) => {
      if (row === 9 || row === 10) {
        assert.equal(label, null, `${pet.id} rowLabels[${row}] (head-turn sweep) should be null`);
      } else {
        assert.equal(typeof label, 'string', `${pet.id} rowLabels[${row}] should be a string`);
        assert.ok(label.length > 0, `${pet.id} has an empty row label at row ${row}`);
      }
    });
  }
});

test('ravenRows, when present, only reference real directional/filler rows', () => {
  for (const pet of cfg.pets) {
    const rows = pet.ravenRows ?? [];
    for (const row of rows) {
      assert.ok(
        Number.isInteger(row) && row >= 0 && row < ROW_FRAME_COUNTS.length,
        `${pet.id} ravenRows references non-existent row ${row}`,
      );
    }
  }
});

test('only Sebastian transforms into a raven; Ciel never does', () => {
  // Row 11 (perch) is still front-view raven art -- it belongs in this list
  // alongside the walk/peck rows so arriving at an edge doesn't spuriously
  // fire the feather-transform fx. Row 12 (lie-down) is human, deliberately
  // left out: walking to the bottom as a raven and settling in to sleep
  // *should* trigger the transform.
  assert.deepEqual(petCfg('sebastian-raven').ravenRows, [1, 2, 5, 11]);
  assert.deepEqual(petCfg('ciel-young-master').ravenRows ?? [], []);
});

test('visitChance and edgePerchChance are valid probabilities, and only Sebastian uses them', () => {
  for (const pet of cfg.pets) {
    for (const key of ['visitChance', 'edgePerchChance']) {
      const v = pet.profile[key] ?? 0;
      assert.ok(v >= 0 && v <= 1, `${pet.id}.${key} must be a probability, got ${v}`);
    }
  }
  assert.ok(petCfg('sebastian-raven').profile.visitChance > 0);
  assert.equal(petCfg('ciel-young-master').profile.visitChance, 0, "Ciel doesn't go looking for himself");
  assert.ok(petCfg('sebastian-raven').profile.edgePerchChance > 0);
  assert.equal(petCfg('ciel-young-master').profile.edgePerchChance, 0);
});

test('Sebastian is the restless, ever-watchful one', () => {
  const s = petCfg('sebastian-raven');
  const c = petCfg('ciel-young-master');
  assert.ok(s.profile.weights.wander > c.profile.weights.wander, 'Sebastian should wander more');
  assert.ok(s.profile.wanderSpeed > c.profile.wanderSpeed, 'Sebastian should move faster');
  assert.equal(s.gaze.attentionMs, 0, 'Sebastian never looks away');
  assert.ok(s.gaze.radius > c.gaze.radius, 'Sebastian notices the cursor from further off');
  assert.ok(s.gaze.tau < c.gaze.tau, 'Sebastian reacts faster');
  assert.ok(s.gaze.deadzone < c.gaze.deadzone, 'Sebastian tracks smaller movements');
});

test('every claudeStatusRows entry is a valid, distinct row per pet', () => {
  for (const pet of cfg.pets) {
    const rows = pet.claudeStatusRows;
    assert.ok(rows, `${pet.id} is missing claudeStatusRows`);
    for (const key of ['working', 'review', 'waiting', 'error', 'celebrate']) {
      const row = rows[key];
      assert.ok(
        Number.isInteger(row) && row >= 0 && row < ROW_FRAME_COUNTS.length,
        `${pet.id}.claudeStatusRows.${key} references non-existent row ${row}`,
      );
    }
    const values = Object.values(rows);
    assert.equal(new Set(values).size, values.length, `${pet.id} reuses a row across two different statuses`);
  }
});

test('gaze mode matches what each atlas can actually support', () => {
  // Measured from the sheets, not assumed: Sebastian's rows 9/10 rotate the
  // face relative to the head by +/-21.7px; Ciel's vary by under 2px.
  assert.equal(petCfg('sebastian-raven').gaze.mode, 'frames');
  assert.equal(petCfg('ciel-young-master').gaze.mode, 'lean');
  assert.ok(petCfg('ciel-young-master').gaze.maxLeanPx > 0, 'lean mode needs a lean distance');
});

test('Ciel is the languid, easily-bored one', () => {
  const c = petCfg('ciel-young-master');
  const s = petCfg('sebastian-raven');
  assert.ok(c.gaze.attentionMs > 0, 'Ciel must lose interest');
  assert.ok(c.gaze.reengageDist > 0, 'Ciel needs a re-engage threshold');
  assert.ok(c.profile.weights.rest > s.profile.weights.rest, 'Ciel rests more');
  assert.ok(c.profile.idleDwellMs[0] > s.profile.idleDwellMs[0], 'Ciel acts less often');
  assert.equal(c.profile.spinEnabled, false, 'Ciel has no dramatic 360 head spin art');
});
