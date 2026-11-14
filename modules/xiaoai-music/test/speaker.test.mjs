import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { VoiceCursor } from '../lib/speaker/cursor.mjs';
import { SpeakerProbe, parseProbeCommand, matchSavedSongSources } from '../lib/speaker/probe.mjs';
import { decodeConversations, selectDevice, MiNASpeaker, historyFailure } from '../lib/speaker/mina.mjs';
import { FAMILY_AUDIO_ID } from '../lib/speaker/transport.mjs';
import definition, { localPost } from '../index.mjs';

async function makeCursor(t) {
  const dir = await mkdtemp(join(tmpdir(), 'family-isolated-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cursor = new VoiceCursor(join(dir, 'cursor.json'));
  await cursor.open();
  return cursor;
}
const record = (time, requestId, query = '你好小伴，暂停') => ({ time, requestId, query });
const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness(cursor, overrides = {}) {
  const calls = [];
  let now = 1000;
  let records = [];
  const speaker = {
    conversations: async () => [],
    conversationsSince: async () => records,
    playProbe: async () => { calls.push('play-test'); return { accepted: true }; },
    operate: async (action) => { calls.push(action); return { accepted: true }; },
    say: async (text) => { calls.push('say:' + text); },
    close: async () => { calls.push('close'); },
    ...overrides,
  };
  const probe = new SpeakerProbe({ speaker, cursor, now: () => now, ask: async () => '二。', lifetimeMs: 3000 });
  return { probe, calls, setRecords: (value) => { records = value; }, setTime: (value) => { now = value; } };
}

test('voice prefix is explicit; ordinary commands and blank prefix are ignored', () => {
  assert.equal(parseProbeCommand('停止'), null);
  assert.equal(parseProbeCommand('你好小伴'), null);
  assert.equal(parseProbeCommand('家庭入口测试，一加一等于几？'), null);
  assert.equal(parseProbeCommand('请问你好小伴是什么意思'), null);
  assert.deepEqual(parseProbeCommand('你好，小 伴，请播放测试音。'), { action: 'play-test' });
  assert.deepEqual(parseProbeCommand('你好小伴，一加一等于几？'), { action: 'ask-test', text: '一加一等于几' });
  assert.deepEqual(parseProbeCommand('你好小半，一加一等于几？'), { action: 'ask-test', text: '一加一等于几' });
  assert.deepEqual(parseProbeCommand('你好小办，一加一等于几？'), { action: 'ask-test', text: '一加一等于几' });
  assert.equal(parseProbeCommand('小火伴，一加一等于几？'), null);
});

test('common invocation spellings and greetings retain an explicit module prefix', () => {
  for (const prefix of ['小伴', '小半', '小办', '小瓣', '小拌', '小绊', '小扮', '小版', '你好小伴', '嗨小半', '小爱同学小伴']) {
    assert.deepEqual(parseProbeCommand(prefix + '播放小星星'), { action: 'play-song', text: '小星星' }, prefix);
  }
  for (const ordinary of ['播放小星星', '我认识小扮', '我想让小伴播放小星星', '饼干播放小星星']) {
    assert.equal(parseProbeCommand(ordinary), null, ordinary);
  }
});

test('conversational control wording maps to the existing pause resume and stop actions', () => {
  const examples = {
    pause: ['暂停一下', '先暂停吧', '请你暂停音乐', '停一会儿', '等一下', '稍等一下', '麻烦你帮我暂停播放好吗'],
    resume: ['继续放', '接着播', '接着播放吧', '恢复播放', '请你继续唱', '我想继续播放', '给我接着放呗'],
    stop: ['别放了', '不要播放了', '不听了', '关掉音乐', '停止播放吧', '帮我结束播放', '停掉'],
  };
  for (const [action, phrases] of Object.entries(examples)) {
    for (const phrase of phrases) assert.deepEqual(parseProbeCommand('小伴' + phrase), { action }, phrase);
  }
  assert.deepEqual(parseProbeCommand('小伴请你放一下测试音吧'), { action: 'play-test' });
});

test('natural song requests resolve conversational wording against saved song titles', () => {
  const entries = [{ title: '小星星', sourceId: 'synthetic-star' }];
  for (const phrase of ['给我放一首小星星', '我想听小星星', '我要听小星星', '放一下《小星星》吧',
    '来首小星星', '帮我唱首小星星', '请你播放妈妈版小星星', '播放小星星妈妈版',
    '用妈妈的声音唱小星星', '麻烦你给我放一首小星星好吗']) {
    const command = parseProbeCommand('小伴' + phrase);
    assert.equal(command.action, 'play-song', phrase);
    assert.deepEqual(matchSavedSongSources(entries, command.text), ['synthetic-star'], phrase);
  }
});

test('saved title matching preserves literal titles and reports ambiguous phrasing', () => {
  const entries = [
    { title: '小星星', sourceId: 'synthetic-star' },
    { title: '小星星', sourceId: 'synthetic-star' },
    { title: '一首小星星', sourceId: 'synthetic-literal' },
    { title: '走吧', sourceId: 'synthetic-go' },
    { title: '走', sourceId: 'synthetic-walk' },
    { title: '妈妈的吻', sourceId: 'synthetic-mother' },
  ];
  for (const [phrase, expected] of [['播放一首小星星', 'synthetic-literal'], ['放走吧', 'synthetic-go'], ['播放妈妈的吻', 'synthetic-mother']]) {
    assert.deepEqual(matchSavedSongSources(entries, parseProbeCommand('小伴' + phrase).text), [expected]);
  }
  assert.deepEqual(matchSavedSongSources(entries, '一首小星星吧'), ['synthetic-star', 'synthetic-literal']);
  assert.deepEqual(matchSavedSongSources(entries, '未保存的歌'), []);
});

test('negated commands and questions remain questions rather than operating playback', () => {
  for (const text of ['不要播放小星星', '别暂停', '不要继续播放', '告诉我暂停是什么意思', '如果我说停止会怎么样']) {
    assert.deepEqual(parseProbeCommand('小伴' + text), { action: 'ask-test', text });
  }
});

test('playlist voice controls use explicit list and next actions', () => {
  for (const phrase of ['播放歌单', '播放妈妈歌单', '顺序播放歌单', '给我放一下妈妈歌单']) {
    assert.deepEqual(parseProbeCommand('小伴' + phrase), { action: 'play-playlist', text: '' });
  }
  assert.deepEqual(parseProbeCommand('小伴随机播放歌单妈妈儿歌'), { action: 'shuffle-playlist', text: '妈妈儿歌' });
  assert.deepEqual(parseProbeCommand('小伴随机播放妈妈儿歌歌单吧'), { action: 'shuffle-playlist', text: '妈妈儿歌' });
  for (const phrase of ['下一首吧', '下一首歌', '换一首歌']) assert.deepEqual(parseProbeCommand('小伴' + phrase), { action: 'next' });
  assert.deepEqual(parseProbeCommand('小伴不要切歌'), { action: 'ask-test', text: '不要切歌' });
});

test('English song matching accepts punctuation and capitalization while retaining version ambiguity', () => {
  const entries = [
    { title: 'Row, Row, Row Your Boat', sourceId: 'synthetic-row' },
    { title: 'Do-Re-Mi', sourceId: 'synthetic-doremi' },
    { title: 'Baby Shark', sourceId: 'synthetic-shark-one' },
    { title: 'Baby Shark', sourceId: 'synthetic-shark-two' },
  ];
  assert.deepEqual(matchSavedSongSources(entries, parseProbeCommand('小伴播放row row row your boat').text), ['synthetic-row']);
  assert.deepEqual(matchSavedSongSources(entries, 'do re mi'), ['synthetic-doremi']);
  assert.deepEqual(matchSavedSongSources(entries, 'baby shark'), ['synthetic-shark-one', 'synthetic-shark-two']);
});

test('closing only the listening window preserves an explicitly started family playback', async t => {
  const h = harness(await makeCursor(t));
  await h.probe.arm();
  await h.probe.close({ keepPlayback: true });
  assert.equal(h.probe.active(), false);
  await assert.rejects(h.probe.act('pause'));
  assert.deepEqual(h.calls, []);
  await h.probe.close();
  assert.deepEqual(h.calls, ['close']);
});

test('cursor rejects old records, persists duplicate claims across restart, stores no transcript', async (t) => {
  const cursor = await makeCursor(t);
  await cursor.begin(1000);
  assert.equal(await cursor.claim(record(999, 'old')), false);
  assert.equal(await cursor.claim(record(1001, 'fresh')), true);
  const reopened = new VoiceCursor(cursor.file);
  await reopened.open();
  assert.equal(await reopened.claim(record(1001, 'fresh')), false);
  const stored = await readFile(cursor.file, 'utf8');
  assert.equal(stored.includes('家庭'), false);
  assert.equal(stored.includes('fresh'), false);
});

test('corrupt cursor is a failure; it is not silently reset', async (t) => {
  const cursor = await makeCursor(t);
  await writeFile(cursor.file, 'not-json');
  await assert.rejects(cursor.open(), /游标损坏/);
});

test('old, repeated and unrelated voice records do not execute; current record executes once', async (t) => {
  const cursor = await makeCursor(t);
  const h = harness(cursor);
  await h.probe.arm();
  h.setRecords([record(900, 'old'), record(1001, 'fresh'), record(1002, 'other', '普通聊天')]);
  await h.probe.poll();
  await h.probe.pending;
  await h.probe.poll();
  await h.probe.pending;
  assert.deepEqual(h.calls, ['pause']);
  assert.equal(h.probe.status().handled, 1);
  assert.equal(h.probe.status().duplicates, 1);
});

test('unreadable history cannot arm the probe', async (t) => {
  const cursor = await makeCursor(t);
  const h = harness(cursor, { conversations: async () => { throw new Error('upstream private content'); } });
  await assert.rejects(h.probe.arm());
  assert.equal(h.probe.active(), false);
});

test('observed ASR spelling reaches the model and speaker once across repeated polls', async (t) => {
  const cursor = await makeCursor(t);
  const h = harness(cursor);
  await h.probe.arm();
  h.setRecords([record(1001, 'asr-spelling', '你好小半，一加一等于几？')]);
  await h.probe.poll();
  await settle();
  await h.probe.pending;
  await h.probe.poll();
  await settle();
  await h.probe.pending;
  assert.deepEqual(h.calls, ['say:二。']);
  assert.equal(h.probe.status().handled, 1);
  assert.equal(h.probe.status().duplicates, 1);
});

test('stop is heard while an answer is outstanding and prevents late speech', async (t) => {
  const cursor = await makeCursor(t);
  const h = harness(cursor);
  let resolveAnswer;
  h.probe.ask = () => new Promise((resolve) => { resolveAnswer = resolve; });
  await h.probe.arm();
  h.setRecords([record(1001, 'question', '你好小伴，一加一等于几')]);
  await h.probe.poll();
  await settle();
  h.setRecords([record(1002, 'stop', '你好小伴，停止')]);
  await h.probe.poll();
  await h.probe.pending;
  assert.deepEqual(h.calls, ['stop']);
  resolveAnswer('二。');
  await settle();
  assert.deepEqual(h.calls, ['stop']);
  assert.equal(h.probe.status().handled, 2);
});

test('expired window refuses actions and cancels late model result', async (t) => {
  const cursor = await makeCursor(t);
  const h = harness(cursor);
  let resolveAnswer;
  h.probe.ask = () => new Promise((resolve) => { resolveAnswer = resolve; });
  await h.probe.arm();
  const pending = h.probe.act('ask-test');
  await settle();
  h.setTime(5000);
  resolveAnswer('二。');
  assert.deepEqual(await pending, { cancelled: true });
  await assert.rejects(h.probe.act('play-test'), /开启/);
  assert.deepEqual(h.calls, []);
  await h.probe.close();
  assert.deepEqual(h.calls, ['close']);
});

test('stop follows an already in-flight device play and leaves no later playback', async (t) => {
  const cursor = await makeCursor(t);
  let finishPlay;
  const h = harness(cursor, {
    playProbe: () => new Promise((resolve) => { finishPlay = () => { h.calls.push('play-test'); resolve({ accepted: true }); }; }),
  });
  await h.probe.arm();
  const playing = h.probe.act('play-test');
  await settle();
  const stopping = h.probe.act('stop');
  finishPlay();
  await Promise.all([playing, stopping]);
  assert.deepEqual(h.calls, ['play-test', 'stop']);
});

test('failed operation is consumed once, exposes a fixed error, and is not auto-retried', async (t) => {
  const cursor = await makeCursor(t);
  const h = harness(cursor, { operate: async () => { throw new Error('private-token'); } });
  await h.probe.arm();
  h.setRecords([record(1001, 'failed')]);
  await h.probe.poll();
  await h.probe.pending;
  await h.probe.poll();
  await h.probe.pending;
  assert.equal(h.probe.status().handled, 1);
  assert.equal(h.probe.status().failures, 1);
  assert.equal(JSON.stringify(h.probe.status()).includes('private-token'), false);
});

test('history supports string/object envelopes and rejects upstream or schema errors', () => {
  const data = { records: [record(1000, 'synthetic')], nextEndTime: 999 };
  assert.deepEqual(decodeConversations({ code: 0, data: JSON.stringify(data) }), data);
  assert.deepEqual(decodeConversations({ code: 0, data }), data);
  assert.throws(() => decodeConversations({ code: 401, data }), /未返回成功/);
  assert.throws(() => decodeConversations({ code: 0, data: {} }), /字段/);
  assert.throws(() => decodeConversations({ code: 0, data: '{' }), /格式/);
});

test('device selection requires exactly one matching online L05C', () => {
  const device = { hardware: 'L05C', deviceID: 'synthetic-a', presence: 'online' };
  assert.equal(selectDevice([device]), device);
  assert.throws(() => selectDevice([]), /唯一/);
  assert.throws(() => selectDevice([device, { ...device, deviceID: 'synthetic-b' }]), /唯一/);
  assert.equal(selectDevice([device, { ...device, deviceID: 'synthetic-b' }], 'synthetic-a'), device);
  assert.throws(() => selectDevice([{ ...device, presence: 'offline' }]), /在线/);
});

test('conversation paging includes same-time records without duplicate boundaries', async () => {
  const pages = [
    { records: [record(1200, 'new'), record(1100, 'middle')], nextEndTime: 1100 },
    { records: [record(1100, 'middle'), record(1000, 'boundary'), record(900, 'old')], nextEndTime: 900 },
  ];
  const speaker = new MiNASpeaker({ history: async () => pages.shift() });
  assert.deepEqual((await speaker.conversationsSince(1000)).map((r) => r.requestId), ['new', 'middle', 'boundary']);
});

test('non-advancing history cursor reports failure', async () => {
  const speaker = new MiNASpeaker({ history: async () => ({ records: [record(1200, 'same')], nextEndTime: 1200 }) });
  await assert.rejects(speaker.conversationsSince(1000), /没有前进/);
});

test('speaker audio supports full/range/HEAD delivery and controller reports actual readback', async (t) => {
  let audioUrl;
  let state = 1;
  const calls = [];
  const speaker = new MiNASpeaker({
    localAddress: '127.0.0.1',
    call: async (scope, method, message) => {
      calls.push(method);
      if (method === 'player_play_music') {
        const outer = JSON.parse(message);
        audioUrl = JSON.parse(outer.music).payload.audio_items[0].stream.url;
      }
      if (method === 'player_play_operation') state = { pause: 2, play: 1, stop: 3 }[message.action];
      return { code: 0, info: JSON.stringify({ status: state }) };
    },
  });
  t.after(() => speaker.close());
  assert.equal((await speaker.playProbe()).playback, 'playing');
  const head = await fetch(audioUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  const full = Buffer.from(await (await fetch(audioUrl)).arrayBuffer());
  assert.equal(full.length, 18 * 16000 * 2 + 44);
  assert.equal(full.toString('ascii', 0, 4), 'RIFF');
  assert.notEqual(full.readInt16LE(44 + Math.floor(17.1 * 16000) * 2 + 2), 0);
  const range = await fetch(audioUrl, { headers: { Range: 'bytes=44-99' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 56);
  assert.equal((await fetch(audioUrl, { headers: { Range: 'bytes=9999999-' } })).status, 416);
  assert.equal((await speaker.operate('pause')).playback, 'paused');
  assert.equal((await speaker.operate('play')).playback, 'playing');
  const stopped = await speaker.operate('stop');
  assert.equal(stopped.playback, 'paused');
  assert.equal(stopped.operation, 'stopped');
  await assert.rejects(speaker.operate('play'), /没有可继续/);
  assert.equal((await speaker.status()).audioRequests.matchedGet, 2);
  await speaker.close();
  assert.equal(speaker.server, null);
  assert.equal(calls.includes('text_to_speech'), false);
});

test('malformed playback state cannot be reported as successful pause', async () => {
  const speaker = new MiNASpeaker({ call: async () => ({ code: 0, info: 'bad-json' }) });
  await assert.rejects(speaker.operate('pause'), /状态不可用/);
});

test('L05C nested playback progress uses milliseconds and identifies the owned audio', async () => {
  const info = { status: 2, play_song_detail: { audio_id: FAMILY_AUDIO_ID, position: 51617, duration: 301767 } };
  const speaker = new MiNASpeaker({ call: async () => ({ code: 0, info: JSON.stringify(info) }) });
  const state = await speaker.status();
  assert.equal(state.playback, 'paused');
  assert.equal(state.position, 51.617);
  assert.equal(state.duration, 301.767);
  assert.equal(state.itemOwned, true);
  info.play_song_detail.audio_id = 'isolated-native-item';
  assert.equal((await speaker.status()).itemOwned, false);
  delete info.play_song_detail.audio_id;
  assert.equal((await speaker.status()).itemOwned, null);
});

test('legacy root playback progress stays in seconds and missing identity remains unknown', async () => {
  const speaker = new MiNASpeaker({ call: async () => ({ code: 0, info: { status: 1, position: 3, duration: 10 } }) });
  const state = await speaker.status();
  assert.equal(state.position, 3);
  assert.equal(state.duration, 10);
  assert.equal(state.itemOwned, null);
});

test('releasing an owned stream closes resources without sending native pause or stop', async t => {
  const controls = [];
  const speaker = new MiNASpeaker({
    localAddress: '127.0.0.1',
    control: { operate: async action => controls.push(action) },
    call: async () => ({ code: 0, info: { status: 1 } }),
  });
  t.after(() => speaker.close());
  await speaker.playProbe();
  assert.equal(speaker.ownsPlayback, true);
  assert.equal(speaker.canResume, true);
  assert.notEqual(speaker.server, null);
  speaker.releasePlayback();
  await speaker.close();
  assert.equal(speaker.ownsPlayback, false);
  assert.equal(speaker.canResume, false);
  assert.equal(speaker.server, null);
  assert.deepEqual(controls, []);
});

test('control routes reject remote, cross-origin and non-POST requests', () => {
  const request = {
    method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
  };
  assert.equal(localPost(request), true);
  assert.equal(localPost({ ...request, method: 'GET' }), false);
  assert.equal(localPost({ ...request, socket: { remoteAddress: '192.0.2.1' } }), false);
  assert.equal(localPost({ ...request, headers: { ...request.headers, origin: 'https://example.com' } }), false);
});

test('module setup registers no QQ send/message hook and does not read credentials or connect', async (t) => {
  const cursor = await makeCursor(t);
  const routes = new Map();
  const events = [];
  let dispose;
  const module = await definition.setup({
    tool() {}, rule() {}, defineTool: value => value,
    id: 'xiaoai-music',
    settings: () => ({ resourceRoot: dirname(cursor.file) }),
    route: (path, handler) => routes.set(path, handler),
    every: () => {},
    on: (name) => events.push(name),
    onDispose: (fn) => { dispose = fn; },
  });
  assert.equal(module.status().connected, false);
  assert.deepEqual(events, ['config']);
  assert.equal((await routes.get('/status')()).probe.active, false);
  await dispose();
});

test('history diagnostics retain numeric service and HTTP codes without upstream content', () => {
  assert.throws(() => decodeConversations({ code: 123, message: 'synthetic-private-body' }), error => {
    assert.deepEqual(historyFailure(error), { code: 'HISTORY_SERVICE', serviceCode: 123 });
    assert.equal(error.message.includes('synthetic-private'), false);
    return true;
  });
  assert.deepEqual(historyFailure(new Error('HTTP 503')), { code: 'HISTORY_HTTP', httpStatus: 503 });
  assert.deepEqual(historyFailure(new Error('network request failed or timed out')), { code: 'HISTORY_NETWORK' });
  assert.deepEqual(historyFailure(new Error('synthetic-private-body')), { code: 'HISTORY_READ_FAILED' });
});

test('history failure is counted separately and recovery processes the record once', async (t) => {
  const cursor = await makeCursor(t);
  let fail = true;
  const h = harness(cursor, {
    conversationsSince: async () => {
      if (fail) throw Object.assign(new Error('fixed private failure'), { code: 'HISTORY_SERVICE', serviceCode: 123 });
      return [record(1200, 'recover', '你好小伴，暂停')];
    },
  });
  await h.probe.arm();
  await h.probe.poll();
  assert.equal(h.probe.status().historyFailures, 1);
  assert.deepEqual(h.probe.status().lastHistoryFailure, { code: 'HISTORY_SERVICE', serviceCode: 123 });
  assert.equal(h.probe.status().handled, 0);
  fail = false;
  await h.probe.poll();
  await settle();
  await h.probe.poll();
  assert.deepEqual(h.calls, ['pause']);
  assert.equal(h.probe.status().handled, 1);
  assert.equal(h.probe.status().lastError, '');
  assert.equal(h.probe.status().historyFailures, 1);
});

test('cursor save failure is not misreported as a history API failure and cannot execute', async (t) => {
  const cursor = await makeCursor(t);
  const h = harness(cursor);
  await h.probe.arm();
  h.setRecords([record(1200, 'save-fails')]);
  cursor.claim = async () => { throw new Error('synthetic-private-path'); };
  await h.probe.poll();
  assert.equal(h.probe.status().failures, 1);
  assert.equal(h.probe.status().historyFailures, 0);
  assert.equal(h.probe.status().handled, 0);
  assert.deepEqual(h.calls, []);
  assert.match(h.probe.status().lastError, /游标保存失败/);
  assert.equal(JSON.stringify(h.probe.status()).includes('synthetic-private'), false);
});

test('a saved-song voice command uses family playback once instead of asking the model', async t => {
  const cursor = await makeCursor(t);
  const actions = [];
  const speaker = { conversations: async () => [], close: async () => {},
    conversationsSince: async () => [record(1200, 'song-record', '你好小半，播放小星星')] };
  const probe = new SpeakerProbe({ speaker, cursor, now: () => 1000,
    ask: async () => { throw new Error('Song commands must not ask the model'); },
    familyAction: (action, text) => { if (action === 'play-song') { actions.push([action, text]); return Promise.resolve({ accepted: true }); } },
  });
  await probe.arm();
  await probe.poll();
  await settle();
  await probe.poll();
  assert.deepEqual(actions, [['play-song', '小星星']]);
  assert.equal(probe.status().handled, 1);
  assert.deepEqual(parseProbeCommand('你好小伴，用妈妈声音唱小星星'), { action: 'play-song', text: '小星星' });
  assert.deepEqual(parseProbeCommand('小伴，播放小星星'), { action: 'play-song', text: '小星星' });
  assert.deepEqual(parseProbeCommand('小伴，暂停'), { action: 'pause' });
  assert.deepEqual(parseProbeCommand('小半播放小星星'), { action: 'play-song', text: '小星星' });
  assert.deepEqual(parseProbeCommand('小办播放小星星'), { action: 'play-song', text: '小星星' });
});
