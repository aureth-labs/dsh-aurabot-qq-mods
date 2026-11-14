import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, cp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { SongLibrary, FamilySongError } from '../lib/songs/library.mjs';
import { DirectoryLibrary } from '../lib/songs/directories.mjs';
import { createLocalAudioHandler } from '../lib/songs/local-audio.mjs';
import { SongPlaylists } from '../lib/songs/playlists.mjs';

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'music-directories-'));
  const make = () => new DirectoryLibrary({
    primary: new SongLibrary({ root: join(root, 'primary'), workRoot: join(root, 'work'),
      describe: async source => ({ identity: { version: 'directory-test', source: { id: source.id }, voice: { role: 'mother' }, parameters: { pitch: 0 } },
        render: async work => { const file = join(work, 'audio.mp3'); await writeFile(file, 'synthetic-' + source.id); return { file, source: file, duration: 3, sourceDuration: 3 }; } }) }),
    file: join(root, 'private', 'directories.json'), durationOf: async file => file.endsWith('broken.mp3') ? 0 : 3,
  });
  const library = make(); await library.open();
  t.after(async () => { await library.tail; await library.primary.tail;
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('music-directories-'));
    await rm(root, { recursive: true, force: true });
  });
  const folder = async (name, songs = { 'sample.mp3': 'synthetic-audio' }) => {
    const path = join(root, name); await mkdir(path);
    for (const [name, data] of Object.entries(songs)) await writeFile(join(path, name), data);
    return path;
  };
  const generate = async (id = 'synthetic-source') => {
    library.addSources([{ id, title: 'Synthetic song ' + id, artists: 'Synthetic', durationSec: 3 }]);
    const job = await library.request(id); return library.wait(job.id);
  };
  return { root, library, make, folder, generate };
}

test('ordinary audio is indexed in place; duplicate bytes merge, formats and nested files are included', async t => {
  const h = await harness(t), a = await h.folder('ordinary', { 'sample.mp3': 'a', 'sample.wav': 'b', 'ignore.txt': 'text', 'broken.mp3': 'bad' });
  await mkdir(join(a, 'nested')); await writeFile(join(a, 'nested', 'sample.OGG'), 'c');
  const before = await readdir(a); await h.library.add(a);
  const b = await h.folder('copies', { 'renamed.mp3': 'a' }); await h.library.add(b);
  const status = h.library.status(); assert.equal(status.entries.length, 3);
  assert.equal(status.directories[1].skipped, 1);
  assert.deepEqual(await readdir(a), before); assert.deepEqual(await readdir(h.library.root), []);
  const shared = status.entries.find(e => e.directoryIds.length === 2); assert.ok(shared.readOnly);
  assert.equal((await h.library.get(shared.id)).absoluteFile, join(a, 'sample.mp3'));
  await assert.rejects(h.library.remove(shared.id), /只读|不删除原文件/);
  assert.equal(await readFile(join(a, 'sample.mp3'), 'utf8'), 'a');
  const reopened = h.make(); await reopened.open(); assert.deepEqual(reopened.status().entries, status.entries);
  await assert.rejects(h.library.add(a), /重叠/); await assert.rejects(h.library.add(join(a, 'nested')), /重叠/);
  await assert.rejects(h.library.add(h.root), /重叠/);
});





test('refresh keeps missing ordinary song ids, notices new files and restores a returned disk only after refresh', async t => {
  const h = await harness(t), folder = await h.folder('ordinary'); await h.library.add(folder);
  const dir = h.library.directories()[1], id = h.library.status().entries[0].id;
  await unlink(join(folder, 'sample.mp3')); await writeFile(join(folder, 'new.wav'), 'new'); await h.library.refresh(dir.id);
  assert.equal(h.library.status().entries.find(e => e.id === id).available, false); assert.equal(h.library.directories()[1].missing, 1);
  const moved = join(h.root, 'offline'); await rename(folder, moved); await h.library.checkPaths();
  await rename(moved, folder); await h.library.checkPaths(); assert.equal(h.library.directories()[1].phase, 'rescan');
  await writeFile(join(folder, 'sample.mp3'), 'synthetic-audio'); await h.library.refresh(dir.id);
  assert.equal(h.library.status().entries.find(e => e.id === id).available, true);
});





test('corrupt directory registry is reported without replacing it', async t => {
  const h = await harness(t); await writeFile(h.library.file, '{broken');
  await assert.rejects(h.make().open(), /原文件已保留/); assert.equal(await readFile(h.library.file, 'utf8'), '{broken');
});

