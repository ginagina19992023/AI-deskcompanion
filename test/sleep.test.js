import test from 'node:test';
import assert from 'node:assert/strict';
import { isWithinSleepWindow, sleepRowFor } from '../src/sleep.js';

const at = (hour) => new Date(2026, 0, 1, hour, 0, 0);

test('isWithinSleepWindow: disabled config is never active', () => {
  assert.equal(isWithinSleepWindow({ enabled: false, startHour: 0, endHour: 6 }, at(2)), false);
  assert.equal(isWithinSleepWindow(null, at(2)), false);
});

test('isWithinSleepWindow: non-wrapping window (e.g. 1am-6am)', () => {
  const cfg = { enabled: true, startHour: 1, endHour: 6 };
  assert.equal(isWithinSleepWindow(cfg, at(0)), false);
  assert.equal(isWithinSleepWindow(cfg, at(1)), true);
  assert.equal(isWithinSleepWindow(cfg, at(3)), true);
  assert.equal(isWithinSleepWindow(cfg, at(5)), true);
  assert.equal(isWithinSleepWindow(cfg, at(6)), false);
  assert.equal(isWithinSleepWindow(cfg, at(12)), false);
});

test('isWithinSleepWindow: wrapping window past midnight (e.g. 23-6)', () => {
  const cfg = { enabled: true, startHour: 23, endHour: 6 };
  assert.equal(isWithinSleepWindow(cfg, at(22)), false);
  assert.equal(isWithinSleepWindow(cfg, at(23)), true);
  assert.equal(isWithinSleepWindow(cfg, at(0)), true);
  assert.equal(isWithinSleepWindow(cfg, at(5)), true);
  assert.equal(isWithinSleepWindow(cfg, at(6)), false);
  assert.equal(isWithinSleepWindow(cfg, at(12)), false);
});

test('isWithinSleepWindow: a zero-width window (start === end) is never active', () => {
  const cfg = { enabled: true, startHour: 3, endHour: 3 };
  assert.equal(isWithinSleepWindow(cfg, at(3)), false);
  assert.equal(isWithinSleepWindow(cfg, at(0)), false);
});

test('sleepRowFor: a pet with the 13-row extension gets the real lie-down pose', () => {
  const pet = { hasExtendedRows: true, profile: { restRow: 7 } };
  assert.equal(sleepRowFor(pet, { LIE_DOWN: 12 }), 12);
});

test('sleepRowFor: a pet without the extension falls back to its ordinary rest row', () => {
  const pet = { hasExtendedRows: false, profile: { restRow: 8 } };
  assert.equal(sleepRowFor(pet, { LIE_DOWN: 12 }), 8);
});

test('sleepRowFor: no profile at all returns null rather than throwing', () => {
  assert.equal(sleepRowFor(null, { LIE_DOWN: 12 }), null);
  assert.equal(sleepRowFor({}, { LIE_DOWN: 12 }), null);
});
