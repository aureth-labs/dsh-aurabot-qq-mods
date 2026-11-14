import test from 'node:test';
import assert from 'node:assert/strict';
import { MiNASpeaker } from '../lib/speaker/mina.mjs';
import { FAMILY_AUDIO_ID } from '../lib/speaker/transport.mjs';

function harness({ rejectLoop = false, ignoreLoop = false, foreignOnFailure = false, unreadable = false } = {}) {
  const calls = [];
  let url, loopType = 1;
  const speaker = new MiNASpeaker({ localAddress: '127.0.0.1', call: async (_scope, method, value) => {
    calls.push({ method, value });
    if (method === 'player_play_music') url = JSON.parse(JSON.parse(value).music).payload.audio_items[0].stream.url;
    if (method === 'player_set_loop') {
      if (rejectLoop) return { code: 10 };
      if (!ignoreLoop) loopType = value.type;
    }
    if (unreadable) return { code: 0 };
    return { code: 0, info: JSON.stringify({ status: 1, loop_type: loopType,
      play_song_detail: { audio_id: foreignOnFailure ? 'isolated-native-item' : FAMILY_AUDIO_ID, position: 0, duration: 18000 } }) };
  } });
  return { speaker, calls, url: () => url };
}

test('one owned audio load selects one-round device playback and multiple HTTP reads do not issue another play', async t => {
  const h = harness(); t.after(() => h.speaker.close());
  const result = await h.speaker.playProbe();
  assert.equal(result.loopType, 2);
  assert.equal(result.singlePlayVerified, true);
  assert.deepEqual(h.calls.filter(item => item.method === 'player_set_loop').map(item => item.value), [{ type: 2, media: 'common' }]);
  for (let i = 0; i < 3; i++) {
    const response = await fetch(h.url());
    assert.equal(response.status, 200); await response.arrayBuffer();
  }
  assert.equal(h.calls.filter(item => item.method === 'player_play_music').length, 1);
  assert.equal((await h.speaker.status()).audioRequests.matchedGet, 3);
});

test('rejected or unchanged repeat mode cannot report successful one-round playback', async t => {
  for (const options of [{ rejectLoop: true }, { ignoreLoop: true }]) {
    const h = harness(options); t.after(() => h.speaker.close());
    await assert.rejects(h.speaker.playProbe(), /单轮播放模式/);
    assert.equal(h.speaker.server, null);
    assert.equal(h.speaker.ownsPlayback, false);
    assert.equal(h.speaker.canResume, false);
    assert.deepEqual(h.calls.filter(item => item.method === 'player_play_operation').map(item => item.value), [{ action: 'pause' }]);
  }
});

test('failed owned playback releases its stream without pausing a confirmed foreign media selection', async t => {
  const h = harness({ rejectLoop: true, foreignOnFailure: true }); t.after(() => h.speaker.close());
  await assert.rejects(h.speaker.playProbe(), /单轮播放模式/);
  assert.equal(h.speaker.server, null);
  assert.equal(h.calls.some(item => item.method === 'player_play_operation'), false);
});

test('missing loop readback remains explicitly unverified rather than inventing confirmation', async t => {
  const h = harness({ unreadable: true }); t.after(() => h.speaker.close());
  const result = await h.speaker.playProbe();
  assert.equal(result.accepted, true);
  assert.equal(result.playback, 'unknown');
  assert.equal(result.loopType, null);
  assert.equal(result.singlePlayVerified, false);
});