test('local audio endpoint advertises the actual WAV and OGG type', async t => {
  const h = await harness(t), folder = await h.folder('formats', { 'wave.wav': 'wave', 'ogg.ogg': 'ogg' }); await h.library.add(folder);
  const handler = createLocalAudioHandler({ library: h.library, isLocalRequest: () => true });
  for (const [title, type] of [['wave','audio/wav'],['ogg','audio/ogg']]) {
    const entry = h.library.status().entries.find(e => e.title === title); let response;
    await handler({ method: 'HEAD', url: '/audio?id=' + entry.id, headers: {} }, { writeHead: (status, headers) => { response = { status, headers }; }, end() {} });
    assert.equal(response.status, 200); assert.equal(response.headers['Content-Type'], type);
  }
});

test('a directory update cannot race a pending song generation', async t => {
  const h = await harness(t), folder = await h.folder('ordinary');
  let release; const wait = new Promise(resolve => { release = resolve; });
  const describe = h.library.primary.describe;
  h.library.primary.describe = async (...args) => { const recipe = await describe(...args); return { ...recipe, render: async (...args) => { await wait; return recipe.render(...args); } }; };
  h.library.addSources([{ id: 'delayed', title: 'Delayed synthetic', durationSec: 3 }]);
  const job = await h.library.request('delayed');
  try { await assert.rejects(h.library.add(folder), /等待歌曲生成/); }
  finally { release(); }
  await h.library.wait(job.id); await h.library.add(folder); assert.equal(h.library.directories().length, 2);
});

async function listsFor(h, ids) {
  const lists = new SongPlaylists({ file: join(h.root, 'lists.json'), library: h.library }); await lists.open();
  const list = await lists.create('Synthetic playlist', ids); return { lists, list };
}

test('moved folders show missing songs; adding the new folder works without changing the original path', async t => {
  const h = await harness(t), old = await h.folder('old'); await h.library.add(old);
  const id = h.library.status().entries[0].id, { lists, list } = await listsFor(h, [id]);
  const moved = join(h.root, 'moved'); await rename(old, moved); await h.library.checkPaths();
  assert.equal(h.library.status().entries[0].available, false);
  await assert.rejects(h.library.get(id), /重新添加/);
  assert.equal(h.library.relink, undefined); assert.equal(h.library.checkRelink, undefined);
  await h.library.add(moved);
  assert.equal(h.library.directories()[1].path, old); assert.ok((await h.library.get(id)).absoluteFile.startsWith(moved));
  assert.equal((await h.library.clearMissing(lists)).removed, 0); assert.deepEqual(lists.get(list.id).ids, [id]);
});

test('one-click cleanup drops only missing records and references; moved files and present changed files remain untouched', async t => {
  const h = await harness(t), folder = await h.folder('ordinary', { 'gone.mp3': 'gone', 'keep.wav': 'keep' }); await h.library.add(folder);
  const entries = h.library.status().entries, gone = entries.find(e => e.title === 'gone'), keep = entries.find(e => e.title === 'keep');
  const { lists, list } = await listsFor(h, entries.map(e => e.id));
  const moved = join(h.root, 'moved.mp3'); await rename(join(folder,'gone.mp3'), moved);
  await writeFile(join(folder,'keep.wav'), 'changed-but-still-present'); await h.library.checkPaths();
  assert.equal(h.library.status().entries.find(e => e.id === gone.id).available, false);
  const result = await h.library.clearMissing(lists); assert.deepEqual(result, { removed: 1, affectedPlaylists: 1 });
  assert.deepEqual(lists.get(list.id).ids, [keep.id]); assert.equal(h.library.status().entries.length, 1);
  assert.equal(await readFile(moved,'utf8'),'gone'); assert.equal(await readFile(join(folder,'keep.wav'),'utf8'),'changed-but-still-present');
  const reopened = h.make(); await reopened.open(); assert.equal(reopened.status().entries.length, 1);
  assert.equal((await h.library.clearMissing(lists)).removed, 0);
});

test('a missing managed song does not hide healthy songs and cleanup cannot revive it on restart', async t => {
  const h = await harness(t), gone = await h.generate('gone'), keep = await h.generate('keep');
  const { lists, list } = await listsFor(h, [gone.id, keep.id]);
  const metadata = join(h.library.primary.metadataRoot,gone.id+'.json'), before = await readFile(metadata);
  await unlink(gone.absoluteFile); const reopened = h.make(); await reopened.open();
  assert.equal(reopened.status().entries.find(e => e.id === gone.id).available, false);
  assert.equal(reopened.status().entries.find(e => e.id === keep.id).available, true);
  await reopened.clearMissing(lists); assert.deepEqual(lists.get(list.id).ids,[keep.id]); assert.deepEqual(await readFile(metadata),before);
  const again = h.make(); await again.open(); assert.equal(again.status().entries.some(e => e.id === gone.id),false);
  assert.ok(await again.get(keep.id));
  again.addSources([gone.source]); const job = await again.request(gone.source.id); await again.wait(job.id); assert.ok(await again.get(gone.id));
});

