import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WakePreference, matchWakePrefix } from '../lib/speaker/wake.mjs';

test('only main names and variants trigger; greeting-only legacy names are ignored without rewriting data', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xiaoai-wake-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'wake.json');
  const original = JSON.stringify({ schema: 1, names: ['小伴', '小半'], greetingNames: ['旧称'] });
  await writeFile(file, original);
  const preference = new WakePreference(file); await preference.open();
  assert.equal(preference.get().acknowledgement, '我在');
  for (const text of ['小伴天气', '小半天气', '你好小伴天气', '小爱同学小伴天气']) {
    assert.ok(matchWakePrefix(text, preference.get()));
  }
  for (const text of ['你好旧称天气', '旧称天气', '你好天气', '今天天气']) {
    assert.equal(matchWakePrefix(text, preference.get()), null);
  }
  assert.equal(await readFile(file, 'utf8'), original);
  await preference.save({ names: ['小伴', '小半'], greetingNames: [], acknowledgement: '  小伴收到  ' });
  await preference.save({ names: ['小伴', '小半'], greetingNames: [] });
  const reloaded = new WakePreference(file);
  assert.equal((await reloaded.open()).acknowledgement, '小伴收到');
  assert.equal((await reloaded.save({ names: ['小伴', '小半'], greetingNames: [], acknowledgement: '' })).acknowledgement, '我在');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).greetingNames, []);
});

test('concurrent editors cannot overwrite a newer wake preference', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xiaoai-wake-conflict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'wake.json');
  const preference = new WakePreference(file);
  const stale = { names: ['旧称呼'], greetingNames: [], acknowledgement: '原应答' };
  await preference.save(stale);
  const latest = { ...stale, names: ['新称呼'] };
  const saveName = preference.save(latest, stale);
  const saveReply = preference.save({ ...stale, acknowledgement: '新应答' }, stale);
  const [, reply] = await Promise.allSettled([saveName, saveReply]);
  assert.equal(reply.status, 'rejected');
  assert.equal(reply.reason.code, 'WAKE_SETTINGS_CHANGED');
  assert.deepEqual(preference.get(), latest);
  assert.deepEqual(await new WakePreference(file).open(), latest);
});
