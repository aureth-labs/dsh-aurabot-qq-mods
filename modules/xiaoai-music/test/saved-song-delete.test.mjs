import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, unlink, access, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { SongLibrary } from '../lib/songs/library.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function harness(t, { unlinkFile } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'family-song-remove-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('family-song-remove-'));
    await rm(directory, { recursive: true, force: true });
  });
  let renders = 0, describeWait;
  const library = new SongLibrary({ root: join(directory, 'library'), workRoot: join(directory, 'work'), unlinkFile,
    describe: async (source, pitch) => {
      await describeWait?.();
      return { identity: { version: 'remove-test-v1', source: { id: source.id }, voice: { role: 'mother', digest: 'synthetic' }, parameters: { pitch } },
        render: async work => { renders++; const file = join(work, 'full.mp3'), original = join(work, 'source.mp3');
          await writeFile(file, 'synthetic converted song'); await writeFile(original, 'synthetic original song');
          return { file, source: original, duration: 3, sourceDuration: 3 }; } };
    } });
  await library.open(); library.addSources([{ id: 'synthetic-source', title: 'Synthetic song', artists: 'Synthetic artist', durationSec: 3 }]);
  const job = await library.request('synthetic-source'); await library.wait(job.id);
  const entry = await library.get(job.id), metadata = join(library.metadataRoot, job.id + '.json');
  return { directory, library, entry, metadata, renders: () => renders, setDescribeWait: wait => { describeWait = wait; } };
}

test('removing a named saved song deletes only its audio and metadata and permits a later explicit regeneration', async t => {
  const h = await harness(t);
  const retained = join(h.library.root, 'retained.txt'); await writeFile(retained, 'leave this alone');
  const removed = await h.library.remove(h.entry.id);
  assert.equal(removed.id, h.entry.id);
  assert.equal(h.library.status().entries.length, 0);
  assert.equal(h.library.status().jobs.length, 0);
  await assert.rejects(access(h.entry.absoluteFile), { code: 'ENOENT' });
  await assert.rejects(access(h.metadata), { code: 'ENOENT' });
  assert.equal(await readFile(retained, 'utf8'), 'leave this alone');
  await assert.rejects(h.library.get(h.entry.id), { code: 'FAMILY_ENTRY_MISSING' });
  const generated = await h.library.request('synthetic-source'); await h.library.wait(generated.id);
  assert.equal(generated.reused, false); assert.equal(h.renders(), 2);
});

