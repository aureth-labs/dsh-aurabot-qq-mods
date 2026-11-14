import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { SpeakerProbe } from '../lib/speaker/probe.mjs';
import { FamilyPlayback } from '../lib/songs/playback.mjs';
import { MiNASpeaker } from '../lib/speaker/mina.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness(prepareAnswer) {
  let now = 1000;
  let records = [];
  const actions = [];
  const speaker = { conversations: async () => [], conversationsSince: async () => records,
    operate: async action => actions.push(action), close: async () => {} };
  const probe = new SpeakerProbe({ speaker, cursor: { state: { since: 1000 }, begin: async () => {}, claim: async () => true },
    ask: async text => text, prepareAnswer, now: () => now,
    playAnswer: async value => { actions.push(value.file); return { accepted: true }; },
  });
  return { probe, actions, setTime: value => { now = value; }, setRecords: value => { records = value; } };
}

test('a new native pause cancels a pending reply while an older pause cannot cancel a later question', async () => {
  const started = deferred(), ready = deferred();
  let cleaned = 0;
  const h = harness(async () => { started.resolve(); return ready.promise; });
  await h.probe.arm(); h.setTime(2000);
  const answer = h.probe.act('ask-test', 'Synthetic question');
  await started.promise;
  h.setRecords([{ time: 1100, query: '暂停', requestId: 'old-native-pause' }]);
  await h.probe.poll();
  assert.equal(h.probe.status().handled, 0);
  h.setTime(3000);
  h.setRecords([{ time: 2300, query: '小爱同学，暂停', requestId: 'new-native-pause' }]);
  await h.probe.poll();
  ready.resolve({ file: 'synthetic.wav', cleanup: async () => cleaned++ });
  assert.equal((await answer).cancelled, true);
  assert.equal(cleaned, 1);
  assert.deepEqual(h.actions, []);
  assert.equal(h.probe.status().lastAction, 'cancel-answer');
});

test('stop completes while dialogue synthesis is pending and its late audio is cleaned without playback', async () => {
  const started = deferred(), ready = deferred();
  let cleaned = 0;
  const h = harness(async () => { started.resolve(); return ready.promise; });
  await h.probe.arm();
  const answer = h.probe.act('ask-test', 'Synthetic question');
  await started.promise;
  await h.probe.act('stop');
  assert.deepEqual(h.actions, ['stop']);
  ready.resolve({ file: 'synthetic.wav', cleanup: async () => cleaned++ });
  assert.equal((await answer).cancelled, true);
  assert.equal(cleaned, 1);
  assert.deepEqual(h.actions, ['stop']);
});

test('a newer question prevents an older synthesized answer from taking over', async () => {
  const started = deferred(), ready = deferred();
  const cleaned = [];
  const h = harness(async text => {
    if (text === 'old') { started.resolve(); return ready.promise; }
    return { file: text + '.mp3', cleanup: async () => cleaned.push(text) };
  });
  await h.probe.arm();
  const old = h.probe.act('ask-test', 'old');
  await started.promise;
  await h.probe.act('ask-test', 'new');
  ready.resolve({ file: 'old.wav', cleanup: async () => cleaned.push('old') });
  assert.equal((await old).cancelled, true);
  assert.deepEqual(h.actions, ['new.mp3']);
  assert.deepEqual(cleaned, ['new', 'old']);
});

test('window expiry after synthesis prevents audio playback and still releases its files', async () => {
  const started = deferred(), ready = deferred();
  let cleaned = false;
  const h = harness(async () => { started.resolve(); return ready.promise; });
  await h.probe.arm();
  const answer = h.probe.act('ask-test', 'Synthetic question');
  await started.promise;
  h.setTime(602000);
  ready.resolve({ file: 'synthetic.ogg', cleanup: async () => { cleaned = true; } });
  assert.equal((await answer).cancelled, true);
  assert.equal(cleaned, true);
  assert.deepEqual(h.actions, []);
});

test('a temporary dialogue leaves the song playlist and completes once without entering the song library', async () => {
  const actions = [], timers = [];
  const speaker = { playFile: async file => actions.push(file), operate: async action => actions.push(action) };
  const library = { wait: async id => { assert.equal(id, 'song'); },
    get: async id => ({ id, absoluteFile: 'song.mp3', duration: 20 }) };
  const player = new FamilyPlayback({ library, getSpeaker: async () => speaker,
    schedule: fn => { const timer = { fn }; timers.push(timer); return timer; }, cancel: () => {}, now: () => 0 });
  await player.playlist(['song', 'another']); await player.task;
  const oldTimer = timers.at(-1);
  await player.audio({ id: 'sister-dialogue', absoluteFile: 'sister.wav', duration: 3 }); await player.task;
  assert.equal(player.status().playlist, null);
  await oldTimer.fn();
  assert.deepEqual(actions, ['song.mp3', 'stop', 'sister.wav']);
  await timers.at(-1).fn();
  assert.equal(player.status().phase, 'completed');
  assert.deepEqual(actions, ['song.mp3', 'stop', 'sister.wav', 'stop']);
});

test('dialogue cancelled while the device is being prepared cannot start its late file', async () => {
  const requested = deferred(), device = deferred();
  const actions = [];
  let current = true;
  const player = new FamilyPlayback({ library: {}, getSpeaker: async () => { requested.resolve(); return device.promise; } });
  await player.audio({ id: 'sister-dialogue', absoluteFile: 'synthetic-old.wav', duration: 3 }, { isCurrent: () => current });
  await requested.promise;
  current = false;
  device.resolve({ playFile: async file => actions.push(file), releasePlayback() {} });
  await player.task;
  assert.deepEqual(actions, []);
  assert.equal(player.status().phase, 'stopped');
});

test('dialogue cancelled during an in-flight device play is followed by stop without an end timer', async () => {
  const started = deferred(), played = deferred();
  const actions = [];
  let current = true;
  const player = new FamilyPlayback({ library: {}, getSpeaker: async () => ({
    playFile: async file => { actions.push(file); started.resolve(); await played.promise; },
    operate: async action => actions.push(action), releasePlayback() {},
  }), schedule: () => { throw new Error('Cancelled dialogue must not schedule an end'); } });
  await player.audio({ id: 'sister-dialogue', absoluteFile: 'synthetic-old.wav', duration: 3 }, { isCurrent: () => current });
  await started.promise;
  current = false;
  played.resolve();
  await player.task;
  assert.deepEqual(actions, ['synthetic-old.wav', 'stop']);
  assert.equal(player.status().phase, 'stopped');
});

test('dialogue WAV and Ogg files retain their content type and full bytes on the speaker stream', async t => {
  const root = await mkdtemp(join(tmpdir(), 'family-dialogue-playback-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('family-dialogue-playback-'));
    await rm(root, { recursive: true, force: true });
  });
  for (const [extension, type] of [['wav', 'audio/wav'], ['ogg', 'audio/ogg']]) {
    const bytes = Buffer.from('synthetic-' + extension);
    const file = join(root, 'synthetic.' + extension);
    await writeFile(file, bytes);
    const speaker = new MiNASpeaker({ localAddress: '127.0.0.1', call: async (_, method, payload) => {
      if (method === 'player_play_music') {
        const url = JSON.parse(JSON.parse(payload).music).payload.audio_items[0].stream.url;
        assert.equal(new URL(url).hostname, '127.0.0.1');
        const response = await fetch(url);
        assert.equal(response.headers.get('content-type'), type);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      }
      return { code: 0, info: { status: 1 } };
    } });
    try { await speaker.playFile(file, 1); } finally { await speaker.close(); }
  }
});
