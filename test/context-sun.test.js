import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_SUN_RAY_COUNT, contextSunMotion } from '../src/context-sun.js';

test('context sun keeps the ten-lobe Claude-like silhouette', () => {
  assert.equal(CLAUDE_SUN_RAY_COUNT, 10);
});

test('context sun motion stays subtle and loops deterministically', () => {
  const start = contextSunMotion(0);
  const looped = contextSunMotion(1_788_800);
  assert.deepEqual(start, looped);

  for (let now = 0; now <= 10000; now += 37) {
    const motion = contextSunMotion(now);
    assert.ok(motion.scale >= 0.955 && motion.scale <= 1.045);
    assert.ok(motion.rotation >= -0.075 && motion.rotation <= 0.075);
    assert.ok(motion.rayPulse >= 0 && motion.rayPulse <= 1);
  }
});

test('context sun performs a soft double blink', () => {
  assert.equal(contextSunMotion(3319).blink, false);
  assert.equal(contextSunMotion(3320).blink, true);
  assert.equal(contextSunMotion(3460).blink, false);
  assert.equal(contextSunMotion(3580).blink, true);
  assert.equal(contextSunMotion(3660).blink, false);
});
