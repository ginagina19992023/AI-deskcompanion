import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalStatus, normalizeAiActivity, normalizeProvider, pickAllContextActivities, pickPrimaryActivity } from '../src/ai-activity.js';

test('provider aliases normalize DeepSeek, Kimi, Claude and Codex', () => {
  assert.equal(normalizeProvider('deepseek-chat'), 'deepseek');
  assert.equal(normalizeProvider('Moonshot Kimi'), 'kimi');
  assert.equal(normalizeProvider('Anthropic Claude'), 'claude');
  assert.equal(normalizeProvider('OpenAI Codex'), 'codex');
});

test('tool categories select review, working, and waiting states', () => {
  assert.equal(canonicalStatus('tool_start', 'web_search'), 'working');
  assert.equal(canonicalStatus('', 'read_file'), 'review');
  assert.equal(canonicalStatus('', 'request_permission'), 'waiting');
  assert.equal(canonicalStatus('', 'shell_command'), 'working');
});

test('normalized activity includes provider and a safe display detail', () => {
  const item = normalizeAiActivity({ provider: 'moonshot', status: 'review', toolName: 'web_search', sessionId: 'k1' }, 1000);
  assert.equal(item.provider, 'kimi');
  assert.equal(item.providerLabel, 'Kimi');
  assert.equal(item.detail, 'Kimi · 搜索网页');
  assert.equal(item.ts, 1000);
});

test('context percentages accept either fractions or human percentages', () => {
  assert.equal(normalizeAiActivity({ provider: 'claude', contextPercent: 0.46 }).contextPercent, 0.46);
  assert.equal(normalizeAiActivity({ provider: 'kimi', contextPercent: 46 }).contextPercent, 0.46);
});

test('waiting outranks recent work and stale activity is ignored', () => {
  const primary = pickPrimaryActivity(
    [
      { status: 'working', ts: 990, provider: 'codex' },
      { status: 'waiting', ts: 900, provider: 'claude' },
      { status: 'error', ts: 1, provider: 'kimi' },
    ],
    { nowMs: 1000, staleMs: 200 },
  );
  assert.equal(primary.provider, 'claude');
});

// Real reported bug, twice over: first "fullest wins" silently showed a
// different session than the one you were looking at; switching to "most
// recent wins" still flickered between two sessions used seconds apart.
// The actual fix is to stop picking one -- return every fresh session with
// context data so the pet can draw one ring per window instead.
test('returns one entry per fresh session with context data, newest first', () => {
  const list = pickAllContextActivities(
    [
      { provider: 'codex', status: 'working', contextPercent: 0.32, ts: 999, sessionId: 'a' },
      { provider: 'claude', status: 'review', contextPercent: 0.81, ts: 950, sessionId: 'b' },
      { provider: 'kimi', status: 'waiting', contextPercent: 0.95, ts: 1, sessionId: 'c' }, // stale, excluded
      { provider: 'claude', status: 'working', ts: 990, sessionId: 'd' }, // no contextPercent, excluded
    ],
    { nowMs: 1000, staleMs: 200 },
  );
  assert.deepEqual(
    list.map((x) => x.sessionId),
    ['a', 'b'],
  );
});

test('two same-provider sessions each get their own entry, not just the fuller one', () => {
  const list = pickAllContextActivities(
    [
      { provider: 'claude', status: 'working', contextPercent: 0.21, ts: 995, sessionId: 'this-window' },
      { provider: 'claude', status: 'working', contextPercent: 0.62, ts: 500, sessionId: 'other-window' },
    ],
    { nowMs: 1000, staleMs: 120000 },
  );
  assert.deepEqual(
    list.map((x) => x.sessionId),
    ['this-window', 'other-window'],
  );
});

test('duplicate entries for the same session keep only the most recent one', () => {
  const list = pickAllContextActivities(
    [
      { provider: 'claude', status: 'working', contextPercent: 0.2, ts: 800, sessionId: 'a' },
      { provider: 'claude', status: 'working', contextPercent: 0.25, ts: 900, sessionId: 'a' },
    ],
    { nowMs: 1000, staleMs: 120000 },
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].contextPercent, 0.25);
});
