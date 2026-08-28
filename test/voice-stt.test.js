import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseVoiceLine, createVoiceSttWatcher } from '../src/voice-stt.js';

test('parseVoiceLine extracts text from a compact JSON line', () => {
  assert.deepEqual(parseVoiceLine('{"text":"你好"}'), { text: '你好' });
});

test('parseVoiceLine returns an error shape for an {"error":...} line', () => {
  assert.deepEqual(parseVoiceLine('{"error":"no recognizer"}'), { error: 'no recognizer' });
});

test('parseVoiceLine returns null for junk/empty lines', () => {
  assert.equal(parseVoiceLine(''), null);
  assert.equal(parseVoiceLine('not json'), null);
  assert.equal(parseVoiceLine('{}'), null);
});

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writes: [], write(s) { this.writes.push(s); } };
  child.kill = () => {};
  return child;
}

test('watcher parses stdout lines and dispatches onTranscript', () => {
  const fakeChild = makeFakeChild();
  const transcripts = [];
  const watcher = createVoiceSttWatcher({
    scriptPath: 'unused-in-test.ps1',
    onTranscript: (t) => transcripts.push(t),
    onError: () => {},
    spawnFn: () => fakeChild,
  });
  fakeChild.stdout.emit('data', '{"text":"第一句"}\n{"text":"第二句"}\n');
  assert.deepEqual(transcripts, ['第一句', '第二句']);
  watcher.dispose();
});

test('watcher.start()/stop() write START/STOP to the child stdin', () => {
  const fakeChild = makeFakeChild();
  const watcher = createVoiceSttWatcher({
    scriptPath: 'unused-in-test.ps1',
    onTranscript: () => {},
    onError: () => {},
    spawnFn: () => fakeChild,
  });
  watcher.start();
  watcher.stop();
  assert.deepEqual(fakeChild.stdin.writes, ['START\n', 'STOP\n']);
  watcher.dispose();
});

test('watcher reports errors for {"error":...} lines without treating them as transcripts', () => {
  const fakeChild = makeFakeChild();
  const transcripts = [];
  const errors = [];
  const watcher = createVoiceSttWatcher({
    scriptPath: 'unused-in-test.ps1',
    onTranscript: (t) => transcripts.push(t),
    onError: (e) => errors.push(e.message),
    spawnFn: () => fakeChild,
  });
  fakeChild.stdout.emit('data', '{"error":"no SAPI recognizer installed on this machine"}\n');
  assert.deepEqual(transcripts, []);
  assert.deepEqual(errors, ['no SAPI recognizer installed on this machine']);
  watcher.dispose();
});

test('dispose() writes EXIT and kills the child', () => {
  const fakeChild = makeFakeChild();
  let killed = false;
  fakeChild.kill = () => { killed = true; };
  const watcher = createVoiceSttWatcher({
    scriptPath: 'unused-in-test.ps1',
    onTranscript: () => {},
    onError: () => {},
    spawnFn: () => fakeChild,
  });
  watcher.dispose();
  assert.deepEqual(fakeChild.stdin.writes, ['EXIT\n']);
  assert.equal(killed, true);
});
