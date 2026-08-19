import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('renderer pages define a restrictive Content Security Policy', () => {
  for (const path of ['src/index.html', 'src/dashboard.html']) {
    const html = read(path);
    assert.match(html, /http-equiv="Content-Security-Policy"/);
    assert.match(html, /script-src 'self'/);
    assert.match(html, /object-src 'none'/);
    assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/);
    assert.doesNotMatch(html, /script-src[^;]*'unsafe-eval'/);
  }
});

test('Electron renderer windows keep isolation and sandboxing enabled', () => {
  const main = read('src/main.js');
  const browserWindowBlocks = [...main.matchAll(/new BrowserWindow\(\{[\s\S]*?webPreferences:\s*\{([\s\S]*?)\}\s*,?\s*\}\)/g)];
  assert.equal(browserWindowBlocks.length, 2);
  for (const [, preferences] of browserWindowBlocks) {
    assert.match(preferences, /contextIsolation:\s*true/);
    assert.match(preferences, /nodeIntegration:\s*false/);
    assert.match(preferences, /sandbox:\s*true/);
  }
});

test('dashboard blocks renderer-created windows and opens only web URLs externally', () => {
  const main = read('src/main.js');
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /protocol === 'https:' \|\| protocol === 'http:'/);
  assert.match(main, /return \{ action: 'deny' \}/);
});

test('user-authored overview and memory category text is rendered as text', () => {
  const renderer = read('src/dashboard-renderer.js');
  assert.match(renderer, /detail\.textContent = c\.detail/);
  assert.match(renderer, /document\.createTextNode\(`\$\{cat\} `/);
  assert.doesNotMatch(renderer, /card\.innerHTML = `<div class="label">/);
  assert.doesNotMatch(renderer, /title\.innerHTML = `\$\{cat\}/);
});
