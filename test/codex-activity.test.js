import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexActivityReader, parseCodexRollout } from '../src/codex-activity.js';

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

test('Codex rollout reports the currently executing nested tool', () => {
  const text = [
    line('2026-01-01T00:00:00Z', 'event_msg', { type: 'task_started' }),
    line('2026-01-01T00:00:01Z', 'event_msg', { type: 'user_message', message: '修复登录测试' }),
    line('2026-01-01T00:00:02Z', 'response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'await tools.shell_command({command:"npm test"})' }),
  ].join('\n');
  const item = parseCodexRollout(text, { threadId: 'abc', nowMs: 10000 });
  assert.equal(item.provider, 'codex');
  assert.equal(item.status, 'working');
  assert.equal(item.toolName, 'shell_command');
  assert.equal(item.detail, 'Codex · 运行终端命令');
  assert.equal(item.taskTitle, '修复登录测试');
});

test('Codex rollout maps read tools to review and task completion to celebrate', () => {
  const reading = parseCodexRollout(
    line('2026-01-01T00:00:02Z', 'response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'await tools.view_image({path:"a.png"})' }),
    { threadId: 'abc', nowMs: 10000 },
  );
  assert.equal(reading.status, 'review');
  const done = parseCodexRollout(line('2026-01-01T00:00:03Z', 'event_msg', { type: 'task_complete' }), { threadId: 'abc', nowMs: 10000 });
  assert.equal(done.status, 'celebrate');
});

test('Codex rollout exposes current context pressure from token_count events', () => {
  const text = [
    line('2026-01-01T00:00:01Z', 'response_item', { type: 'reasoning' }),
    line('2026-01-01T00:00:02Z', 'event_msg', {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 129200 }, model_context_window: 258400 },
    }),
  ].join('\n');
  const item = parseCodexRollout(text, { threadId: 'abc', nowMs: 10000 });
  assert.equal(item.contextTokens, 129200);
  assert.equal(item.contextWindowMax, 258400);
  assert.equal(item.contextPercent, 0.5);
});

test('Codex reader preserves the task title after a long rollout leaves the tail window', () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-codex-reader-'));
  const now = new Date(2026, 0, 2, 12).getTime();
  const day = join(root, '2026', '01', '02');
  mkdirSync(day, { recursive: true });
  const path = join(day, 'rollout-2026-01-02T12-00-00-019fe61b-6e5c-7723-a1c5-646569099fb4.jsonl');
  try {
    writeFileSync(
      path,
      [
        line('2026-01-02T10:00:00Z', 'event_msg', { type: 'user_message', message: '保留这个任务标题' }),
        line('2026-01-02T10:00:01Z', 'response_item', { type: 'reasoning' }),
      ].join('\n') + '\n',
    );
    const read = createCodexActivityReader(root);
    assert.equal(read(now)[0].taskTitle, '保留这个任务标题');

    const padding = `${JSON.stringify({ timestamp: '2026-01-02T10:00:02Z', type: 'response_item', payload: { type: 'other', text: 'x'.repeat(900) } })}\n`;
    appendFileSync(path, padding.repeat(650));
    appendFileSync(path, `${line('2026-01-02T10:00:03Z', 'response_item', { type: 'custom_tool_call', call_id: 'c2', name: 'exec', input: 'await tools.shell_command({command:"npm test"})' })}\n`);

    const updated = read(now)[0];
    assert.equal(updated.taskTitle, '保留这个任务标题');
    assert.equal(updated.toolName, 'shell_command');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
