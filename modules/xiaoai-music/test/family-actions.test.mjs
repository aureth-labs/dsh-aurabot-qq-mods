import test from 'node:test';
import assert from 'node:assert/strict';
import { createFamilyActions } from '../lib/companion/actions.mjs';
import { FamilyPlayback } from '../lib/songs/playback.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness() {
  let intent = 0;
  const calls = [];
  const entries = [{ id: 'saved-a', sourceId: '123', title: 'Synthetic song', artists: 'Synthetic artist' }];
  const playback = { status: () => ({ phase: 'playing' }), source: async (...args) => calls.push(['source', ...args]),
    entry: async (...args) => calls.push(['entry', ...args]),
    playlist: async (...args) => calls.push(['playlist', ...args]), next: async (...args) => calls.push(['next', ...args]),
    stop: async () => calls.push(['stop']) };
  const context = { library: { status: () => ({ entries }) }, playlists: { status: () => [{ id: 'list-a', name: 'Synthetic list', ids: ['saved-a'] }] }, playback };
  const execute = createFamilyActions({ getContext: async () => context, onMutation: () => ++intent, getIntent: () => intent });
  return { execute, calls, entries, playback };
}

test('family catalog and ambiguous requests cannot start playback or expose file paths', async () => {
  const h = harness();
  const catalog = await h.execute({ action: 'catalog' });
  assert.equal(catalog.ok, true);
  assert.equal(catalog.songs.length, 1);
  assert.equal((await h.execute({ action: 'play-song', query: 'Missing title' })).ok, false);
  h.entries.push({ id: 'saved-b', sourceId: '456', title: 'Synthetic song' });
  assert.equal((await h.execute({ action: 'play-song', query: 'Synthetic song' })).ok, false);
  assert.deepEqual(h.calls, []);
});

test('an explicit saved version is played unchanged; ambiguous source cannot generate another version', async () => {
  const h = harness();
  h.entries.push({ id: 'saved-cover', sourceId: '123', title: 'Synthetic song', voice: 'Synthetic cover' });
  assert.equal((await h.execute({ action: 'play-song', query: 'saved-a' })).ok, true);
  assert.equal(h.calls[0][0], 'entry');
  assert.equal(h.calls[0][1], 'saved-a');
  assert.equal((await h.execute({ action: 'play-song', query: '123' })).ok, false);
  assert.equal(h.calls.length, 1);
});

test('family actions select exact saved versions and pass cancellation into preparation', async () => {
  const h = harness();
  assert.equal((await h.execute({ action: 'play-song', query: '123' })).playbackHandled, true);
  assert.equal(h.calls[0][0], 'entry');
  assert.equal(h.calls[0][1], 'saved-a');
  assert.equal(h.calls[0][2].isCurrent(), true);
  await h.execute({ action: 'play-playlist', query: 'Synthetic list' });
  assert.equal(h.calls[0][2].isCurrent(), false);
  assert.equal(h.calls[1][0], 'playlist');
  assert.deepEqual(h.calls[1][1], ['saved-a']);
  const count = h.calls.length;
  assert.equal((await h.execute({ action: 'stop' }, { isCurrent: () => false })).cancelled, true);
  assert.equal(h.calls.length, count);
});

test('a cancelled initial playlist request cannot start after waiting for its speaker', async () => {
  const ready = deferred(), requested = deferred();
  const played = [];
  let current = true;
  const player = new FamilyPlayback({ library: { wait: async () => {}, get: async id => ({ id, absoluteFile: id + '.mp3', duration: 1 }) },
    getSpeaker: async () => { requested.resolve(); return ready.promise; } });
  await player.playlist(['a', 'b'], { isCurrent: () => current });
  await requested.promise;
  current = false;
  ready.resolve({ playFile: async file => played.push(file), releasePlayback() {} });
  await player.task;
  assert.deepEqual(played, []);
  assert.equal(player.status().phase, 'stopped');
});

test('an exact saved entry retains cancellation while waiting for the speaker', async () => {
  const ready = deferred(), requested = deferred();
  const played = [], spoken = []; let current = true;
  const player = new FamilyPlayback({ library: { wait: async () => {}, get: async id => ({ id, absoluteFile: 'synthetic.mp3', duration: 1 }) },
    getSpeaker: async () => { requested.resolve(); return ready.promise; } });
  await player.entry('saved-a', { announce: true, isCurrent: () => current });
  await requested.promise; current = false;
  ready.resolve({ playFile: async file => played.push(file), say: async text => spoken.push(text), releasePlayback() {} });
  await player.task;
  assert.deepEqual(played, []); assert.deepEqual(spoken, []);
  assert.equal(player.status().phase, 'stopped');
});

test('an already started playlist continues its round after the initiating tool turn has ended', async () => {
  const played = [];
  let current = true, timer;
  const player = new FamilyPlayback({ library: { wait: async () => {}, get: async id => ({ id, absoluteFile: id + '.mp3', duration: 1 }) },
    getSpeaker: async () => ({ playFile: async file => played.push(file), operate: async () => {} }),
    schedule: fn => { timer = fn; return 1; }, cancel: () => {} });
  await player.playlist(['a', 'b'], { isCurrent: () => current }); await player.task;
  current = false;
  await timer(); await player.task;
  assert.deepEqual(played, ['a.mp3', 'b.mp3']);
  await player.stop();
});
