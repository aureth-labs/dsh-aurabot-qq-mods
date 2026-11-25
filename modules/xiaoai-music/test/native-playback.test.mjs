import test from 'node:test';
import assert from 'node:assert/strict';
import { FamilyPlayback } from '../lib/songs/playback.mjs';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function harness({ duration = 10 } = {}) {
  const actions = [];
  const timers = [];
  let now = 0;
  let reads = 0;
  let native = { playback: 'playing', position: 0, duration, itemOwned: true };
  const speaker = {
    ownsPlayback: false,
    playFile: async file => {
      actions.push(['file', file]);
      speaker.ownsPlayback = true;
      native = { playback: 'playing', position: 0, duration, itemOwned: true };
      return { startedAt: now };
    },
    operate: async action => { actions.push(['operate', action]); if (action === 'stop') speaker.ownsPlayback = false; },
    releasePlayback: async () => { actions.push(['release']); speaker.ownsPlayback = false; },
    status: async () => { reads++; return typeof native === 'function' ? native() : { ...native }; },
  };
  const player = new FamilyPlayback({
    library: { wait: async () => {}, get: async id => ({ id, absoluteFile: id + '.mp3', duration }) },
    getSpeaker: async () => speaker,
    now: () => now,
    schedule: (fn, delay) => { const timer = { fn, delay, cancelled: false }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
  });
  return {
    player, actions, timers, speaker,
    setTime: value => { now = value; }, setNative: value => { native = value; }, reads: () => reads,
    files: () => actions.filter(action => action[0] === 'file').map(action => action[1]),
    commands: () => actions.filter(action => action[0] === 'operate'),
    end: async () => { await timers.at(-1).fn(); await player.task; },
  };
}

test('native pause or stop before the end releases the round and an old timer cannot restart it', async () => {
  for (const playback of ['paused', 'stopped']) {
    const h = harness();
    await h.player.playlist(['a', 'b']);
    await h.player.task;
    const oldTimer = h.timers.at(-1);
    h.setTime(2000);
    h.setNative({ playback, position: 2, duration: 10, itemOwned: true });
    await h.player.syncNativePlayback();
    assert.equal(h.player.status().selected, null, playback);
    assert.equal(h.player.status().playlist, null, playback);
    assert.equal(h.speaker.ownsPlayback, false, playback);
    assert.equal(oldTimer.cancelled, true, playback);
    await oldTimer.fn();
    assert.deepEqual(h.files(), ['a.mp3'], playback);
    assert.deepEqual(h.commands(), [], playback);
    assert.equal(h.actions.filter(action => action[0] === 'release').length, 1, playback);
  }
});

test('switching to native music relinquishes ownership without pausing the newly selected media', async () => {
  const h = harness();
  await h.player.playlist(['a', 'b']);
  await h.player.task;
  const oldTimer = h.timers.at(-1);
  h.setTime(2000);
  h.setNative({ playback: 'playing', position: 10, duration: 10, itemOwned: false });
  await h.player.syncNativePlayback();
  await oldTimer.fn();
  await h.player.close();
  assert.equal(h.player.status().selected, null);
  assert.equal(h.player.status().playlist, null);
  assert.deepEqual(h.files(), ['a.mp3']);
  assert.deepEqual(h.commands(), []);
  assert.equal(h.actions.filter(action => action[0] === 'release').length, 1);
});

test('closing checks media ownership even before the next periodic synchronization', async () => {
  for (const itemOwned of [false, true]) {
    const h = harness();
    await h.player.playlist(['a', 'b']); await h.player.task;
    h.setNative({ playback: 'playing', position: 2, duration: 10, itemOwned });
    await h.player.close();
    assert.equal(h.player.status().playlist, null);
    assert.deepEqual(h.commands(), itemOwned ? [['operate', 'stop']] : []);
    assert.equal(h.player.status().phase, 'stopped');
  }
});

test('a naturally ended owned track can advance rather than being mistaken for a native interruption', async () => {
  for (const playback of ['paused', 'stopped']) {
    const h = harness();
    await h.player.playlist(['a', 'b']);
    await h.player.task;
    h.setTime(10500);
    h.setNative({ playback, position: 10, duration: 10, itemOwned: true });
    await h.player.syncNativePlayback();
    assert.equal(h.player.status().selected, 'a', playback);
    assert.equal(h.player.status().playlist.index, 0, playback);
    assert.equal(h.actions.filter(action => action[0] === 'release').length, 0, playback);
    await h.end();
    assert.deepEqual(h.files(), ['a.mp3', 'b.mp3'], playback);
    assert.equal(h.player.status().phase, 'playing', playback);
    assert.equal(h.player.status().playlist.index, 1, playback);
    await h.player.stop();
  }
});

test('a short reply waits for the speaker remaining duration instead of stopping at the first HTTP read deadline', async () => {
  const h = harness({ duration: 5.784 });
  await h.player.entry('reply'); await h.player.task;
  const initial = h.timers.at(-1);
  h.setTime(6284);
  h.setNative({ playback: 'playing', position: 1.416, duration: 5.784, itemOwned: true });
  await h.end();
  assert.equal(h.player.status().phase, 'playing');
  assert.deepEqual(h.commands(), []);
  assert.deepEqual(h.files(), ['reply.mp3']);
  const remaining = h.timers.at(-1);
  assert.notEqual(remaining, initial);
  assert.ok(Math.abs(remaining.delay - 4868) < 1);
  h.setTime(11152);
  h.setNative({ playback: 'paused', position: 0, duration: 5.784, itemOwned: true });
  await h.end();
  assert.equal(h.player.status().phase, 'completed');
  assert.deepEqual(h.files(), ['reply.mp3']);
  assert.deepEqual(h.commands(), [['operate', 'stop']]);
});

test('a playlist cannot switch while the speaker is still playing the unfinished owned item', async () => {
  const h = harness();
  await h.player.playlist(['a', 'b']); await h.player.task;
  h.setTime(10500);
  h.setNative({ playback: 'playing', position: 4, duration: 10, itemOwned: true });
  await h.end();
  assert.deepEqual(h.files(), ['a.mp3']);
  assert.equal(h.player.status().playlist.index, 0);
  h.setTime(17000);
  h.setNative({ playback: 'paused', position: 0, duration: 10, itemOwned: true });
  await h.end();
  assert.deepEqual(h.files(), ['a.mp3', 'b.mp3']);
  assert.equal(h.player.status().playlist.index, 1);
  await h.player.stop();
});

test('playing without readable progress cannot be treated as a completed track', async () => {
  const h = harness();
  await h.player.playlist(['a', 'b']); await h.player.task;
  h.setTime(10500);
  h.setNative({ playback: 'playing', position: null, duration: null, itemOwned: true });
  await h.end();
  assert.deepEqual(h.files(), ['a.mp3']);
  assert.equal(h.player.status().phase, 'stopped');
  assert.equal(h.player.status().error.code, 'FAMILY_PLAYBACK_STATE_UNKNOWN');
  assert.deepEqual(h.commands(), []);
});

test('a still-playing final syllable is not cut off by the natural-end tolerance', async () => {
  const h = harness({ duration: 5.784 });
  await h.player.entry('reply'); await h.player.task;
  h.setTime(6284);
  h.setNative({ playback: 'playing', position: 5.76, duration: 5.784, itemOwned: true });
  await h.end();
  assert.equal(h.player.status().phase, 'playing');
  assert.deepEqual(h.commands(), []);
  assert.ok(Math.abs(h.timers.at(-1).delay - 524) < 1);
  await h.player.stop();
});

test('an unreadable or failed native status at the transition cannot advance the playlist', async () => {
  for (const native of [
    { playback: 'unknown', position: null, duration: null, itemOwned: null },
    () => { throw new Error('isolated status read failure'); },
  ]) {
    const h = harness({ duration: 1 });
    await h.player.playlist(['a', 'b']);
    await h.player.task;
    const oldTimer = h.timers.at(-1);
    h.setTime(1500);
    h.setNative(native);
    await h.end();
    assert.equal(h.player.status().selected, null);
    assert.equal(h.player.status().playlist, null);
    assert.equal(h.speaker.ownsPlayback, false);
    assert.deepEqual(h.files(), ['a.mp3']);
    assert.deepEqual(h.commands(), []);
    await oldTimer.fn();
    assert.deepEqual(h.files(), ['a.mp3']);
  }
});

test('a full natural ending with reset position can advance even for a one-second track', async () => {
  const h = harness({ duration: 1 });
  await h.player.playlist(['a', 'b']);
  await h.player.task;
  h.setTime(1500);
  h.setNative({ playback: 'paused', position: 0, duration: 1, itemOwned: true });
  await h.player.syncNativePlayback({ beforeAdvance: true });
  assert.equal(h.player.status().selected, 'a');
  assert.equal(h.actions.filter(action => action[0] === 'release').length, 0);
  await h.end();
  assert.deepEqual(h.files(), ['a.mp3', 'b.mp3']);
  assert.equal(h.player.status().phase, 'playing');
  assert.equal(h.player.status().playlist.index, 1);
  await h.player.stop();
});

test('zero native position before the track has finished releases the remaining round', async () => {
  const h = harness();
  await h.player.playlist(['a', 'b']);
  await h.player.task;
  const oldTimer = h.timers.at(-1);
  h.setTime(5000);
  h.setNative({ playback: 'paused', position: 0, duration: 10, itemOwned: true });
  await h.player.syncNativePlayback();
  assert.equal(h.player.status().selected, null);
  assert.equal(h.player.status().playlist, null);
  await oldTimer.fn();
  assert.deepEqual(h.files(), ['a.mp3']);
  assert.deepEqual(h.commands(), []);
});

test('the first two seconds tolerate a stale paused state or previous media without skipping the status read', async () => {
  for (const stale of [
    { playback: 'paused', position: 0, duration: 10, itemOwned: true },
    { playback: 'playing', position: 7, duration: 20, itemOwned: false },
  ]) {
    const h = harness();
    await h.player.playlist(['a', 'b']);
    await h.player.task;
    h.setTime(1999);
    h.setNative(stale);
    await h.player.syncNativePlayback();
    assert.equal(h.reads(), 1);
    assert.equal(h.player.status().selected, 'a');
    assert.equal(h.player.status().phase, 'playing');
    assert.equal(h.actions.filter(action => action[0] === 'release').length, 0);
    h.setTime(2000);
    h.setNative({ playback: 'playing', position: 2, duration: 10, itemOwned: true });
    await h.player.syncNativePlayback();
    assert.equal(h.reads(), 2);
    assert.equal(h.player.status().selected, 'a');
    await h.player.stop();
  }
});

test('a late native read or read failure cannot cancel a newer explicit song request', async () => {
  for (const fail of [false, true]) {
    const h = harness();
    await h.player.playlist(['a', 'b']);
    await h.player.task;
    const started = deferred();
    const reading = deferred();
    h.setNative(() => { started.resolve(); return reading.promise; });
    const pending = h.player.syncNativePlayback({ beforeAdvance: true });
    await started.promise;
    await h.player.entry('new-song');
    await h.player.task;
    if (fail) reading.reject(new Error('isolated late failure'));
    else reading.resolve({ playback: 'paused', position: 2, duration: 10, itemOwned: true });
    await pending;
    assert.deepEqual(h.files(), ['a.mp3', 'new-song.mp3']);
    assert.equal(h.player.status().phase, 'playing');
    assert.equal(h.player.status().selected, 'new-song');
    assert.equal(h.speaker.ownsPlayback, true);
    assert.equal(h.actions.filter(action => action[0] === 'release').length, 0);
    await h.player.stop();
  }
});

test('native synchronization does not poll an idle player or undo a local pause', async () => {
  const h = harness();
  await h.player.syncNativePlayback();
  assert.equal(h.reads(), 0);
  await h.player.playlist(['a', 'b']);
  await h.player.task;
  await h.player.pause();
  await h.player.syncNativePlayback();
  assert.equal(h.reads(), 0);
  assert.equal(h.player.status().phase, 'paused');
  assert.equal(h.player.status().playlist.index, 0);
  await h.player.stop();
});
