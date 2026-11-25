import test from 'node:test';
import assert from 'node:assert/strict';
import { askVoiceReply } from '../lib/companion/voice-reply.mjs';

test('sister persona is injected per request without accessing global host configuration', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'aurabot');
  let globalAccesses = 0;
  Object.defineProperty(globalThis, 'aurabot', {
    configurable: true,
    get() { globalAccesses++; throw new Error('global host access is forbidden in this test'); },
    set() { globalAccesses++; throw new Error('global host replacement is forbidden in this test'); },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'aurabot', previous);
    else delete globalThis.aurabot;
  });
  const calls = [];
  const ask = async options => { calls.push(options); return '  咋啦，今天累着了？  '; };
  const first = await askVoiceReply(ask, 'isolated-sister-card-a', '今天有点累。');
  assert.equal(first, '咋啦，今天累着了？');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].system.startsWith('isolated-sister-card-a\n'));
  assert.equal(calls[0].text, '今天有点累。');
  assert.equal(calls[0].maxTokens, 220);
  await askVoiceReply(ask, 'isolated-sister-card-b', '你好。');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].system.startsWith('isolated-sister-card-b\n'));
  assert.equal(calls[1].system.includes('isolated-sister-card-a'), false);
  assert.equal(globalAccesses, 0);
});

test('sister dialogue inherits empty-response rejection from the model wrapper', async () => {
  for (const reply of ['', '  ', null]) {
    await assert.rejects(askVoiceReply(async () => reply, 'isolated-sister-card', '你好。'), {
      code: 'MODEL_EMPTY_RESPONSE',
    });
  }
});

test('sister dialogue inherits fixed model errors without exposing upstream details', async () => {
  await assert.rejects(askVoiceReply(async () => {
    throw new Error('401 isolated-upstream-detail');
  }, 'isolated-sister-card', '你好。'), error => {
    assert.equal(error.code, 'MODEL_AUTH');
    assert.equal(error.message.includes('isolated-upstream-detail'), false);
    assert.equal(error.stack.includes('isolated-upstream-detail'), false);
    return true;
  });
});
