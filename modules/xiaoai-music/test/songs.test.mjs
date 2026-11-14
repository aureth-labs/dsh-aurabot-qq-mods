import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SongLibrary } from '../lib/songs/library.mjs';
import { FamilyPlayback } from '../lib/songs/playback.mjs';
import { MiNASpeaker } from '../lib/speaker/mina.mjs';
import { audioFileName } from '../lib/songs/storage.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));

async function libraryHarness(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'family-song-isolated-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let renders = 0;
  let digest = 'synthetic-model-version-1';
  const describe = async (source, pitch) => ({
    identity: { version: 'synthetic-full-v1', source: { id: source.id }, voice: { role: 'mother', digest }, parameters: { pitch } },
    render: async (work, stage) => {
      renders++;
      stage(() => 'isolated-render');
      await options.wait?.();
      if (options.fail) throw new Error('synthetic-private-path-and-token');
      const source = join(work, 'source.mp3');
      const file = join(work, 'full.mp3');
      await writeFile(source, 'isolated full source');
      await writeFile(file, 'isolated full converted audio');
      return { source, file, sourceDuration: options.sourceShort ? 30 : 180,
        duration: options.sourceShort ? 30.1 : options.short ? 20 : 180.1 };
    },
  });
  const create = () => new SongLibrary({ root: join(directory, 'library'), workRoot: join(directory, 'work'), describe });
  const library = create();
  await library.open();
  library.addSources([{ id: 'synthetic-source', title: '隔离儿歌', artists: '隔离歌手', durationSec: 180 }]);
  return { library, create, renders: () => renders, setDigest: value => { digest = value; } };
}

test('full songs persist and reuse after reopening, with voice and parameter changes isolated', async t => {
  const h = await libraryHarness(t);
  const job = await h.library.request('synthetic-source', { pitch: 0 });
  const entry = await h.library.wait(job.id);
  assert.equal(entry.full, true);
  assert.equal(entry.schema, 2);
  assert.match(entry.file, /隔离儿歌.*隔离歌手.*妈妈版.*\.mp3$/);
  assert.equal((await h.library.get(job.id)).absoluteFile, join(h.library.root, entry.file));
  assert.equal(h.renders(), 1);
  const reopened = h.create();
  await reopened.open();
  const reused = await reopened.request('synthetic-source', { pitch: 0 });
  assert.equal(reused.reused, true);
  assert.equal(reused.id, job.id);
  assert.equal(h.renders(), 1);
  const changedPitch = await reopened.request('synthetic-source', { pitch: 1 });
  await reopened.wait(changedPitch.id);
  assert.notEqual(changedPitch.id, job.id);
  h.setDigest('synthetic-model-version-2');
  const changedVoice = await reopened.request('synthetic-source', { pitch: 0 });
  await reopened.wait(changedVoice.id);
  assert.notEqual(changedVoice.id, job.id);
  assert.equal(h.renders(), 3);
});

test('repeated requests during full generation share one render', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = await libraryHarness(t, { wait: () => pending });
  const first = await h.library.request('synthetic-source');
  const second = await h.library.request('synthetic-source');
  assert.equal(first.id, second.id);
  assert.equal(second.reused, true);
  release();
  await h.library.wait(first.id);
  assert.equal(h.renders(), 1);
});

test('short output and conversion failures cannot become full mother entries', async t => {
  for (const option of [{ short: true }, { sourceShort: true }, { fail: true }]) {
    const h = await libraryHarness(t, option);
    const job = await h.library.request('synthetic-source');
    await assert.rejects(h.library.wait(job.id));
    assert.equal(h.library.status().entries.length, 0);
    assert.equal(h.library.status().jobs[0].state, 'failed');
    assert.equal(JSON.stringify(h.library.status()).includes('synthetic-private'), false);
  }
});

test('changed cached audio is rejected without overwriting it', async t => {
  const h = await libraryHarness(t);
  const job = await h.library.request('synthetic-source');
  await h.library.wait(job.id);
  const entry = await h.library.get(job.id);
  await writeFile(entry.absoluteFile, 'isolated changed content');
  await assert.rejects(h.library.request('synthetic-source'), { code: 'FAMILY_CACHE_INVALID' });
  assert.equal(await readFile(entry.absoluteFile, 'utf8'), 'isolated changed content');
  assert.equal(h.renders(), 1);
});

test('legacy hashed song folders remain readable with the same cached identity', async t => {
  const h = await libraryHarness(t);
  const job = await h.library.request('synthetic-source');
  await h.library.wait(job.id);
  const entry = await h.library.get(job.id);
  const { absoluteFile, ...metadata } = entry;
  const legacy = join(h.library.root, entry.id);
  await mkdir(legacy);
  await writeFile(join(legacy, 'audio.mp3'), await readFile(absoluteFile));
  await writeFile(join(legacy, 'manifest.json'), JSON.stringify({ ...metadata, schema: 1, file: 'audio.mp3' }));
  await unlink(absoluteFile);
  await unlink(join(h.library.metadataRoot, entry.id + '.json'));
  const reopened = h.create();
  await reopened.open();
  assert.equal((await reopened.get(entry.id)).absoluteFile, join(legacy, 'audio.mp3'));
  assert.equal((await reopened.request('synthetic-source')).reused, true);
  assert.equal(h.renders(), 1);
});

test('publishing a named song cannot overwrite an unrelated existing file', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const h = await libraryHarness(t, { wait: () => wait });
  const job = await h.library.request('synthetic-source');
  const file = join(h.library.root, audioFileName({ id: job.id,
    source: { id: 'synthetic-source', title: '隔离儿歌', artists: '隔离歌手' }, identity: { parameters: { pitch: 0 } } }));
  await writeFile(file, 'synthetic existing file');
  release();
  await assert.rejects(h.library.wait(job.id), { code: 'FAMILY_FILE_EXISTS' });
  assert.equal(await readFile(file, 'utf8'), 'synthetic existing file');
  assert.equal(h.library.status().entries.length, 0);
});

