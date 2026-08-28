import test from 'node:test';
import assert from 'node:assert/strict';
import { captureAndDescribe, createCameraSenseWatcher } from '../src/camera-sense.js';

test('captureAndDescribe returns null when getFrame yields nothing', async () => {
  const result = await captureAndDescribe({}, async () => null);
  assert.equal(result, null);
});

test('captureAndDescribe tags the result source as camera', async () => {
  const result = await captureAndDescribe(
    { provider: 'ollama' },
    async () => 'FRAMEDATA',
    async () => 'a person smiling',
  );
  assert.equal(result.source, 'camera');
  assert.equal(result.text, 'a person smiling');
  assert.equal(result.imageBase64, 'FRAMEDATA');
  assert.equal(typeof result.ts, 'number');
});

test('watcher calls onTip once per tick and stop() halts further ticks', async () => {
  let frameCalls = 0;
  const getFrame = async () => {
    frameCalls++;
    return 'FRAME';
  };
  const tips = [];
  const watcher = createCameraSenseWatcher({
    cfg: { intervalMs: 5, provider: 'ollama' },
    getFrame,
    onTip: (tip) => tips.push(tip),
    onError: () => {},
    isPaused: () => false,
    visionCall: async () => 'a description',
  });
  const tip = await watcher.trigger();
  assert.equal(tip.text, 'a description');
  assert.equal(tips.length, 1);
  watcher.stop();
  assert.equal(frameCalls, 1);
});

test('watcher.trigger() rejects and calls onError when getFrame throws', async () => {
  const errors = [];
  const watcher = createCameraSenseWatcher({
    cfg: { intervalMs: 5 },
    getFrame: async () => {
      throw new Error('camera busy');
    },
    onTip: () => {},
    onError: (err) => errors.push(err),
    isPaused: () => false,
  });
  await assert.rejects(() => watcher.trigger(), /camera busy/);
  assert.equal(errors.length, 1);
  watcher.stop();
});
