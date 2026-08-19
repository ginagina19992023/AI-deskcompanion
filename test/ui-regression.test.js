import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('toolbar restores the exact pet rect after screen-edge clamping', () => {
  const main = read('src/main.js');
  assert.match(main, /toolbarPetRect = \{ \.\.\.petRect \}/);
  assert.match(main, /const target = toolbarPetRect \?\?/);
  assert.match(main, /petX: petRect\.x - clampedX/);
  assert.match(main, /petY: petRect\.y - clampedY/);
});

test('permission cards and the context-usage badge suppress the hover toolbar trigger', () => {
  const renderer = read('src/renderer.js');
  assert.match(renderer, /hit && !contextBadgeHovered && permissionQueue\.length === 0 && !chatPanelOpen/);
});

test('dashboard opacity changes the native window, not only card CSS', () => {
  const main = read('src/main.js');
  const preload = read('src/dashboard-preload.cjs');
  assert.match(main, /dashboardWin\.setOpacity/);
  assert.match(main, /dashboard:preview-opacity/);
  assert.match(preload, /previewOpacity/);
});
