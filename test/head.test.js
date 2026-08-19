import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEAD_DEPTH,
  yawToCursor,
  smoothYaw,
  yawToFrame,
  pickFrame,
  tiltFromCursor,
  isFollowing,
  subFrameResidual,
  angleGap,
  extendedYawForCursor,
} from '../src/head.js';

test('yaw is 0 when the cursor is directly above or below the head', () => {
  assert.equal(yawToCursor(0, -300), 0);
  assert.equal(yawToCursor(0, 300), 0);
});

test('yaw is 45 degrees when dx equals HEAD_DEPTH', () => {
  assert.ok(Math.abs(yawToCursor(HEAD_DEPTH, 0) - 45) < 1e-9);
  assert.ok(Math.abs(yawToCursor(-HEAD_DEPTH, 0) + 45) < 1e-9);
});

test('yaw sign: cursor right is positive, cursor left is negative', () => {
  assert.ok(yawToCursor(500, 0) > 0);
  assert.ok(yawToCursor(-500, 0) < 0);
});

test('yaw is clamped to +/-90', () => {
  assert.ok(yawToCursor(1e9, 0) <= 90);
  assert.ok(yawToCursor(-1e9, 0) >= -90);
});

test('yawToFrame maps front to 0 and right profile to 4', () => {
  assert.equal(yawToFrame(0), 0);
  assert.equal(yawToFrame(90), 4);
  assert.equal(yawToFrame(22.5), 1);
});

test('yawToFrame wraps negative yaw into the row-10 half', () => {
  assert.equal(yawToFrame(-90), 12, '-90deg == 270deg == the left profile');
  assert.equal(yawToFrame(-22.5), 15);
});

test('yawToFrame never returns a back-facing frame within +/-90', () => {
  for (let yaw = -90; yaw <= 90; yaw += 1) {
    const k = yawToFrame(yaw);
    assert.ok(k <= 4 || k >= 12, `yaw ${yaw} produced back-facing frame ${k}`);
  }
});

test('yawToFrame always returns a valid index', () => {
  for (let yaw = -90; yaw <= 90; yaw += 0.5) {
    const k = yawToFrame(yaw);
    assert.ok(Number.isInteger(k) && k >= 0 && k < 16);
  }
});

test('smoothYaw moves toward the target and converges', () => {
  const next = smoothYaw(0, 90, 0.016, 0.12);
  assert.ok(next > 0 && next < 90);
  let y = 0;
  for (let i = 0; i < 200; i++) y = smoothYaw(y, 90, 0.016, 0.12);
  assert.ok(Math.abs(y - 90) < 0.5);
});

test('smoothYaw with dt=0 does not move', () => {
  assert.equal(smoothYaw(10, 90, 0, 0.12), 10);
});

test('a smaller tau converges faster', () => {
  // This is the knob that makes Sebastian alert and Ciel languid.
  const quick = smoothYaw(0, 90, 0.016, 0.1);
  const slow = smoothYaw(0, 90, 0.016, 0.22);
  assert.ok(quick > slow, 'tau 0.10 must outpace tau 0.22');
});

test('pickFrame holds the previous frame just past the boundary', () => {
  // The 0|1 boundary is 11.25deg. At 13deg naive rounding already says frame 1,
  // but it is still 9.5deg from frame 1's centre (22.5) -- outside the 8deg
  // band -- so the frame must not flip yet. This is the anti-jitter case.
  assert.equal(pickFrame(0, 13), 0);
});

test('pickFrame switches once the yaw is within the band of the new centre', () => {
  assert.equal(pickFrame(0, 16), 1, '|16 - 22.5| = 6.5 < 8, committed to frame 1');
  assert.equal(pickFrame(0, 22.5), 1);
  assert.equal(pickFrame(0, 90), 4, 'multi-frame jumps bypass hysteresis');
});

test('pickFrame is stable: sweeping back and forth does not oscillate mid-band', () => {
  // Hold at 13deg: repeated calls from either side must not flip-flop.
  assert.equal(pickFrame(pickFrame(0, 13), 13), 0);
  assert.equal(pickFrame(pickFrame(1, 13), 13), 1, 'coming from frame 1 it stays on 1');
});

