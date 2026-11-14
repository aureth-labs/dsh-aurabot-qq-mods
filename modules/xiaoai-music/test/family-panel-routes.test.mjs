import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import definition from '../index.mjs';
import { resourcePaths } from '../lib/songs/storage.mjs';
import { SongLibrary, FamilySongError } from '../lib/songs/library.mjs';
globalThis.aurabot = { src: new URL('../', import.meta.url), lib: () => ({}) };
const { selectSingingVoice } = await import('../lib/songs/runtime.mjs');

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'family-panel-routes-'));
  const handlers = new Map(), disposers = [], saved = [];
  const settings = { resourceRoot: root, networkInterface: 'Synthetic interface' };
  const config = { persona: { current: 'synthetic' }, voice: { enabled: true, engine: 'edge', voice: 'Synthetic voice' }, song: { voice: 'Synthetic singing voice' } };
  const baseline = JSON.stringify(config);
  const module = await definition.setup({ id: 'xiaoai-music', tool() {}, rule() {}, defineTool: value => value, settings: () => settings, config: () => config,
    saveSettings: async patch => { saved.push(patch); Object.assign(settings, patch); },
    use: id => id === 'song' ? { status: () => ({ voices: [{ id: 'Synthetic singing voice', pth: 'private-fixture-path' }] }) } : null,
    route: (path, handler) => handlers.set(path, handler), every() {}, on() {}, onDispose: fn => disposers.push(fn),
    core: { http: { body: async req => req.body }, personas: { current: () => { throw new Error('Global persona must not be read'); }, list: () => { throw new Error('Global persona list must not be read'); } } },
  });
  t.after(async () => { for (const dispose of disposers) await dispose();
    const path = relative(tmpdir(), root); assert.ok(path && !isAbsolute(path) && !path.startsWith('..'));
    await rm(root, { recursive: true, force: true });
  });
  const request = { method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' } };
  return { root, handlers, config, baseline, saved, module,
    post: (path, body = {}) => handlers.get(path)({ ...request, body }),
    get: path => handlers.get(path)({ ...request, method: 'GET' }) };
}

test('family settings expose safe dropdowns and save only this module settings', async t => {
  const h = await setup(t);
  const choices = await h.get('/settings/options');
  assert.equal(choices.ok, true);
  assert.equal(choices.voices.options[0].id, '');
  assert.equal(JSON.stringify(choices).includes('private-fixture-path'), false);
  const patch = { networkInterface: 'Synthetic interface', speakerDevice: 'synthetic-device', motherVoice: '' };
  assert.equal((await h.post('/settings/save', patch)).ok, true);
  assert.deepEqual(h.saved, [patch]);
  assert.equal(JSON.stringify(h.config), h.baseline);
  assert.equal((await h.post('/settings/save', { ...patch, motherVoice: 'missing voice' })).ok, false);
  assert.equal(h.saved.length, 1);
  assert.equal((await h.post('/settings/save', { ...patch, dialogueVoice: 'retired family voice' })).ok, true);
  assert.deepEqual(h.saved[1], patch);
  assert.equal(Object.hasOwn(h.saved[1], 'dialogueVoice'), false);
});

test('module exports and HTTP routes share the playback and recurring reminder formats', async t => {
  const h = await setup(t);
  const capability = await h.get('/capabilities');
  assert.deepEqual(capability.tools.map(tool => tool.name), ['xiaoai_music', 'xiaoai_reminder']);
  assert.equal(typeof h.module.execute, 'function'); assert.equal(typeof h.module.remind, 'function');
  assert.deepEqual((await h.module.execute({ action: 'catalog' })).songs, []);
  const created = await h.post('/reminders/create', { text: 'Synthetic reminder prompt', schedule: { frequency: 'weekly', time: '09:15', weekdays: [1, 5] } });
  assert.equal(created.ok, true); assert.equal(created.reminder.state, 'active');
  assert.deepEqual(created.reminder.schedule.weekdays, [1, 5]);
  assert.equal((await h.module.remind({ action: 'list' })).reminders[0].id, created.reminder.id);
  const stored = JSON.parse(await readFile(resourcePaths(h.root).remindersFile, 'utf8'));
  assert.match(JSON.stringify(stored), /Synthetic reminder prompt/);
  const cancelled = await h.post('/reminders/cancel', { id: created.reminder.id });
  assert.equal(cancelled.ok, true); assert.equal(cancelled.reminder.state, 'cancelled');
  assert.equal((await h.get('/status')).connected, false);
});

