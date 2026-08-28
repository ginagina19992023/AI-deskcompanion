import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVoice } from '../src/voice-tts.js';

const voices = [
  { name: 'Microsoft Huihui Desktop', lang: 'zh-CN' },
  { name: 'Microsoft Zira Desktop', lang: 'en-US' },
];

test('resolveVoice matches by exact name', () => {
  assert.equal(resolveVoice(voices, 'Microsoft Zira Desktop').lang, 'en-US');
});

test('resolveVoice falls back to null for an empty/unset name', () => {
  assert.equal(resolveVoice(voices, ''), null);
  assert.equal(resolveVoice(voices, undefined), null);
});

test('resolveVoice returns null (not a throw) for a name that matches nothing', () => {
  assert.equal(resolveVoice(voices, 'Nonexistent Voice'), null);
});
