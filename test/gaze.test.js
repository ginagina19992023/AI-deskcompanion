import test from 'node:test';
import assert from 'node:assert/strict';
import { createGaze } from '../src/head.js';

// Drive the gaze for a number of milliseconds at 60fps.
function run(gaze, dx, dy, ms, enabled = true) {
  const dt = 1 / 60;
  let out;
  for (let t = 0; t < ms; t += dt * 1000) out = gaze.update(dx, dy, dt, enabled);
  return out;
}

test('an attentive gaze (attentionMs=0) never disengages', () => {
  const gaze = createGaze({ attentionMs: 0, radius: 900, tau: 0.1 });
  const out = run(gaze, 400, 0, 30000);
  assert.equal(out.engaged, true, 'Sebastian must still be watching after 30s');
  assert.ok(out.yaw > 30, 'and still turned toward the cursor');
});

test('a bored gaze disengages after attentionMs and returns to front', () => {
  const gaze = createGaze({ attentionMs: 2600, radius: 520, tau: 0.22 });
  const during = run(gaze, 300, 0, 1500);
  assert.equal(during.engaged, true, 'should look at first');
  assert.ok(during.yaw > 5, 'and be turned');

  const after = run(gaze, 300, 0, 4000);
  assert.equal(after.engaged, false, 'Ciel should have lost interest');
  assert.ok(Math.abs(after.yaw) < 2, 'and returned to facing front');
});

test('a large cursor move wins a lost gaze back', () => {
  const gaze = createGaze({ attentionMs: 800, radius: 900, reengageDist: 150 });
  run(gaze, 300, 0, 2000);
  assert.equal(gaze.aloof, true);

  // A small twitch is beneath his notice.
  const small = run(gaze, 320, 0, 200);
  assert.equal(small.engaged, false, 'a 20px twitch must not re-engage');

  // A decisive move does not go unanswered.
  const big = run(gaze, 300 + 200, 0, 200);
  assert.equal(big.engaged, true, 'a 200px move must re-engage');
});

test('a cursor outside the radius is never followed', () => {
  const gaze = createGaze({ radius: 300 });
  const out = run(gaze, 1000, 0, 2000);
  assert.equal(out.engaged, false);
  assert.ok(Math.abs(out.yaw) < 1, 'head stays front when nothing is worth watching');
});

test('a disabled gaze unwinds to front even with the cursor right there', () => {
  const gaze = createGaze({ radius: 900 });
  run(gaze, 400, 0, 1000);
  const out = run(gaze, 400, 0, 2000, false);
  assert.equal(out.engaged, false);
  assert.ok(Math.abs(out.yaw) < 1);
});

test('deadzone decides when a turn frame replaces the idle loop', () => {
  const wide = createGaze({ deadzone: 14, radius: 900, tau: 0.05 });
  const narrow = createGaze({ deadzone: 6, radius: 900, tau: 0.05 });
  // A small offset: ~10 degrees of yaw.
  const dx = 50;
  const w = run(wide, dx, 0, 1000);
  const n = run(narrow, dx, 0, 1000);
  assert.equal(w.showTurnFrame, false, 'Ciel ignores a small offset');
  assert.equal(n.showTurnFrame, true, 'Sebastian reacts to it');
});

test('lean mode never swaps in a turn frame', () => {
  // Ciel's rows 9/10 carry no directional gaze (measured: face-vs-head offset
  // varies 1.9px, iris offset +/-0.8px), so they must never be used to follow.
  const gaze = createGaze({ mode: 'lean', radius: 900, deadzone: 6, tau: 0.05, maxLeanPx: 7 });
  const out = run(gaze, 600, 0, 2000);
  assert.ok(Math.abs(out.yaw) > 20, 'yaw is still tracked internally');
  assert.equal(out.showTurnFrame, false, 'but no turn frame may be shown');
});

test('lean mode leans toward the cursor and unwinds when disengaged', () => {
  const gaze = createGaze({ mode: 'lean', radius: 500, tau: 0.05, maxLeanPx: 7 });
  const right = run(gaze, 500, 0, 1500);
  assert.ok(right.lean > 4, `expected a rightward lean, got ${right.lean}`);

  const left = run(gaze, -500, 0, 1500);
  assert.ok(left.lean < -4, `expected a leftward lean, got ${left.lean}`);

  const away = run(gaze, -500, 0, 1500, false);
  assert.ok(Math.abs(away.lean) < 0.5, 'lean returns to neutral when not looking');
});

test('lean is capped at maxLeanPx', () => {
  const gaze = createGaze({ mode: 'lean', radius: 100, tau: 0.05, maxLeanPx: 7 });
  const out = run(gaze, 99, 0, 2000);
  assert.ok(Math.abs(out.lean) <= 7.001, `lean ${out.lean} exceeded the cap`);
});

test('frames mode does not lean', () => {
  const gaze = createGaze({ mode: 'frames', radius: 900, tau: 0.05, maxLeanPx: 0 });
  const out = run(gaze, 600, 0, 2000);
  assert.equal(out.lean, 0);
  assert.equal(out.showTurnFrame, true);
});

test('reset clears a lost gaze', () => {
  const gaze = createGaze({ attentionMs: 500, radius: 900 });
  run(gaze, 300, 0, 1500);
  assert.equal(gaze.aloof, true);
  gaze.reset();
  assert.equal(gaze.aloof, false);
});
