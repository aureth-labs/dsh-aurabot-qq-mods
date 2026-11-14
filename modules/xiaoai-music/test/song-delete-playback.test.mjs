import test from 'node:test';
import assert from 'node:assert/strict';
import { FamilyPlayback } from '../lib/songs/playback.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness({ indexed = true, request } = {}) {
  const entries = new Map(['a', 'b', 'c'].map(id => [id, { id, source: { id: 'source-' + id }, absoluteFile: id + '.mp3', duration: 10 }]));
  const files = [], timers = [];
  const library = {
    get: async id => { if (!entries.has(id)) throw Object.assign(new Error('Synthetic missing'), { code: 'FAMILY_ENTRY_MISSING' }); return entries.get(id); },
    wait: async () => {},
    request: request || (async source => ({ id: source.replace('source-', ''), state: 'ready' })),
  };
  if (indexed) library.entries = entries;
  const player = new FamilyPlayback({ library, getSpeaker: async () => ({
    playFile: async file => files.push(file), operate: async () => {},
  }), schedule: fn => { timers.push(fn); return fn; }, cancel: () => {} });
  return { player, library, entries, files, timers };
}

test('current or upcoming playlist songs cannot be removed and the callback is untouched', async () => {
  const h = harness(); let removed = 0;
  await h.player.playlist(['a', 'b']); await h.player.task;
  for (const id of ['a', 'b']) await assert.rejects(h.player.removeEntry(id, async () => removed++), { code: 'FAMILY_ENTRY_IN_USE' });
  assert.equal(removed, 0);
  assert.deepEqual(h.files, ['a.mp3']);
  assert.deepEqual(h.player.status().playlist.ids, ['a', 'b']);
  await h.player.stop();
});

test('removal reserves its id before waiting and competing starts leave unrelated playback alone', async () => {
  const h = harness(); const started = deferred(), finish = deferred();
  await h.player.entry('b'); await h.player.task;
  const prior = h.player.status();
  const removing = h.player.removeEntry('a', async () => { started.resolve(); await finish.promise; h.entries.delete('a'); });
  await started.promise;
  await assert.rejects(h.player.entry('a'), { code: 'FAMILY_ENTRY_REMOVING' });
  await assert.rejects(h.player.playlist(['b', 'a']), { code: 'FAMILY_ENTRY_REMOVING' });
  await assert.rejects(h.player.source('source-a'), { code: 'FAMILY_ENTRY_REMOVING' });
  await assert.rejects(h.player.removeEntry('a', async () => {}), { code: 'FAMILY_ENTRY_REMOVING' });
  assert.deepEqual(h.player.status(), prior);
  finish.resolve(); await removing;
  assert.deepEqual(h.files, ['b.mp3']);
  await h.player.stop();
});

test('an old playlist snapshot cannot start even its first song after another member was removed', async () => {
  for (const indexed of [true, false]) {
    const h = harness({ indexed }); const stale = ['b', 'a'];
    await h.player.entry('c'); await h.player.task;
    await h.player.removeEntry('a', async () => { h.entries.delete('a'); });
    const before = h.player.status();
    await assert.rejects(h.player.playlist(stale), { code: 'FAMILY_ENTRY_MISSING' });
    assert.deepEqual(h.player.status(), before);
    assert.deepEqual(h.files, ['c.mp3']);
    await h.player.stop();
  }
});

test('a source still resolving identity makes its saved source busy before selected is assigned', async () => {
  const requested = deferred(), result = deferred();
  const h = harness({ request: async () => { requested.resolve(); return result.promise; } });
  const playing = h.player.source('source-a'); await requested.promise;
  assert.equal(h.player.status().selected, null);
  let removed = false;
  await assert.rejects(h.player.removeEntry('a', async () => { removed = true; }), { code: 'FAMILY_ENTRY_IN_USE' });
  assert.equal(removed, false);
  result.resolve({ id: 'a', state: 'ready' }); await playing; await h.player.task;
  assert.deepEqual(h.files, ['a.mp3']);
  await h.player.stop();
});

test('a failed removal releases its reservation and does not mark the retained entry missing', async () => {
  const h = harness({ indexed: false });
  await assert.rejects(h.player.removeEntry('a', async () => { throw new Error('Synthetic rollback'); }), /Synthetic rollback/);
  await h.player.entry('a'); await h.player.task;
  assert.deepEqual(h.files, ['a.mp3']);
  await h.player.stop();
});

test('an explicitly regenerated source can be played again after deletion', async () => {
  const h = harness();
  const saved = h.entries.get('a');
  await h.player.removeEntry('a', async () => { h.entries.delete('a'); });
  h.library.request = async () => { h.entries.set('a', saved); return { id: 'a', state: 'ready' }; };
  await h.player.source('source-a'); await h.player.task;
  assert.deepEqual(h.files, ['a.mp3']);
  assert.equal(h.player.status().phase, 'playing');
  await h.player.stop();
});
