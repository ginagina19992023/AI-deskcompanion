import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWatcherLine, companionAnchor, createGreeter } from '../src/companion.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('renderer-side modules never import node builtins', () => {
  // The renderer runs with nodeIntegration disabled. A stray `node:` import
  // anywhere in its module graph kills the whole renderer and the pet just
  // silently stops drawing -- which is very hard to diagnose from outside.
  const rendererGraph = ['renderer.js', 'atlas.js', 'head.js', 'brain.js', 'companion.js'];
  for (const file of rendererGraph) {
    const source = readFileSync(join(srcDir, file), 'utf8');
    const offenders = source.match(/from\s+['"]node:[^'"]+['"]/g) ?? [];
    assert.deepEqual(offenders, [], `${file} must not import node builtins`);
  }
});

test('parses a present rect', () => {
  assert.deepEqual(parseWatcherLine('{"present":true,"x":650,"y":1001,"w":613,"h":602}'), {
    present: true,
    x: 650,
    y: 1001,
    w: 613,
    h: 602,
  });
});

test('parses absence', () => {
  assert.deepEqual(parseWatcherLine('{"present":false}'), { present: false });
});

test('rejects junk without throwing', () => {
  // PowerShell can emit banners, warnings or partial lines on the same pipe.
  for (const junk of ['', '   ', 'not json', '{oops', null, undefined, 'WARNING: blah']) {
    assert.equal(parseWatcherLine(junk), null, `should reject ${JSON.stringify(junk)}`);
  }
});

test('rejects a degenerate rect', () => {
  assert.equal(parseWatcherLine('{"present":true,"x":0,"y":0,"w":0,"h":10}'), null);
  assert.equal(parseWatcherLine('{"present":true,"x":0,"y":0,"w":null,"h":10}'), null);
});

test('anchor points at the sprite, not the middle of the empty overlay', () => {
  // Measured: a 613x602 overlay holding a 168x261 sprite whose head centre
  // sits at 57.2% of the window height -- well below the window centre.
  const a = companionAnchor({ x: 650, y: 1001, w: 613, h: 602 });
  assert.ok(Math.abs(a.x - (650 + 613 * 0.498)) < 0.001);
  assert.ok(a.y > 1001 + 602 * 0.5, 'head must be below the window centre');
  assert.ok(a.y < 1001 + 602 * 0.7, 'but well above the feet');
});

test('anchor fractions are overridable', () => {
  const a = companionAnchor({ x: 0, y: 0, w: 100, h: 100 }, { fx: 0.25, fyHead: 0.75 });
  assert.deepEqual(a, { x: 25, y: 75 });
});

test('greets on entering range, not repeatedly while loitering', () => {
  const g = createGreeter({ nearDist: 400, cooldownMs: 10000 });
  assert.equal(g.update(900, 0), false, 'far away: no greeting');
  assert.equal(g.update(300, 100), true, 'entered range: greet');
  assert.equal(g.update(280, 200), false, 'still near: do not greet again');
  assert.equal(g.update(250, 5000), false);
});

test('re-greets only after leaving and the cooldown elapsing', () => {
  const g = createGreeter({ nearDist: 400, cooldownMs: 10000 });
  assert.equal(g.update(300, 0), true);
  assert.equal(g.update(900, 1000), false, 'left range');
  assert.equal(g.update(300, 2000), false, 'returned too soon -- cooldown blocks it');
  assert.equal(g.update(900, 12000), false);
  assert.equal(g.update(300, 13000), true, 'cooldown elapsed, greet again');
});

test('an absent companion (Infinity distance) never greets', () => {
  const g = createGreeter({ nearDist: 400, cooldownMs: 0 });
  for (let t = 0; t < 5000; t += 100) {
    assert.equal(g.update(Infinity, t), false);
  }
  assert.equal(g.near, false);
});

test('reset clears the near latch so the next approach greets', () => {
  const g = createGreeter({ nearDist: 400, cooldownMs: 0 });
  assert.equal(g.update(300, 0), true);
  assert.equal(g.update(300, 100), false);
  g.reset();
  assert.equal(g.update(300, 200), true, 'after reset the approach counts again');
});