test('failed cleanup index write restores playlist references and leaves the original registry unchanged', async t => {
  const h = await harness(t), folder = await h.folder('ordinary'); await h.library.add(folder);
  const id = h.library.status().entries[0].id, { lists, list } = await listsFor(h,[id]); await unlink(join(folder,'sample.mp3'));
  const before = await readFile(h.library.file), listBefore = await readFile(lists.file);
  h.library.persist = async () => { throw new FamilySongError('FAMILY_DIRECTORY','Synthetic index failure'); };
  await assert.rejects(h.library.clearMissing(lists),/Synthetic index failure/);
  assert.deepEqual(await readFile(h.library.file),before); assert.deepEqual(await readFile(lists.file),listBefore); assert.deepEqual(lists.get(list.id).ids,[id]);
});

test('playlist write failure and unreadable files cannot be treated as successful missing-song cleanup', async t => {
  const h = await harness(t), folder = await h.folder('ordinary'); await h.library.add(folder);
  const id = h.library.status().entries[0].id, { lists } = await listsFor(h,[id]); const before = await readFile(h.library.file);
  const exists = h.library.filePresent.bind(h.library); h.library.filePresent = async () => { throw Object.assign(new Error('Synthetic access denied'),{code:'EACCES'}); };
  await assert.rejects(h.library.clearMissing(lists),/无法检查/); assert.deepEqual(await readFile(h.library.file),before);
  h.library.filePresent = exists; await unlink(join(folder,'sample.mp3')); lists.persist = async () => { throw new Error('Synthetic list failure'); };
  await assert.rejects(h.library.clearMissing(lists),/Synthetic list failure/); assert.deepEqual(await readFile(h.library.file),before);
});

test('a saved song whose index write failed is retained by cleanup and recovered on reopening', async t => {
  const h = await harness(t), first = await h.generate('first'); const { lists } = await listsFor(h,[first.id]);
  const persist = h.library.persist.bind(h.library); h.library.persist = async () => { throw new FamilySongError('FAMILY_DIRECTORY','Synthetic index failure'); };
  h.library.addSources([{id:'next',title:'Synthetic next',durationSec:3}]); const job = await h.library.request('next'); await assert.rejects(h.library.wait(job.id));
  h.library.persist = persist; assert.equal((await h.library.clearMissing(lists)).removed,0);
  const reopened = h.make(); await reopened.open(); assert.equal(reopened.status().entries.length,2); assert.equal(reopened.directories()[0].count,2); assert.ok(await reopened.get(job.id));
});

test('an index failure after physical deletion does not restore playlist references to the deleted song', async t => {
  const h = await harness(t), entry = await h.generate(); const { lists, list } = await listsFor(h,[entry.id]);
  h.library.persist = async () => { throw new FamilySongError('FAMILY_DIRECTORY','Synthetic index failure'); };
  await assert.rejects(lists.removeSong(entry.id,()=>h.library.remove(entry.id)),{code:'FAMILY_ENTRY_DELETE_INCOMPLETE'});
  assert.deepEqual(lists.get(list.id).ids,[]); assert.equal(h.library.status().entries.length,0); await assert.rejects(readFile(entry.absoluteFile),{code:'ENOENT'});
});

test('an external copy prevents implicit deletion of a primary file; cleanup preserves playable shared copies', async t => {
  const h = await harness(t), entry = await h.generate(), external = join(h.root,'external'); await cp(h.library.root,external,{recursive:true}); await h.library.add(external);
  const externalId = h.library.directories()[1].id, { lists, list } = await listsFor(h,[entry.id]);
  await assert.rejects(h.library.remove(entry.id,{directoryId:externalId}),/外部目录只读/);
  await assert.rejects(h.library.remove(entry.id),/先选择|请进入/);
  await unlink(entry.absoluteFile); await h.library.checkPaths(); assert.equal((await h.library.clearMissing(lists)).removed,0);
  assert.deepEqual(lists.get(list.id).ids,[entry.id]); assert.equal((await h.library.get(entry.id)).absoluteFile,join(external,entry.file));
});
