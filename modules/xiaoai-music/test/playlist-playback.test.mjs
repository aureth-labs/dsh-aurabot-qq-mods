import test from 'node:test';
import assert from 'node:assert/strict';
import { FamilyPlayback } from '../lib/songs/playback.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function harness(options = {}) {
  const actions = [];
  const timers = [];
  let now = 0;
  const speaker = {
    ownsPlayback: false,
    say: async text => { actions.push(['say', text]); speaker.ownsPlayback = true; },
    playFile: async file => {
      actions.push(['file', file]);
      speaker.ownsPlayback = true;
      await options.play?.(file);
      return { startedAt: now };
    },
    operate: async action => { actions.push([action]); if (action === 'stop') speaker.ownsPlayback = false; },
  };
  const player = new FamilyPlayback({
    library: {
      request: async () => ({ id: 'solo', state: 'ready', reused: true }),
      wait: async id => { await options.ready?.(id); },
      get: async id => {
        await options.get?.(id);
        return { id, absoluteFile: id + '.mp3', duration: 10 };
      },
    },
    getSpeaker: async () => speaker,
    now: () => now,
    schedule: (fn, delay) => {
      const timer = { fn, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: timer => { timer.cancelled = true; },
    wait: async () => {},
    random: () => 0,
  });
  return { player, actions, timers, setTime: value => { now = value; },
    end: async () => { await timers.at(-1).fn(); },
    files: () => actions.filter(action => action[0] === 'file').map(action => action[1]) };
}

test('a sequential playlist plays each saved song for one round and announces only its start', async () => {
  const h = harness();
  await h.player.playlist(['a', 'b', 'c'], { announce: true });
  await h.player.task;
  assert.deepEqual(h.player.status().playlist, { ids: ['a', 'b', 'c'], mode: 'sequential', index: 0, total: 3 });
  await h.end();
  assert.equal(h.player.status().playlist.index, 1);
  await h.end();
  assert.equal(h.player.status().playlist.index, 2);
  await h.end();
  assert.deepEqual(h.files(), ['a.mp3', 'b.mp3', 'c.mp3']);
  assert.equal(h.actions.filter(action => action[0] === 'say').length, 1);
  assert.equal(h.actions.filter(action => action[0] === 'stop').length, 3);
  assert.equal(h.player.status().phase, 'completed');
  assert.equal(h.player.status().playlist, null);
  assert.equal(h.player.status().selected, null);
  for (const timer of h.timers) await timer.fn();
  assert.deepEqual(h.files(), ['a.mp3', 'b.mp3', 'c.mp3']);
});

test('random playback shuffles a copy and never repeats a song within its round', async () => {
  const h = harness();
  const ids = ['a', 'b', 'c', 'a'];
  await h.player.playlist(ids, { mode: 'random' });
  await h.player.task;
  const snapshot = h.player.status();
  assert.deepEqual(snapshot.playlist.ids, ['b', 'c', 'a']);
  snapshot.playlist.ids.push('not-a-real-selection');
  assert.equal(h.player.status().playlist.total, 3);
  assert.deepEqual(ids, ['a', 'b', 'c', 'a']);
  await h.end();
  await h.end();
  await h.end();
  assert.deepEqual(h.files(), ['b.mp3', 'c.mp3', 'a.mp3']);
  assert.equal(h.player.status().phase, 'completed');
});

test('pause and resume retain playlist position and next cancels the old song timer', async () => {
  const h = harness();
  await h.player.playlist(['a', 'b']);
  await h.player.task;
  h.setTime(4000);
  await h.player.pause();
  assert.equal(h.timers[0].cancelled, true);
  assert.equal(h.player.status().playlist.index, 0);
  h.setTime(9000);
  await h.player.resume();
  assert.equal(h.timers.at(-1).delay, 6500);
  const oldTimer = h.timers.at(-1);
  await h.player.next();
  await h.player.task;
  assert.equal(oldTimer.cancelled, true);
  assert.equal(h.player.status().playlist.index, 1);
  await oldTimer.fn();
  assert.equal(h.player.status().phase, 'playing');
  assert.deepEqual(h.files(), ['a.mp3', 'b.mp3']);
  await h.player.next();
  assert.equal(h.player.status().phase, 'completed');
  await assert.rejects(h.player.resume(), { code: 'FAMILY_NOT_PAUSED' });
});

test('skipping a song still being prepared cannot play its late result', async () => {
  const first = deferred();
  const h = harness({ ready: id => id === 'a' ? first.promise : undefined });
  await h.player.playlist(['a', 'b']);
  const oldTask = h.player.task;
  await h.player.next();
  await h.player.task;
  first.resolve();
  await oldTask;
  assert.deepEqual(h.files(), ['b.mp3']);
  assert.equal(h.player.status().playlist.index, 1);
  await h.player.stop();
});

test('stopping during playlist preparation cancels all later playback', async () => {
  const prepared = deferred();
  const h = harness({ ready: () => prepared.promise });
  await h.player.playlist(['a', 'b']);
  const oldTask = h.player.task;
  await h.player.stop();
  prepared.resolve();
  await oldTask;
  assert.deepEqual(h.actions, []);
  assert.equal(h.player.status().phase, 'stopped');
  assert.equal(h.player.status().playlist, null);
  await assert.rejects(h.player.next(), { code: 'FAMILY_NO_PLAYLIST' });
});

test('stop follows an in-flight list play and cancels a queued next song', async () => {
  const playing = deferred();
  const release = deferred();
  const h = harness({ play: async file => {
    if (file === 'a.mp3') { playing.resolve(); await release.promise; }
  } });
  await h.player.playlist(['a', 'b', 'c']);
  await playing.promise;
  const next = h.player.next();
  const stopped = h.player.stop();
  release.resolve();
  await next;
  await stopped;
  await h.player.task;
  assert.deepEqual(h.actions, [['file', 'a.mp3'], ['stop']]);
  assert.equal(h.player.status().phase, 'stopped');
  assert.equal(h.player.status().playlist, null);
});

test('pausing while a list song is prepared can resume that same list position', async () => {
  const prepared = deferred();
  const h = harness({ ready: id => id === 'a' ? prepared.promise : undefined });
  await h.player.playlist(['a', 'b']);
  const pausedTask = h.player.task;
  await h.player.pause();
  assert.equal(h.player.status().phase, 'paused');
  await h.player.resume();
  prepared.resolve();
  await pausedTask;
  await h.player.task;
  assert.deepEqual(h.files(), ['a.mp3']);
  assert.equal(h.player.status().playlist.index, 0);
  await h.end();
  assert.deepEqual(h.files(), ['a.mp3', 'b.mp3']);
  await h.player.stop();
});

test('an explicit single song leaves its previous playlist instead of continuing it', async () => {
  for (const select of [player => player.entry('solo'), player => player.source('solo-source')]) {
    const h = harness();
    await h.player.playlist(['a', 'b']);
    await h.player.task;
    const oldTimer = h.timers.at(-1);
    await select(h.player);
    await h.player.task;
    assert.equal(h.player.status().playlist, null);
    await oldTimer.fn();
    await h.end();
    assert.deepEqual(h.files(), ['a.mp3', 'solo.mp3']);
    assert.equal(h.player.status().phase, 'completed');
  }
});

test('a failed list item reports failure and does not silently skip to another song', async () => {
  const h = harness({ get: id => { if (id === 'b') throw new Error('synthetic-private-detail'); } });
  await h.player.playlist(['a', 'b', 'c']);
  await h.player.task;
  await h.end();
  assert.equal(h.player.status().phase, 'failed');
  assert.equal(h.player.status().playlist.index, 1);
  assert.deepEqual(h.files(), ['a.mp3']);
  assert.equal(JSON.stringify(h.player.status()).includes('synthetic-private-detail'), false);
  await h.player.stop();
});

test('invalid playlist requests leave an existing playback alone', async () => {
  const h = harness();
  await h.player.playlist(['a', 'b']);
  await h.player.task;
  const previous = h.player.status();
  await assert.rejects(h.player.playlist([]), { code: 'FAMILY_PLAYLIST_EMPTY' });
  await assert.rejects(h.player.playlist(['a'], { mode: 'repeat' }), { code: 'FAMILY_PLAYLIST_MODE' });
  assert.deepEqual(h.player.status(), previous);
  await h.player.stop();
});