test('legacy deletion preserves unrelated files in the hashed directory', async t => {
  const h = await harness(t), directory = join(h.library.root, h.entry.id);
  const { absoluteFile, ...entry } = h.entry;
  await mkdir(directory);
  await writeFile(join(directory, 'audio.mp3'), await readFile(absoluteFile));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...entry, schema: 1, file: 'audio.mp3' }));
  await writeFile(join(directory, 'notes.txt'), 'unrelated fixture');
  await unlink(absoluteFile); await unlink(h.metadata);
  await h.library.remove(entry.id);
  await assert.rejects(access(join(directory, 'audio.mp3')), { code: 'ENOENT' });
  await assert.rejects(access(join(directory, 'manifest.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(directory, 'notes.txt'), 'utf8'), 'unrelated fixture');
});

test('invalid ids and metadata traversal cannot delete arbitrary files', async t => {
  const h = await harness(t), outside = join(h.directory, 'outside.mp3');
  await writeFile(outside, 'not a library song');
  const original = await readFile(h.entry.absoluteFile, 'utf8');
  await assert.rejects(h.library.remove('../outside.mp3'), { code: 'FAMILY_ENTRY_INVALID' });
  const { absoluteFile, ...entry } = h.entry;
  await writeFile(h.metadata, JSON.stringify({ ...entry, file: '../outside.mp3' }));
  await assert.rejects(h.library.remove(entry.id), { code: 'FAMILY_CACHE_INVALID' });
  assert.equal(await readFile(outside, 'utf8'), 'not a library song');
  assert.equal(await readFile(absoluteFile, 'utf8'), original);
});

test('a legacy directory linked outside the library is not a deletion target', async t => {
  const h = await harness(t), outside = join(h.directory, 'outside-legacy');
  const { absoluteFile, ...entry } = h.entry;
  await mkdir(outside);
  await writeFile(join(outside, 'audio.mp3'), await readFile(absoluteFile));
  await writeFile(join(outside, 'manifest.json'), JSON.stringify({ ...entry, schema: 1, file: 'audio.mp3' }));
  await unlink(absoluteFile); await unlink(h.metadata);
  await symlink(outside, join(h.library.root, entry.id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(h.library.remove(entry.id), { code: 'FAMILY_ENTRY_DELETE_UNSAFE' });
  assert.equal(await readFile(join(outside, 'audio.mp3'), 'utf8'), 'synthetic converted song');
  await access(join(outside, 'manifest.json'));
});

test('an audio deletion failure restores the exact metadata and leaves the entry playable', async t => {
  const h = await harness(t, { unlinkFile: async file => {
    if (file.endsWith('.mp3')) throw new Error('synthetic private filesystem error');
    return unlink(file);
  } });
  const before = await readFile(h.metadata);
  await assert.rejects(h.library.remove(h.entry.id), error => error.code === 'FAMILY_ENTRY_DELETE_FAILED' && !error.message.includes('private'));
  assert.deepEqual(await readFile(h.metadata), before);
  assert.equal((await h.library.get(h.entry.id)).id, h.entry.id);
  assert.equal(h.library.status().entries.length, 1);
});

test('a metadata deletion failure does not touch audio and cannot be reported as success', async t => {
  const h = await harness(t, { unlinkFile: async () => { throw new Error('synthetic locked record'); } });
  const before = await readFile(h.metadata), audio = await readFile(h.entry.absoluteFile);
  await assert.rejects(h.library.remove(h.entry.id), { code: 'FAMILY_ENTRY_DELETE_FAILED' });
  assert.deepEqual(await readFile(h.metadata), before);
  assert.deepEqual(await readFile(h.entry.absoluteFile), audio);
});

test('failed metadata recovery is explicit and never overwrites a newly placed file', async t => {
  let metadata;
  const h = await harness(t, { unlinkFile: async file => {
    if (file.endsWith('.json')) { metadata = file; return unlink(file); }
    await writeFile(metadata, 'synthetic replacement record');
    throw new Error('synthetic locked audio');
  } });
  await assert.rejects(h.library.remove(h.entry.id), { code: 'FAMILY_ENTRY_DELETE_INCOMPLETE' });
  assert.equal(await readFile(h.metadata, 'utf8'), 'synthetic replacement record');
  assert.equal(await readFile(h.entry.absoluteFile, 'utf8'), 'synthetic converted song');
  assert.equal(h.library.status().entries.length, 0);
});

test('a request started before deletion cannot regenerate the deleted song after its description returns', async t => {
  const h = await harness(t), started = deferred(), release = deferred();
  h.setDescribeWait(async () => { started.resolve(); await release.promise; });
  const request = h.library.request('synthetic-source'); await started.promise;
  await h.library.remove(h.entry.id); release.resolve();
  await assert.rejects(request, { code: 'FAMILY_ENTRY_BUSY' });
  assert.equal(h.renders(), 1); assert.equal(h.library.status().entries.length, 0);
});

test('a get already reading before deletion cannot return a stale audio path', async t => {
  const h = await harness(t), started = deferred(), release = deferred();
  const readEntry = h.library.readEntry.bind(h.library); let first = true;
  h.library.readEntry = async id => { const entry = await readEntry(id); if (first) { first = false; started.resolve(); await release.promise; } return entry; };
  const reading = h.library.get(h.entry.id); await started.promise;
  await h.library.remove(h.entry.id); release.resolve();
  await assert.rejects(reading, { code: 'FAMILY_ENTRY_BUSY' });
});

test('a cached request completing after deletion cannot put the removed entry back in memory', async t => {
  const h = await harness(t), started = deferred(), release = deferred();
  const readEntry = h.library.readEntry.bind(h.library); let first = true;
  h.library.readEntry = async id => { const entry = await readEntry(id); if (first) { first = false; started.resolve(); await release.promise; } return entry; };
  const request = h.library.request('synthetic-source'); await started.promise;
  await h.library.remove(h.entry.id); release.resolve();
  await assert.rejects(request, { code: 'FAMILY_ENTRY_BUSY' });
  assert.equal(h.library.status().entries.length, 0);
  assert.equal(h.library.status().jobs.length, 0);
  assert.equal(h.renders(), 1);
});

test('a queued or generating job blocks deletion without waiting for it', async t => {
  for (const state of ['queued', 'generating']) {
    const h = await harness(t);
    h.library.jobs.set(h.entry.id, { state });
    await assert.rejects(h.library.remove(h.entry.id), { code: 'FAMILY_ENTRY_BUSY' });
    assert.equal((await h.library.get(h.entry.id)).id, h.entry.id);
    await access(h.metadata); await access(h.entry.absoluteFile);
  }
});
