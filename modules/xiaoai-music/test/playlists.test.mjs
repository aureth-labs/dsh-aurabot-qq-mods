import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { SongPlaylists } from '../lib/songs/playlists.mjs';
import { FamilySongError } from '../lib/songs/library.mjs';

const a = 'a'.repeat(64);
const b = 'b'.repeat(64);
async function harness(t, library = { get: async () => ({ full: true }) }) {
  const root = await mkdtemp(join(tmpdir(), 'family-playlists-isolated-'));
  t.after(() => {
    assert.ok(dirname(resolve(root)) === resolve(tmpdir()) && basename(root).startsWith('family-playlists-isolated-'), 'Unexpected temporary cleanup directory');
    return rm(root, { recursive: true, force: true });
  });
  const file = join(root, 'playlists.json');
  const create = () => new SongPlaylists({ file, library });
  const lists = create();
  await lists.open();
  return { file, lists, create };
}

test('saved playlists preserve selection order across reload and replace the same name', async t => {
  const h = await harness(t);
  const first = await h.lists.save('Synthetic list', [b, a, b]);
  const reopened = h.create();
  await reopened.open();
  assert.deepEqual(reopened.get(first.id).ids, [b, a]);
  const changed = await reopened.save('Synthetic list', [a]);
  assert.equal(changed.id, first.id);
  assert.equal(reopened.status().length, 1);
  assert.deepEqual(reopened.get(first.id).ids, [a]);
  changed.ids.push(b);
  assert.deepEqual(reopened.get(first.id).ids, [a]);
});

test('playlist cannot save a missing or damaged song over the existing selection', async t => {
  const h = await harness(t, { get: async id => { if (id === b) throw new Error('synthetic invalid entry'); } });
  await h.lists.save('Synthetic list', [a]);
  const before = await readFile(h.file, 'utf8');
  await assert.rejects(h.lists.save('Synthetic list', [b]));
  assert.equal(await readFile(h.file, 'utf8'), before);
  await assert.rejects(h.lists.save('Synthetic list', ['not-an-entry']));
});

test('concurrent playlist edits survive reload without losing another list', async t => {
  const h = await harness(t);
  await Promise.all([h.lists.save('One', [a]), h.lists.save('Two', [b])]);
  const reopened = h.create();
  await reopened.open();
  assert.equal(reopened.status().length, 2);
});

test('damaged playlist data is reported without overwriting the file', async t => {
  const h = await harness(t);
  await writeFile(h.file, '{broken-json', 'utf8');
  await assert.rejects(h.create().open(), { code: 'FAMILY_PLAYLIST_INVALID' });
  assert.equal(await readFile(h.file, 'utf8'), '{broken-json');
});

test('an empty playlist can be created, renamed and reordered without changing its identity', async t => {
  const h = await harness(t);
  const first = await h.lists.create('New list');
  const second = await h.lists.create('Another list', [a]);
  assert.deepEqual(first.ids, []);
  let reopened = h.create(); await reopened.open();
  assert.deepEqual(reopened.get(first.id).ids, []);
  const changed = await reopened.update(first.id, { name: 'Renamed list', ids: [b, a] });
  assert.equal(changed.id, first.id);
  assert.deepEqual(reopened.status().map(list => list.id), [first.id, second.id]);
  await reopened.update(first.id, { ids: [a, b] });
  reopened = h.create(); await reopened.open();
  assert.equal(reopened.get(first.id).name, 'Renamed list');
  assert.deepEqual(reopened.get(first.id).ids, [a, b]);
  await reopened.update(first.id, { ids: [] });
  const emptyAgain = h.create(); await emptyAgain.open();
  assert.deepEqual(emptyAgain.get(first.id).ids, []);
});

test('creating or renaming to another playlist name cannot replace that playlist', async t => {
  const h = await harness(t);
  const first = await h.lists.create('One', [a]);
  const second = await h.lists.create('Two', [b]);
  const before = await readFile(h.file, 'utf8');
  await assert.rejects(h.lists.create('One'), { code: 'FAMILY_PLAYLIST_NAME_EXISTS' });
  await assert.rejects(h.lists.update(first.id, { name: 'Two' }), { code: 'FAMILY_PLAYLIST_NAME_EXISTS' });
  assert.equal(await readFile(h.file, 'utf8'), before);
  assert.deepEqual(h.lists.get(second.id).ids, [b]);
  await h.lists.save('One renamed', [b, a], { id: first.id });
  assert.equal(h.lists.get(first.id).name, 'One renamed');
  assert.deepEqual(h.lists.get(second.id).ids, [b]);
});

test('deleting a playlist preserves song files and other playlists', async t => {
  const h = await harness(t);
  const audio = join(dirname(h.file), 'synthetic-song.mp3');
  const bytes = Buffer.from('synthetic-song-data'); await writeFile(audio, bytes);
  const first = await h.lists.create('Remove this', [a]);
  const retained = await h.lists.create('Keep this', [a, b]);
  assert.equal((await h.lists.remove(first.id)).id, first.id);
  const reopened = h.create(); await reopened.open();
  assert.deepEqual(reopened.status(), [retained]);
  assert.deepEqual(await readFile(audio), bytes);
  const before = await readFile(h.file, 'utf8');
  await assert.rejects(reopened.remove(first.id), { code: 'FAMILY_PLAYLIST_MISSING' });
  assert.equal(await readFile(h.file, 'utf8'), before);
});

