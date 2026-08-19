import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMusicPulse, pickMusicComment } from '../src/music-comment.js';

const samples = (energy, interval) => Array.from({ length: 8 }, (_, i) => ({ energy, ts: i * interval }));

test('quiet sparse pulses read as delicate', () => {
  assert.equal(classifyMusicPulse(samples(0.06, 600)), 'delicate');
});

test('loud or very rapid pulses read as intense', () => {
  assert.equal(classifyMusicPulse(samples(0.15, 500)), 'intense');
  assert.equal(classifyMusicPulse(samples(0.09, 280)), 'intense');
});

test('music comments use the active pet personality lines', () => {
  const taste = { delicateLines: ['music-box'], neutralLines: ['plain'], intenseLines: ['noisy'] };
  assert.deepEqual(pickMusicComment(samples(0.06, 600), taste, () => 0), { mood: 'delicate', text: 'music-box' });
});