test('subFrameResidual is the signed gap to the shown frame', () => {
  // Frame 1 sits at 22.5deg. A yaw of 20 is 2.5deg short of it.
  assert.ok(Math.abs(subFrameResidual(20, 1) - -2.5) < 1e-9);
  assert.ok(Math.abs(subFrameResidual(25, 1) - 2.5) < 1e-9);
  assert.equal(subFrameResidual(0, 0), 0);
});

test('subFrameResidual never exceeds half a frame', () => {
  for (let yaw = -180; yaw <= 180; yaw += 0.5) {
    const k = yawToFrame(yaw);
    const r = subFrameResidual(yaw, k);
    assert.ok(Math.abs(r) <= 11.25 + 1e-9, `yaw ${yaw} gave residual ${r}`);
  }
});

test('subFrameResidual wraps correctly around 0/360', () => {
  // Frame 0 is 0deg; a yaw of 358 is 2deg *before* it, not 358 past it.
  assert.ok(Math.abs(subFrameResidual(358, 0) - -2) < 1e-9);
  assert.ok(Math.abs(subFrameResidual(2, 0) - 2) < 1e-9);
});

test('hysteresis is configurable and zero means always follow', () => {
  // With no hysteresis the frame tracks yaw immediately.
  assert.equal(pickFrame(0, 13, 0), 1);
  // With a wide band it holds.
  assert.equal(pickFrame(0, 13, 8), 0);
});

test('angleGap returns the short way round', () => {
  assert.equal(angleGap(10, 350), 20);
  assert.equal(angleGap(350, 10), 20);
  assert.equal(angleGap(0, 180), 180);
});

test('cursor above the head never extends past the plain +/-90 turn', () => {
  // There is no upward-tilt art in the atlas at all, so "above" must behave
  // exactly like the old model: bounded turn, nothing more.
  const opts = { fullTurnPx: 560, lookDownPx: 260, maxTotalDeg: 140 };
  assert.equal(extendedYawForCursor(400, -300, opts), yawToCursor(400, -300, 560));
  assert.ok(Math.abs(extendedYawForCursor(400, -300, opts)) <= 90);
});

test('cursor below the head extends yaw magnitude beyond 90', () => {
  const opts = { fullTurnPx: 560, lookDownPx: 260, maxTotalDeg: 140 };
  const straightBelow = extendedYawForCursor(560, 260, opts); // dx saturated at fullTurnPx, dy at lookDownPx
  assert.ok(straightBelow > 90, `expected >90, got ${straightBelow}`);
  assert.ok(straightBelow <= 140);
});

test('look-down extension grows with how far below the cursor is', () => {
  const opts = { fullTurnPx: 560, lookDownPx: 260, maxTotalDeg: 140 };
  const shallow = extendedYawForCursor(200, 60, opts);
  const deep = extendedYawForCursor(200, 260, opts);
  assert.ok(deep > shallow, `deeper below should turn further: ${shallow} vs ${deep}`);
});

test('look-down extension is capped at maxTotalDeg', () => {
  const opts = { fullTurnPx: 560, lookDownPx: 260, maxTotalDeg: 140 };
  assert.ok(extendedYawForCursor(560, 5000, opts) <= 140);
});

test('look-down keeps the sign of the horizontal side, defaulting positive when dx is exactly 0', () => {
  const opts = { fullTurnPx: 560, lookDownPx: 260, maxTotalDeg: 140 };
  assert.ok(extendedYawForCursor(-200, 200, opts) < 0, 'left side stays negative while looking down');
  assert.ok(extendedYawForCursor(200, 200, opts) > 0, 'right side stays positive while looking down');
  assert.ok(extendedYawForCursor(0, 200, opts) > 0, 'dx=0 defaults to a stable positive side');
});

test('a pet with lookDownPx=0 never extends, matching the plain turn model', () => {
  assert.equal(extendedYawForCursor(400, 300, { fullTurnPx: 420, lookDownPx: 0 }), yawToCursor(400, 300, 420));
});

