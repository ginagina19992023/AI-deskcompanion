import test from 'node:test';
import assert from 'node:assert/strict';
import { startPomodoro, pomodoroRemainingMs, isPomodoroDone } from '../src/pomodoro.js';

test('startPomodoro: records start/end from the given clock reading', () => {
  const s = startPomodoro(25 * 60 * 1000, 1000);
  assert.equal(s.startedAt, 1000);
  assert.equal(s.durationMs, 25 * 60 * 1000);
  assert.equal(s.endsAt, 1000 + 25 * 60 * 1000);
});

test('pomodoroRemainingMs: counts down and never goes negative', () => {
  const s = startPomodoro(1000, 0);
  assert.equal(pomodoroRemainingMs(s, 0), 1000);
  assert.equal(pomodoroRemainingMs(s, 400), 600);
  assert.equal(pomodoroRemainingMs(s, 1000), 0);
  assert.equal(pomodoroRemainingMs(s, 5000), 0);
});

test('pomodoroRemainingMs: null state has zero remaining', () => {
  assert.equal(pomodoroRemainingMs(null, 0), 0);
});

test('isPomodoroDone: false before endsAt, true at/after it', () => {
  const s = startPomodoro(1000, 0);
  assert.equal(isPomodoroDone(s, 999), false);
  assert.equal(isPomodoroDone(s, 1000), true);
  assert.equal(isPomodoroDone(s, 2000), true);
});

test('isPomodoroDone: null state is never done', () => {
  assert.equal(isPomodoroDone(null, 0), false);
});
