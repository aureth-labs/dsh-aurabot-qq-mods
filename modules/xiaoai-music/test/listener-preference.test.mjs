import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { ListenerPreference } from '../lib/speaker/listener.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'family-listener-'));
  t.after(async () => { const path = relative(tmpdir(), root); assert.ok(path && !isAbsolute(path) && !path.startsWith('..')); await rm(root, { recursive: true, force: true }); });
  return root;
}
test('resident preference persists across reload and serializes changes in request order', async t => {
  const file = join(await fixture(t), 'Speaker', '常驻入口.json');
  const first = new ListenerPreference(file); await first.open(); assert.equal(first.enabled, false);
  await first.setEnabled(true);
  const second = new ListenerPreference(file); await second.open(); assert.equal(second.enabled, true);
  await Promise.all([second.setEnabled(false), second.setEnabled(true), second.setEnabled(false)]);
  const third = new ListenerPreference(file); await third.open(); assert.equal(third.enabled, false);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { schema: 1, enabled: false });
});
test('corrupt resident preference fails closed without replacing saved data', async t => {
  const file = join(await fixture(t), '常驻入口.json');
  await writeFile(file, '{broken');
  const settings = new ListenerPreference(file);
  await assert.rejects(settings.open(), /未自动开启/);
  assert.equal(settings.enabled, false);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
test('closing the resident entry disables it in memory even when preference storage fails', async t => {
  const root = await fixture(t), blocked = join(root, 'blocked'); await writeFile(blocked, 'fixture');
  const settings = new ListenerPreference(join(blocked, '常驻入口.json')); settings.enabled = true;
  await assert.rejects(settings.setEnabled(false), /未能保存/);
  assert.equal(settings.enabled, false);
});