test('invalid schedules and remote reminder writes cannot create a reminder', async t => {
  const h = await setup(t);
  assert.equal((await h.post('/reminders/create', { text: 'Synthetic', schedule: { frequency: 'weekly', time: '08:00', weekdays: [] } })).ok, false);
  const blocked = await h.handlers.get('/reminders/create')({ method: 'POST', socket: { remoteAddress: '192.0.2.10' },
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' }, body: { text: 'Synthetic', schedule: { frequency: 'daily', time: '08:00' } } });
  assert.equal(blocked.ok, false); assert.deepEqual((await h.get('/reminders')).reminders, []);
  assert.equal((await h.module.remind({ action: 'create', text: 'Synthetic', schedule: { frequency: 'daily', time: '08:00' } }, { isCurrent: () => false })).cancelled, true);
  assert.deepEqual((await h.module.remind({ action: 'list' })).reminders, []);
});

test('independent family persona endpoints are absent', async t => {
 const h=await setup(t);
 assert.equal(h.handlers.has('/companion/persona'),false);
 assert.equal(h.handlers.has('/companion/persona/save'),false);
 assert.equal(JSON.stringify(h.config),h.baseline);
});

test('playlist HTTP routes create, rename, preserve an empty list and delete without touching audio', async t => {
  const h = await setup(t);
  const created = await h.post('/songs/playlist/create', { name: 'Synthetic list' });
  assert.equal(created.ok, true); assert.deepEqual(created.playlist.ids, []);
  const changed = await h.post('/songs/playlist/update', { id: created.playlist.id, name: 'Synthetic renamed', ids: [] });
  assert.equal(changed.ok, true); assert.equal(changed.playlist.id, created.playlist.id);
  assert.equal(changed.playlist.name, 'Synthetic renamed');
  const deleted = await h.post('/songs/playlist/delete', { id: created.playlist.id });
  assert.equal(deleted.ok, true); assert.deepEqual(deleted.playlists, []);
  assert.equal(deleted.connected, false);
});

test('new singing generation follows expression selection or an explicit dropdown without guessing a mother model', () => {
  const voices = [{ id: '妈妈' }, { id: 'Expression selected voice' }];
  assert.equal(selectSingingVoice(voices, '', 'Expression selected voice').id, 'Expression selected voice');
  assert.equal(selectSingingVoice(voices, '妈妈', 'Expression selected voice').id, '妈妈');
  assert.throws(() => selectSingingVoice(voices), { code: 'FAMILY_MOTHER_REQUIRED' });
  assert.throws(() => selectSingingVoice(voices, 'Missing', 'Expression selected voice'), { code: 'FAMILY_MOTHER_REQUIRED' });
});

async function seedSong(h) {
  const paths = resourcePaths(h.root);
  const seed = new SongLibrary({ root: paths.songRoot, workRoot: paths.workRoot, describe: async source => ({
    identity: { version: 'synthetic-delete-fixture', source: { id: source.id }, voice: { role: 'mother' }, parameters: { pitch: 0 } },
    render: async work => {
      const source = join(work, 'source.mp3'), file = join(work, 'full.mp3');
      await writeFile(source, 'synthetic source'); await writeFile(file, 'synthetic full audio');
      return { source, file, sourceDuration: 1, duration: 1 };
    },
  }) });
  await seed.open(); seed.addSources([{ id: 'synthetic-delete', title: 'Synthetic removable song', artists: 'Synthetic artist', durationSec: 1 }]);
  const job = await seed.request('synthetic-delete'); await seed.wait(job.id);
  return seed.get(job.id);
}

test('delete route removes the isolated audio and all playlist references without connecting to a speaker', async t => {
  const h = await setup(t), entry = await seedSong(h);
  const first = await h.post('/songs/playlist/create', { name: 'Synthetic first' });
  const second = await h.post('/songs/playlist/create', { name: 'Synthetic second' });
  for (const list of [first.playlist, second.playlist]) {
    assert.equal((await h.post('/songs/playlist/update', { id: list.id, ids: [entry.id] })).ok, true);
  }
  const result = await h.post('/songs/delete', { id: entry.id });
  assert.equal(result.ok, true); assert.equal(result.deleted, entry.id); assert.equal(result.affectedPlaylists, 2);
  assert.deepEqual(result.songs.entries, []); assert.ok(result.playlists.every(list => list.ids.length === 0));
  assert.equal(result.connected, false);
  await assert.rejects(readFile(entry.absoluteFile), { code: 'ENOENT' });
  await assert.rejects(readFile(join(resourcePaths(h.root).metadataRoot, entry.id + '.json')), { code: 'ENOENT' });
});

test('delete failure restores playlist references and returns a fixed error without losing the cached file', async t => {
  const h = await setup(t), entry = await seedSong(h);
  const created = await h.post('/songs/playlist/create', { name: 'Synthetic retained' });
  await h.post('/songs/playlist/update', { id: created.playlist.id, ids: [entry.id] });
  const original = SongLibrary.prototype.remove;
  SongLibrary.prototype.remove = async () => { throw new FamilySongError('FAMILY_DELETE_FAILED', '隔离删除失败'); };
  t.after(() => { SongLibrary.prototype.remove = original; });
  const result = await h.post('/songs/delete', { id: entry.id });
  assert.equal(result.ok, false); assert.equal(result.code, 'FAMILY_DELETE_FAILED');
  const status = await h.get('/status');
  assert.deepEqual(status.playlists[0].ids, [entry.id]); assert.equal(status.songs.entries.length, 1);
  assert.equal(await readFile(entry.absoluteFile, 'utf8'), 'synthetic full audio');
});