test('invalid edits and persistence failures preserve the current list and allow a later valid edit', async t => {
  const h = await harness(t, { get: async id => { if (id === b) throw new Error('synthetic damaged song'); } });
  const first = await h.lists.create('Retained', [a]);
  const before = await readFile(h.file, 'utf8');
  await assert.rejects(h.lists.update(first.id, { ids: ['../outside'] }), { code: 'FAMILY_PLAYLIST_INPUT' });
  await assert.rejects(h.lists.update(first.id, { ids: [b] }));
  const blocked = join(dirname(h.file), 'blocked'); await writeFile(blocked, 'synthetic blocker');
  h.lists.file = join(blocked, 'playlists.json');
  await assert.rejects(h.lists.update(first.id, { name: 'Not saved' }));
  assert.deepEqual(h.lists.get(first.id), first);
  assert.equal(await readFile(h.file, 'utf8'), before);
  h.lists.file = h.file;
  await h.lists.update(first.id, { name: 'Saved later' });
  const reopened = h.create(); await reopened.open();
  assert.equal(reopened.get(first.id).name, 'Saved later');
});

test('concurrent creation and edits serialize without duplicate names or lost lists', async t => {
  const h = await harness(t);
  const duplicate = await Promise.allSettled([h.lists.create('Same'), h.lists.create('Same')]);
  assert.equal(duplicate.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(duplicate.filter(result => result.status === 'rejected')[0].reason.code, 'FAMILY_PLAYLIST_NAME_EXISTS');
  const first = duplicate.find(result => result.status === 'fulfilled').value;
  const retained = await h.lists.create('Retained', [b]);
  await Promise.all([h.lists.update(first.id, { ids: [a] }), h.lists.remove(first.id)]);
  const reopened = h.create(); await reopened.open();
  assert.deepEqual(reopened.status(), [retained]);
});

test('a playlist whose load failed cannot be mutated over its damaged file', async t => {
  const h = await harness(t);
  await writeFile(h.file, '{broken-json', 'utf8');
  const invalid = h.create(); await assert.rejects(invalid.open(), { code: 'FAMILY_PLAYLIST_INVALID' });
  for (const operation of [() => invalid.create('No replacement'), () => invalid.save('No replacement', [a]),
    () => invalid.update('missing', { name: 'No replacement' }), () => invalid.remove('missing')]) {
    await assert.rejects(operation(), { code: 'FAMILY_PLAYLIST_INVALID' });
  }
  assert.equal(await readFile(h.file, 'utf8'), '{broken-json');
});

test('removing a library song clears every playlist reference before deleting its files', async t => {
  const h = await harness(t);
  const first = await h.lists.create('One', [a, b]);
  const second = await h.lists.create('Two', [a]);
  const other = await h.lists.create('Other', [b]);
  const result = await h.lists.removeSong(a, async () => {
    assert.deepEqual(h.lists.get(first.id).ids, [b]);
    assert.deepEqual(h.lists.get(second.id).ids, []);
    return { id: a };
  });
  assert.deepEqual(result, { entry: { id: a }, affectedPlaylists: 2 });
  const reopened = h.create(); await reopened.open();
  assert.deepEqual(reopened.get(first.id).ids, [b]);
  assert.deepEqual(reopened.get(second.id).ids, []);
  assert.deepEqual(reopened.get(other.id), other);
});

test('failed song deletion restores references while holding edits in request order', async t => {
  const h = await harness(t);
  const list = await h.lists.create('Original', [a, b]);
  let started, release;
  const deleting = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const removal = h.lists.removeSong(a, async () => { started(); await pending; throw new FamilySongError('FAMILY_ENTRY_DELETE_FAILED', 'synthetic deletion failure'); });
  await deleting;
  let edited = false;
  const editing = h.lists.update(list.id, { name: 'Edited later' }).then(() => { edited = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(edited, false);
  release();
  await assert.rejects(removal, { code: 'FAMILY_ENTRY_DELETE_FAILED' }); await editing;
  const reopened = h.create(); await reopened.open();
  assert.deepEqual(reopened.get(list.id), { ...list, name: 'Edited later' });
});

test('song deletion is not attempted if playlist reference persistence fails', async t => {
  const h = await harness(t);
  const list = await h.lists.create('Original', [a]);
  const before = await readFile(h.file);
  const blocked = join(dirname(h.file), 'blocked-removal'); await writeFile(blocked, 'synthetic blocker');
  h.lists.file = join(blocked, 'playlists.json');
  let deleted = false;
  await assert.rejects(h.lists.removeSong(a, async () => { deleted = true; return { id: a }; }));
  assert.equal(deleted, false);
  assert.deepEqual(h.lists.get(list.id), list);
  assert.deepEqual(await readFile(h.file), before);
});

test('an incomplete file recovery leaves no playlist pointing at the unreadable song record', async t => {
  const h = await harness(t);
  const list = await h.lists.create('Original', [a, b]);
  await assert.rejects(h.lists.removeSong(a, async () => {
    throw new FamilySongError('FAMILY_ENTRY_DELETE_INCOMPLETE', 'synthetic incomplete recovery');
  }), { code: 'FAMILY_ENTRY_DELETE_INCOMPLETE' });
  const reopened = h.create(); await reopened.open();
  assert.deepEqual(reopened.get(list.id).ids, [b]);
});

test('failed reference recovery reports failure without claiming that the song was deleted', async t => {
  const h = await harness(t);
  const list = await h.lists.create('Original', [a, b]);
  const persist = h.lists.persist.bind(h.lists); let writes = 0;
  h.lists.persist = async next => { if (++writes === 2) throw new Error('synthetic write failure'); return persist(next); };
  await assert.rejects(h.lists.removeSong(a, async () => { throw new Error('synthetic delete failure'); }), { code: 'FAMILY_PLAYLIST_RESTORE_FAILED' });
  assert.deepEqual(h.lists.get(list.id).ids, [b]);
});
