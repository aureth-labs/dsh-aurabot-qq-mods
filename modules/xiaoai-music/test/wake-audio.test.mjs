import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakeAudio } from '../lib/companion/wake-audio.mjs';

test('preview and multiple acknowledgements share one generation, then follow text and voice changes', async () => {
  let voice = 'synthetic-voice';
  let savedText = '收到啦';
  const calls = [], cleaned = [];
  const cache = createWakeAudio({
    getText: () => savedText,
    signature: () => voice,
    prepare: async text => {
      calls.push(text);
      const file = text + '-' + voice + '.wav';
      return { file, duration: 2, cleanup: async () => { cleaned.push(file); } };
    },
    failure: () => '生成失败',
  });
  const first = cache.generate('收到啦');
  assert.equal(cache.state('收到啦').phase, 'generating');
  const held = await cache.acquire('收到啦');
  await first;
  const id = cache.state('收到啦').id;
  assert.equal(cache.preview('收到啦', id).absoluteFile, held.file);
  const again = await cache.acquire('收到啦');
  await again.cleanup();
  await cache.generate('收到啦');
  assert.deepEqual(calls, ['收到啦']);
  savedText = '我在这里';
  await cache.generate(savedText);
  assert.equal(held.isCurrent(), false);
  assert.throws(() => cache.preview('收到啦', id));
  assert.deepEqual(cleaned, []);
  await held.cleanup();
  assert.deepEqual(cleaned, [held.file]);
  voice = 'second-voice';
  assert.equal(cache.state('我在这里').phase, 'idle');
  await cache.generate('我在这里');
  assert.deepEqual(calls, ['收到啦', '我在这里', '我在这里']);
  assert.equal(cache.state('我在这里').phase, 'ready');
  await cache.close();
  assert.equal(cleaned.length, 3);
});

test('audio from an earlier asynchronous generation cannot replace the current saved reply', async () => {
  let finishOld;
  let savedText = 'first';
  const cleaned = [];
  const audio = file => ({ file, cleanup: async () => { cleaned.push(file); } });
  const cache = createWakeAudio({
    getText: () => savedText,
    signature: () => 'synthetic',
    prepare: text => text === 'first' ? new Promise(resolve => { finishOld = resolve; }) : audio(text),
    failure: () => '生成失败',
  });
  const old = cache.generate('first').catch(error => error);
  savedText = 'second';
  await cache.generate(savedText);
  finishOld(audio('first'));
  assert.ok(await old instanceof Error);
  assert.equal(cache.state('second').phase, 'ready');
  assert.deepEqual(cleaned, ['first']);
  await cache.close();
});

test('an old playback request cannot replace the saved reply while its audio is being generated', async () => {
  let savedText = '旧应答';
  let finishNew;
  const calls = [];
  const audio = text => ({ file: text, cleanup: async () => {} });
  const cache = createWakeAudio({
    getText: () => savedText,
    signature: () => 'synthetic',
    prepare: async text => {
      calls.push(text);
      if (text === '新应答') await new Promise(resolve => { finishNew = resolve; });
      return audio(text);
    },
    failure: () => '生成失败',
  });
  await cache.generate(savedText);
  savedText = '新应答';
  const next = cache.generate(savedText);
  const stale = cache.acquire('旧应答');
  const staleRejected = assert.rejects(stale, /称呼应答已变更/);
  finishNew();
  const result = await Promise.allSettled([next, staleRejected]);
  assert.deepEqual(result.map(item => item.status), ['fulfilled', 'fulfilled']);
  assert.equal(cache.state(savedText).phase, 'ready');
  assert.deepEqual(calls, ['旧应答', '新应答']);
  await cache.close();
});
