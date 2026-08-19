import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const defaults = JSON.parse(readFileSync(join(root, 'config.default.json'), 'utf8'));

test('published defaults are portable and include both pet atlases', () => {
  assert.equal(defaults.activePet, 'sebastian-raven', 'Sebastian must remain the default visible pet');
  for (const pet of defaults.pets) {
    assert.equal(isAbsolute(pet.spritesheetPath), false, `${pet.id} path must be portable`);
    assert.equal(existsSync(join(root, pet.spritesheetPath)), true, `${pet.id} atlas must ship`);
  }
});

test('privacy-sensitive model features are opt-in in published defaults', () => {
  assert.equal(defaults.screenTips.enabled, false);
  assert.equal(defaults.workSupervision.enabled, false);
  assert.equal(defaults.chat.enabled, false);
});

test('local preferences, private data and logs are excluded from Git', () => {
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^config\.json$/m);
  assert.match(ignore, /^data\/\*$/m);
  assert.match(ignore, /^\*\.log$/m);
  assert.match(ignore, /^\*-runtime-check\.png$/m);
});