test('named song metadata cannot point outside its song directory', async t => {
  const h = await libraryHarness(t);
  const job = await h.library.request('synthetic-source');
  await h.library.wait(job.id);
  const { absoluteFile, ...entry } = await h.library.get(job.id);
  await writeFile(join(h.library.metadataRoot, entry.id + '.json'), JSON.stringify({ ...entry, file: '../outside.mp3' }));
  await assert.rejects(h.library.get(job.id), { code: 'FAMILY_CACHE_INVALID' });
  assert.equal(await readFile(absoluteFile, 'utf8'), 'isolated full converted audio');
});

test('stopping during generation retains the completed song without connecting or playing', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = await libraryHarness(t, { wait: () => pending });
  let connections = 0;
  const player = new FamilyPlayback({ library: h.library, getSpeaker: async () => { connections++; throw new Error(); } });
  const job = await player.source('synthetic-source');
  await player.stop();
  release();
  await h.library.wait(job.id);
  await player.task;
  assert.equal(h.library.status().entries.length, 1);
  assert.equal(connections, 0);
  assert.equal(player.status().phase, 'stopped');
});

test('stop follows an in-flight file play and never resumes that entry', async t => {
  const h = await libraryHarness(t);
  const job = await h.library.request('synthetic-source');
  await h.library.wait(job.id);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const actions = [];
  let started;
  const didStart = new Promise(resolve => { started = resolve; });
  const player = new FamilyPlayback({ library: h.library, getSpeaker: async () => ({
    playFile: async () => { actions.push('play-start'); started(); await pending; actions.push('play-end'); },
    operate: async action => { actions.push(action); },
  }) });
  await player.entry(job.id);
  await Promise.race([didStart, player.task]);
  assert.deepEqual(actions, ['play-start']);
  const stopped = player.stop();
  release();
  await stopped;
  await player.task;
  assert.deepEqual(actions, ['play-start', 'play-end', 'stop']);
  await assert.rejects(player.resume(), { code: 'FAMILY_NOT_PAUSED' });
});

test('one full song finishes once, and pause time does not consume the remaining audio', async () => {
  let now = 0;
  const timers = [];
  const actions = [];
  const player = new FamilyPlayback({
    library: { wait: async () => ({}), get: async id => ({ id, absoluteFile: 'isolated.mp3', duration: 10 }) },
    getSpeaker: async () => ({ playFile: async () => { actions.push('file'); return { startedAt: now }; },
      operate: async action => { actions.push(action); } }),
    now: () => now,
    schedule: (fn, delay) => { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
  });
  await player.entry('synthetic-entry');
  await player.task;
  assert.equal(timers[0].delay, 10500);
  now = 4000;
  await player.pause();
  assert.equal(timers[0].cancelled, true);
  now = 8000;
  await player.resume();
  assert.equal(timers[1].delay, 6500);
  now = 14500;
  await timers[1].fn();
  assert.equal(player.status().phase, 'completed');
  assert.deepEqual(actions, ['file', 'pause', 'play', 'stop']);
  await timers[0].fn();
  assert.deepEqual(actions, ['file', 'pause', 'play', 'stop']);
});

test('saved MP3 delivery observes the speaker read and preserves full bytes and media type', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'family-mp3-isolated-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'isolated.mp3');
  const bytes = Buffer.from('isolated entire mp3 transport payload');
  await writeFile(file, bytes);
  let received;
  let receiveError;
  const delivery = new Promise((resolve, reject) => { received = resolve; receiveError = reject; });
  const speaker = new MiNASpeaker({ localAddress: '127.0.0.1', call: async (scope, method, message) => {
    if (method === 'player_play_music') {
      const url = JSON.parse(JSON.parse(message).music).payload.audio_items[0].stream.url;
      void fetch(url).then(async response => received({ type: response.headers.get('content-type'), bytes: Buffer.from(await response.arrayBuffer()) })).catch(receiveError);
    }
    return { code: 0, info: JSON.stringify({ status: 1 }) };
  } });
  t.after(() => speaker.close());
  const result = await speaker.playFile(file, 10);
  assert.equal(Number.isFinite(result.startedAt), true);
  const actual = await delivery;
  assert.equal(actual.type, 'audio/mpeg');
  assert.deepEqual(actual.bytes, bytes);
});

test('stop during the spoken acknowledgement cancels the later song and stops owned speech', async () => {
  const actions = [];
  let release;
  let announced;
  const wait = new Promise(resolve => { release = resolve; });
  const didAnnounce = new Promise(resolve => { announced = resolve; });
  const speaker = {
    ownsPlayback: false,
    say: async text => { actions.push(text); speaker.ownsPlayback = true; announced(); },
    playFile: async () => { actions.push('file'); },
    operate: async action => { actions.push(action); speaker.ownsPlayback = false; },
  };
  const player = new FamilyPlayback({
    library: { request: async () => ({ id: 'synthetic', state: 'ready', reused: true }), wait: async () => ({}),
      get: async () => ({ id: 'synthetic', absoluteFile: 'isolated.mp3', duration: 10 }) },
    getSpeaker: async () => speaker, wait: () => wait,
  });
  await player.source('synthetic-source', { pitch: 0, announce: true });
  await didAnnounce;
  const stopped = player.stop();
  release();
  await stopped;
  await player.task;
  assert.deepEqual(actions, ['收到，准备播放。', 'stop']);
  assert.equal(player.status().phase, 'stopped');
});
