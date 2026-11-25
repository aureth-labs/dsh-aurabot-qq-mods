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

test('pronunciation override persists and can be cleared without losing existing aliases', async t => {
 const dir=await mkdtemp(join(tmpdir(),'xiaoai-pronunciation-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'wake.json'), preference=new WakePreference(file);
 const value={names:['重重','小伴'],greetingNames:[],primaryPinyin:'chong chong'};
 await preference.save(value);
 const reloaded=new WakePreference(file);await reloaded.open();
 assert.equal(reloaded.get().primaryPinyin,'chong chong');
 assert.ok(matchWakePrefix('虫虫你好',reloaded.get()));
 await reloaded.save({...value,primaryPinyin:''},reloaded.get());
 assert.equal(reloaded.get().primaryPinyin,undefined);
 assert.deepEqual(reloaded.get().names,value.names);
});

test('pronunciation overrides apply to each saved name and require a corresponding entry', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xiaoai-multiple-readings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'wake.json');
  const preference = new WakePreference(file);
  const config = { names: ['小伴', '重重'], greetingNames: [], pronunciations: ['xiao ban', 'zhong zhong'] };
  await preference.save(config);
  const reloaded = new WakePreference(file);
  assert.deepEqual((await reloaded.open()).pronunciations, ['', 'zhong zhong']);
  assert.ok(matchWakePrefix('晓半你好', reloaded.get()));
  assert.ok(matchWakePrefix('众众你好', reloaded.get()));
  await assert.rejects(reloaded.save({ ...config, pronunciations: ['chong chong'] }), /逐项对应/);
});
