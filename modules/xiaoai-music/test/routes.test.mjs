import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import definition from '../index.mjs';
import { SongLibrary } from '../lib/songs/library.mjs';
import { FamilyPlayback } from '../lib/songs/playback.mjs';
import { resourcePaths } from '../lib/songs/storage.mjs';

globalThis.aurabot = { src: new URL('../', import.meta.url), lib: () => ({}) };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function routes(t) {
  const directory = await mkdtemp(join(tmpdir(), 'family-routes-isolated-'));
  const handlers = new Map();
  const disposers = [];
  const resources = resourcePaths(directory);
  await mkdir(dirname(resources.playlistsFile), { recursive: true });
  await writeFile(resources.playlistsFile, JSON.stringify({ schema: 1, lists: [
    { id: 'synthetic-list', name: 'Synthetic', ids: ['a'.repeat(64)] },
  ] }));
  await definition.setup({
    tool() {}, rule() {}, defineTool: value => value,
    settings: () => ({ resourceRoot: directory }), config: () => ({ song: {} }),
    route: (path, handler) => handlers.set(path, handler), every() {}, on() {},
    onDispose: callback => disposers.push(callback), core: { http: { body: async req => req.body } },
  });
  t.after(async () => {
    for (const dispose of disposers) await dispose();
    assert.ok(dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('family-routes-isolated-'), 'Unexpected temporary cleanup directory');
    await rm(directory, { recursive: true, force: true });
  });
  return (path, body = {}) => handlers.get(path)({ method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' }, body });
}

function spyPlayback(t, actions) {
  const original = { source: FamilyPlayback.prototype.source, entry: FamilyPlayback.prototype.entry,
    playlist: FamilyPlayback.prototype.playlist, request: SongLibrary.prototype.request };
  FamilyPlayback.prototype.source = async () => { actions.push('source-play'); return { id: 'synthetic-job' }; };
  FamilyPlayback.prototype.entry = async () => { actions.push('entry-play'); };
  FamilyPlayback.prototype.playlist = async () => { actions.push('list-play'); };
  SongLibrary.prototype.request = async () => { actions.push('save'); return { id: 'synthetic-job', state: 'queued' }; };
  t.after(() => {
    Object.assign(FamilyPlayback.prototype, { source: original.source, entry: original.entry, playlist: original.playlist });
    SongLibrary.prototype.request = original.request;
  });
}

async function delayedSelection(t) {
  const started = deferred();
  const release = deferred();
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    started.resolve();
    await release.promise;
    return Response.json({ code: 200, songs: [{ id: 123, name: 'Synthetic song',
      artists: [{ name: 'Synthetic artist' }], duration: 180000 }] });
  };
  t.after(() => { globalThis.fetch = previous; });
  return { started: started.promise, release: release.resolve };
}

test('stop during source selection saves the late generation without starting playback', async t => {
  const actions = [];
  spyPlayback(t, actions);
  const selection = await delayedSelection(t);
  const post = await routes(t);
  const pending = post('/songs/generate', { songId: '123', play: true });
  await selection.started;
  assert.equal((await post('/songs/stop')).ok, true);
  selection.release();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.deepEqual(actions, ['save']);
});

test('a newer selected entry prevents an older source lookup from taking over', async t => {
  const actions = [];
  spyPlayback(t, actions);
  const selection = await delayedSelection(t);
  const post = await routes(t);
  const pending = post('/songs/generate', { songId: '123', play: true });
  await selection.started;
  await post('/songs/play', { id: 'a'.repeat(64) });
  selection.release();
  assert.equal((await pending).cancelled, true);
  assert.deepEqual(actions, ['entry-play', 'save']);
});

for (const path of ['/songs/play', '/songs/playlist/play']) {
  test('stop during initialization cancels the pending ' + path, async t => {
    const actions = [];
    spyPlayback(t, actions);
    const started = deferred();
    const release = deferred();
    const original = SongLibrary.prototype.open;
    SongLibrary.prototype.open = async function () { started.resolve(); await release.promise; await original.call(this); };
    t.after(() => { SongLibrary.prototype.open = original; });
    const post = await routes(t);
    const pending = post(path, { id: path.endsWith('/play') && path.includes('/playlist/') ? 'synthetic-list' : 'a'.repeat(64) });
    await started.promise;
    const stopped = post('/songs/stop');
    release.resolve();
    assert.equal((await pending).cancelled, true);
    await stopped;
    assert.deepEqual(actions, []);
  });
}