test('below-and-to-the-side reaches frames 5-7/9-11 that were previously unreachable', () => {
  const opts = { fullTurnPx: 560, lookDownPx: 260, maxTotalDeg: 140 };
  const yaw = extendedYawForCursor(500, 260, opts);
  const frame = yawToFrame(yaw);
  assert.ok(frame >= 5 && frame <= 11, `expected a look-down frame (5-11), got frame ${frame} from yaw ${yaw}`);
});

test('a modest horizontal offset does not block a deep bow -- regression for the reported "always looks up" bug', () => {
  // Reproduces the exact live values captured from a stationary cursor
  // during the bug report: gx=101, gy=200 with the shipped config
  // (fullTurnPx=560, lookDownPx=260, maxTotalDeg=140). The earlier
  // add-based formula produced yaw=54.7 (frame 2, an ordinary turn) because
  // dx=101 alone could not push the total past 90 even with dy maxed out.
  const opts = { fullTurnPx: 560, lookDownPx: 260, maxTotalDeg: 140 };
  const yaw = extendedYawForCursor(101, 200, opts);
  const frame = yawToFrame(yaw);
  assert.ok(yaw > 90, `dy alone should be able to push past 90 degrees, got ${yaw}`);
  assert.ok(frame >= 5 && frame <= 11, `expected a look-down frame, got frame ${frame} from yaw ${yaw}`);
});

test('vertical alone (dx=0) can reach maxTotalDeg -- "directly below" is no longer a weak case', () => {
  const opts = { fullTurnPx: 560, lookDownPx: 260, maxTotalDeg: 140 };
  const yaw = extendedYawForCursor(0, 260, opts);
  assert.ok(Math.abs(yaw - 140) < 1e-9, `expected the vertical component alone to reach maxTotalDeg, got ${yaw}`);
});

test('horizontal and vertical combine by max, not by addition', () => {
  // At dy = lookDownPx (fully saturated, vertMag = maxTotalDeg) the result
  // must equal maxTotalDeg regardless of dx, since max(horizMag, maxTotalDeg)
  // is always maxTotalDeg -- an add-based formula would overshoot past the cap.
  const opts = { fullTurnPx: 560, lookDownPx: 260, maxTotalDeg: 140 };
  assert.ok(Math.abs(extendedYawForCursor(560, 260, opts) - 140) < 1e-9);
  assert.ok(Math.abs(extendedYawForCursor(50, 260, opts) - 140) < 1e-9);
});

test('tilt is clamped to +/-5 degrees', () => {
  assert.ok(tiltFromCursor(1e9) <= 5);
  assert.ok(tiltFromCursor(-1e9) >= -5);
  assert.equal(tiltFromCursor(0), 0);
});

test('isFollowing respects the radius', () => {
  assert.equal(isFollowing(0, 0, 700), true);
  assert.equal(isFollowing(600, 0, 700), true);
  assert.equal(isFollowing(800, 0, 700), false);
  assert.equal(isFollowing(500, 500, 700), false, 'diagonal distance is ~707');
});

test('linear mapping reaches full turn exactly at fullTurnPx', () => {
  // The depth model saturates by ~260px and then ignores the cursor; linear
  // keeps tracking all the way out and uses the whole frame set.
  assert.equal(yawToCursor(560, 0, 560), 90);
  assert.equal(yawToCursor(-560, 0, 560), -90);
  assert.equal(yawToCursor(280, 0, 560), 45);
  assert.equal(yawToCursor(0, 0, 560), 0);
});

test('linear mapping is proportional, not saturating', () => {
  const at = (dx) => yawToCursor(dx, 0, 560);
  assert.ok(at(400) > at(260), 'must keep turning past 260px');
  assert.ok(at(260) > at(150));
  assert.ok(Math.abs(at(140) - at(280) / 2) < 1e-9, 'strictly proportional');
});

test('linear mapping clamps beyond fullTurnPx', () => {
  assert.equal(yawToCursor(5000, 0, 560), 90);
  assert.equal(yawToCursor(-5000, 0, 560), -90);
});
