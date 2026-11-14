import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { SpeakerProbe, parseProbeCommand } from '../lib/speaker/probe.mjs';
import { VoiceCursor, recordKey } from '../lib/speaker/cursor.mjs';

const record = (time, requestId, query = '小伴，陪我说两句。') => ({ time, requestId, query });
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function harness(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'family-resident-isolated-'));
  const cursor = new VoiceCursor(join(directory, 'cursor.json'));
  await cursor.open();
  let now = 100000;
  let records = [];
  let historyReads = 0;
  const requestedSince = [], actions = [], questions = [];
  const speaker = {
    conversations: async () => { historyReads++; return []; },
    conversationsSince: async since => { requestedSince.push(since); return records; },
    operate: async action => { actions.push(action); },
    say: async text => { actions.push('say:' + text); },
    close: async () => { actions.push('close'); },
    ...options.speaker,
  };
  const probe = new SpeakerProbe({ speaker, cursor, now: () => now, sessionRouting: true,
    ask: async (text, context) => { questions.push({ text, context }); return '隔离回答。'; }, ...options.probe });
  t.after(async () => {
    await probe.close({ keepPlayback: true });
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('family-resident-isolated-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { probe, cursor, speaker, actions, questions, requestedSince, historyReads: () => historyReads,
    setTime: value => { now = value; }, setRecords: value => { records = value; } };
}

test('resident mode stays active beyond ten minutes, is idempotent and switches back to a timed window', async t => {
  let invalidated = 0;
  const h = await harness(t, { probe: { onInvalidate: () => { invalidated++; } } });
  await h.probe.arm({ persistent: true });
  assert.equal(h.probe.status().persistent, true);
  assert.equal(h.probe.status().remainingSeconds, null);
  h.setTime(100000 + 86400000);
  assert.equal(h.probe.active(), true);
  await h.probe.arm({ persistent: true });
  assert.equal(h.historyReads(), 1);
  assert.equal(invalidated, 1);
  await h.probe.arm();
  assert.equal(h.historyReads(), 2);
  assert.equal(invalidated, 2);
  assert.equal(h.probe.status().persistent, false);
  assert.equal(h.probe.status().remainingSeconds, 600);
  h.setTime(100000 + 86400000 + 600001);
  assert.equal(h.probe.active(), false);
  await h.probe.close({ keepPlayback: true });
  assert.equal(h.probe.status().persistent, false);
  assert.equal(h.probe.active(), false);
});

test('a history read from an earlier mode cannot execute after the listener is rearmed', async t => {
  const started = deferred(), history = deferred();
  const h = await harness(t, { speaker: { conversationsSince: async () => { started.resolve(); return history.promise; } } });
  await h.probe.arm({ persistent: true });
  const polling = h.probe.poll();
  await started.promise;
  await h.probe.arm({ persistent: false });
  history.resolve([record(100001, 'late-prior-mode')]);
  await polling; await settle();
  assert.equal(h.probe.status().handled, 0);
  assert.deepEqual(h.questions, []);
  assert.deepEqual(h.cursor.state.claimed, []);
});

test('cursor serializes concurrent claims and retains same-time and overlap boundaries across reopen', async t => {
  const h = await harness(t);
  await h.cursor.begin(100000);
  const first = record(100001, 'first'), sameTime = record(100001, 'same-time');
  assert.deepEqual(await Promise.all([h.cursor.claim(first), h.cursor.claim(sameTime), h.cursor.claim(first)]), [true, true, false]);
  const boundary = record(140000, 'boundary'), recent = record(190000, 'recent');
  await h.cursor.claim(boundary); await h.cursor.claim(recent);
  await h.cursor.advance(200000, { overlapMs: 60000 });
  assert.equal(h.cursor.state.since, 140000);
  assert.equal(h.cursor.state.claimed.length, 2);
  assert.equal(Object.keys(h.cursor.state.claimedAt).length, 2);
  assert.equal(await h.cursor.claim(record(139999, 'too-old')), false);
  assert.equal(await h.cursor.claim(boundary), false);
  assert.equal(await h.cursor.claim(record(140000, 'same-boundary-time')), true);
  const reopened = new VoiceCursor(h.cursor.file); await reopened.open();
  assert.equal(await reopened.claim(boundary), false);
  const stored = await readFile(h.cursor.file, 'utf8');
  assert.equal(stored.includes('陪我'), false);
  assert.equal(stored.includes('boundary'), false);
});

test('legacy string claims survive an advance without a timestamp and are reset only on explicit begin', async t => {
  const h = await harness(t);
  const legacy = record(190000, 'legacy');
  await writeFile(h.cursor.file, JSON.stringify({ since: 100000, claimed: [recordKey(legacy)] }));
  await h.cursor.open();
  await h.cursor.advance(200000);
  assert.equal(await h.cursor.claim(legacy), false);
  assert.equal(h.cursor.state.claimed.length, 1);
  await h.cursor.begin(210000);
  assert.equal(h.cursor.state.claimed.length, 0);
  assert.equal(await h.cursor.claim(legacy), false);
});

test('successful polling advances the frontier while repeated, same-time and delayed overlap requests stay once', async t => {
  const h = await harness(t);
  await h.probe.arm({ persistent: true });
  h.setTime(200000);
  const first = record(150000, 'first'), second = record(190000, 'second');
  h.setRecords([first, second, record(195000, 'unrelated', '今天吃什么？')]);
  await h.probe.poll(); await settle(); await h.probe.pending;
  assert.equal(h.cursor.state.since, 140000);
  h.setTime(201000);
  h.setRecords([first, second, record(160000, 'delayed'), record(190000, 'same-time')]);
  await h.probe.poll(); await settle(); await h.probe.pending;
  assert.deepEqual(h.requestedSince, [100000, 140000]);
  assert.equal(h.probe.status().handled, 4);
  assert.equal(h.probe.status().duplicates, 2);
  assert.equal(h.questions.length, 4);
  assert.equal(h.cursor.state.since, 141000);
});

test('a history failure cannot advance the resident cursor or expose upstream content', async t => {
  const h = await harness(t, { speaker: { conversationsSince: async () => { throw new Error('synthetic-private-body'); } } });
  await h.probe.arm({ persistent: true });
  h.setTime(200000); await h.probe.poll();
  assert.equal(h.cursor.state.since, 100000);
  assert.deepEqual(h.cursor.state.claimed, []);
  assert.equal(h.probe.status().historyFailures, 1);
  assert.equal(JSON.stringify(h.probe.status()).includes('synthetic-private'), false);
  assert.deepEqual(h.questions, []);
});

test('a failed claim never routes its request and a failed advance cannot retry an already claimed request', async t => {
  const h = await harness(t);
  await h.probe.arm({ persistent: true }); h.setTime(200000);
  h.setRecords([record(190000, 'claim-failure')]);
  const save = h.cursor.save.bind(h.cursor);
  h.cursor.save = async () => { throw new Error('synthetic-private-path'); };
  await h.probe.poll();
  assert.equal(h.probe.status().handled, 0);
  assert.deepEqual(h.questions, []);
  assert.equal(h.cursor.state.since, 100000);
  h.cursor.save = save;
  h.cursor.advance = async () => { throw new Error('synthetic-private-path'); };
  await h.probe.poll(); await settle(); await h.probe.pending;
  assert.equal(h.probe.status().handled, 1);
  await h.probe.poll(); await settle();
  assert.equal(h.probe.status().handled, 1);
  assert.equal(h.questions.length, 1);
  assert.equal(h.cursor.state.since, 100000);
  assert.match(h.probe.status().lastError, /推进失败/);
  assert.equal(h.probe.status().historyFailures, 0);
  assert.equal(JSON.stringify(h.probe.status()).includes('synthetic-private'), false);
});

test('reloading the resident listener begins at now and never replays stopped-period records', async t => {
  const h = await harness(t);
  await h.probe.arm({ persistent: true });
  h.setRecords([record(100001, 'already-handled')]);
  await h.probe.poll(); await settle(); await h.probe.pending;
  await h.probe.close({ keepPlayback: true });
  const reopened = new VoiceCursor(h.cursor.file); await reopened.open();
  const questions = [];
  const reloaded = new SpeakerProbe({ speaker: h.speaker, cursor: reopened, sessionRouting: true,
    now: () => 200000, ask: async text => { questions.push(text); return '新回答。'; } });
  t.after(() => reloaded.close({ keepPlayback: true }));
  await reloaded.arm({ persistent: true });
  h.setRecords([record(100001, 'already-handled'), record(150000, 'while-stopped'), record(200001, 'new')]);
  await reloaded.poll(); await settle(); await reloaded.pending;
  assert.equal(reloaded.status().handled, 1);
  assert.equal(questions.length, 1);
});

test('session routing preserves request punctuation and acknowledges bare invocation while retaining pause and stop', () => {
  const options = { sessionRouting: true };
  assert.deepEqual(parseProbeCommand('小爱同学，小 伴：播放《小星星》，然后告诉我为什么？', options),
    { action: 'ask-test', text: '播放《小星星》，然后告诉我为什么？' });
  assert.deepEqual(parseProbeCommand('小伴', options), { action: 'wake-ack', text: '我在' });
  assert.deepEqual(parseProbeCommand('小伴，继续播放。', options), { action: 'ask-test', text: '继续播放。' });
  assert.deepEqual(parseProbeCommand('小伴，先暂停吧。', options), { action: 'pause' });
  assert.deepEqual(parseProbeCommand('小伴，停止播放。', options), { action: 'stop' });
  assert.equal(parseProbeCommand('我喜欢小伴', options), null);
  assert.equal(parseProbeCommand('播放小星星', options), null);
  assert.equal(parseProbeCommand('小伴'), null);
  assert.deepEqual(parseProbeCommand('小伴，播放小星星'), { action: 'play-song', text: '小星星' });
});

test('spoken name uses the saved reply without a model turn and duplicate records are ignored', async t => {
  const preparations = [];
  const h = await harness(t, { probe: {
    getWakeConfig: () => ({ names: ['小伴', '小半'], greetingNames: [], acknowledgement: '小伴收到' }),
    prepareAnswer: async (text, options) => { preparations.push(options); return text; },
  } });
  await h.probe.arm({ persistent: true });
  h.setRecords([record(100001, 'wake', '小爱同学，小半！')]);
  await h.probe.poll(); await settle(); await h.probe.pending;
  await h.probe.poll(); await settle();
  assert.deepEqual(h.actions, ['say:小伴收到']);
  assert.deepEqual(preparations, [{ leadInMs: 750 }]);
  assert.deepEqual(h.questions, []);
  assert.equal(h.probe.status().lastAction, 'wake-ack');
});

test('tool responses suppress speech and normal empty answers still fail', async t => {
  let prepared = 0;
  const h = await harness(t, { probe: { ask: async () => ({ text: '已开始播放。', suppressSpeech: true }),
    prepareAnswer: async () => { prepared++; } } });
  await h.probe.arm({ persistent: true });
  assert.deepEqual(await h.probe.act('ask-test', '放一首歌。'), { suppressed: true });
  assert.equal(prepared, 0);
  assert.deepEqual(h.actions, []);
  h.probe.ask = async () => '';
  await assert.rejects(h.probe.act('ask-test', '空回复。'));
  assert.equal(h.probe.status().failures, 1);
});

test('ask receives currentness and invalidation can cancel a rejected session call without leaking callback failures', async t => {
  const started = deferred(), result = deferred();
  let context;
  const h = await harness(t, { probe: { onInvalidate: () => Promise.reject(new Error('synthetic callback detail')),
    ask: async (_, supplied) => { context = supplied; started.resolve(); return result.promise; } } });
  await h.probe.arm({ persistent: true });
  const answer = h.probe.act('ask-test', '隔离问题。'); await started.promise;
  assert.equal(context.isCurrent(), true);
  await h.probe.act('pause');
  assert.equal(context.isCurrent(), false);
  result.resolve({ text: '旧回答。', suppressSpeech: true });
  assert.deepEqual(await answer, { cancelled: true });
  assert.deepEqual(h.actions, ['pause']);
  assert.equal(h.probe.status().failures, 0);
  await settle();
});
