import test from 'node:test';
import assert from 'node:assert/strict';
import { callVisionModel } from '../src/vision-provider.js';

test('ollama provider posts to /api/generate and returns the trimmed response text', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({ response: '  a person at a desk  ' }),
    };
  });
  const text = await callVisionModel({ provider: 'ollama', model: 'minicpm-v' }, 'BASE64DATA');
  assert.equal(text, 'a person at a desk');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/generate$/);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, 'minicpm-v');
  assert.equal(body.images[0], 'BASE64DATA');
});

test('openai-compatible provider requires baseUrl and apiKeyEnv, sends bearer auth', async (t) => {
  process.env.TEST_VISION_KEY = 'secret123';
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(opts.headers.Authorization, 'Bearer secret123');
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'a cat' } }] }),
    };
  });
  const text = await callVisionModel(
    { provider: 'openai-compatible', baseUrl: 'https://api.example.com', model: 'vision-1', apiKeyEnv: 'TEST_VISION_KEY' },
    'BASE64DATA',
  );
  assert.equal(text, 'a cat');
  delete process.env.TEST_VISION_KEY;
});

test('openai-compatible provider throws a clear error when apiKeyEnv is unset', async () => {
  await assert.rejects(
    () => callVisionModel({ provider: 'openai-compatible', model: 'vision-1', apiKeyEnv: 'NOPE_NOT_SET' }, 'x'),
    /isn't set in the environment/,
  );
});

test('openai-compatible provider throws a clear error when baseUrl is missing', async () => {
  process.env.TEST_VISION_KEY_2 = 'present';
  await assert.rejects(
    () => callVisionModel({ provider: 'openai-compatible', model: 'vision-1', apiKeyEnv: 'TEST_VISION_KEY_2' }, 'x'),
    /baseUrl/,
  );
  delete process.env.TEST_VISION_KEY_2;
});
