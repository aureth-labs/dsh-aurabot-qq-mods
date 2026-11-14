import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { SpeakerProbe, matchSavedSongSources, WAKE_ACK_LEAD_IN_MS } from '../lib/speaker/probe.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

// Run the real index and Probe with only its external services substituted.
// VM modules need a Node flag; the normal test command stays unchanged.
async function fixture() {
  const routes = new Map(), disposers = [], questions = [];
  const preferenceWait = deferred(), preferenceStarted = deferred();
  const cancelWait = deferred(), cancelStarted = deferred();
  const sessionWait = deferred(), sessionStarted = deferred();
  const syncWait = deferred(), syncStarted = deferred();
  const reminderWait = deferred(), reminderStarted = deferred(), reminderStatusWait = deferred(), reminderStatusStarted = deferred();
  const hold = { preference: false, cancel: false, session: false, sync: false, reminder: false, reminderStatus: false };
  let connections = 0, arms = 0, sessions = 0, pauses = 0, tick, ownPlayback = { phase: 'idle' };
  let reminderCallbacks, reminderCleanups = 0, loginPhase = 'idle';
  const reminderAudio = [];
  let records = [];
  const speaker = { conversations: async () => { arms++; return []; }, conversationsSince: async () => records,
    close: async () => {}, operate: async action => { if (action === 'pause') pauses++; }, releasePlayback() {},
    status: async () => { if (hold.reminderStatus) { reminderStatusStarted.resolve(); await reminderStatusWait.promise; } return { playback: 'paused' }; } };
  const service = { status: () => ({}),
    ensureSession: async () => { sessions++; if (hold.session) { sessionStarted.resolve(); await sessionWait.promise; } return {}; },
    cancel: () => { if (hold.cancel) { cancelStarted.resolve(); return cancelWait.promise; } }, close: async () => {},
    converse: async text => { questions.push(text); return { text: '隔离无声回复', suppressSpeech: true }; },
    prepare: async () => ({ file: 'synthetic-reminder.wav', duration: 1, cleanup: async () => { reminderCleanups++; } }) };
  class Cursor {
    constructor() { this.state = { since: 0, claimed: [] }; }
    async open() {} async begin(now) { this.state.since = now; } async claim() { return true; } async advance() {}
  }
  class Preference {
    constructor() { this.enabled = false; }
    async open() {}
    async setEnabled(value) {
      if (!value && hold.preference) { preferenceStarted.resolve(); await preferenceWait.promise; }
      this.enabled = value;
    }
  }
  class Login { close() {} status() { return { phase: loginPhase }; } async start() { loginPhase = 'waiting'; return this.status(); } }
  class Playback {
    constructor() { this.selected = null; }
    status() { return ownPlayback; }
    async close() {}
    async audio(entry, options) {
      if (!options.isCurrent()) return;
      reminderAudio.push(entry.id); this.task = Promise.resolve(); ownPlayback = { phase: 'playing' };
    }
    async syncNativePlayback() { if (hold.sync) { syncStarted.resolve(); await syncWait.promise; } }
  }
  class Lists { async open() {} status() { return []; } }
  class Reminders { constructor(options) { reminderCallbacks = options; } async open() {} list() { return []; } async tick() {} async close() {} }
  const library = { status: () => ({ entries: [], jobs: [] }) };
  const root = join(tmpdir(), 'family-listener-shutdown-synthetic');
  const exports = {
    './lib/companion/onboarding.mjs': { setupOnboarding: (api, runtime) => runtime(api) },
    './lib/speaker/cursor.mjs': { VoiceCursor: Cursor },
    './lib/speaker/windows.mjs': { loadWindowsCredentials: async () => ({}), saveWindowsCredentials: async () => {} },
    './lib/speaker/mina.mjs': { connectSpeaker: async () => { connections++; return speaker; }, verifySpeakerLogin: async () => {}, historyFailure: () => ({}) },
    './lib/speaker/probe.mjs': { SpeakerProbe, matchSavedSongSources, WAKE_ACK_LEAD_IN_MS },
    './lib/speaker/model.mjs': { askProbeModel: async () => '', MODEL_TOKEN_BUDGET: 120, MODEL_TEST_QUESTION: '隔离' },
    './lib/speaker/login.mjs': { SpeakerLogin: Login },
    './lib/speaker/transport.mjs': { authObservation: () => ({}), completeServiceLogin: async () => {} },
    'node:fs/promises': { readFile, mkdir: async () => {} }, 'node:path': { join, dirname },
    './lib/songs/library.mjs': { FamilySongError: class extends Error {}, songFailure: () => ({}) },
    './lib/songs/playback.mjs': { FamilyPlayback: Playback }, './lib/songs/playlists.mjs': { SongPlaylists: Lists },
    './lib/songs/runtime.mjs': { createFamilySongs: async () => ({ library }) },
    './lib/songs/storage.mjs': { resourcePaths: () => ({ cursorFile: join(root, 'cursor.json'), listenerFile: join(root, 'listener.json') }) },
    './lib/companion/speech.mjs': { createDialogueSpeech: () => ({}) },
    './lib/companion/wake-audio.mjs': { createWakeAudio: () => ({ close: async () => {} }) },
    './lib/companion/runtime.mjs': { companionFailure: () => ({}), createFamilyCompanion: async () => service },
    './lib/speaker/wake-ai.mjs': { suggestWakeNames: async () => ({ ok: true }) },
    './lib/speaker/wake.mjs': { WakePreference: class { async open() {} get() { return undefined; } } },
    './lib/songs/local-audio.mjs': { createLocalAudioHandler: () => () => {} },
    './lib/songs/resource-check.mjs': { checkResourceCopy: async () => ({ ok: true }) },
    './lib/speaker/listener.mjs': { ListenerPreference: Preference },
    './lib/companion/actions.mjs': { createFamilyActions: () => async () => ({}) },
    './lib/companion/settings.mjs': { getVoiceOptions: () => ({ options: [] }) },
    './lib/companion/reminders.mjs': { FamilyReminders: Reminders },
    './lib/companion/reminder-dialogue.mjs': { createReminderDialogue: () => ({
      status: () => ({ busy: false }), close: async () => {},
      generate: async () => { if (hold.reminder) { reminderStarted.resolve(); await reminderWait.promise; } return '隔离提醒'; },
    }) },
    './lib/companion/aurabot-tools.mjs': { registerFamilyTools() {}, PLAYBACK_ACTIONS: ['catalog', 'status', 'play-song', 'play-playlist', 'shuffle-playlist', 'next', 'pause', 'resume', 'stop'], PLAYBACK_PROPERTIES: {}, REMINDER_PROPERTIES: {} },
  };
  const context = vm.createContext({ Promise, Date });
  const loaded = new Map();
  async function dependency(name) {
    if (loaded.has(name)) return loaded.get(name);
    const values = exports[name];
    assert.ok(values, 'Unexpected dependency in the isolated listener fixture');
    const module = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
    loaded.set(name, module);
    await module.link(() => {}); await module.evaluate();
    return module;
  }
  const module = new vm.SourceTextModule(await readFile(new URL('../index.mjs', import.meta.url), 'utf8'),
    { context, importModuleDynamically: dependency });
  await module.link(dependency); await module.evaluate();
  await module.namespace.default.setup({ id: 'xiaoai-music', settings: () => ({ resourceRoot: root }),
    route: (path, handler) => routes.set(path, handler), every: (_, callback) => { tick = callback; }, on() {},
    onDispose: callback => disposers.push(callback), core: { http: { body: async request => request.body } } });
  const request = { method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' }, body: {} };
  return { hold, questions, preferenceWait, preferenceStarted, cancelWait, cancelStarted,
    sessionWait, sessionStarted, syncWait, syncStarted, reminderWait, reminderStarted, reminderStatusWait, reminderStatusStarted,
    reminderAudio, reminderCleanups: () => reminderCleanups,
    loginPhase: value => { loginPhase = value; },
    deliverReminder: () => reminderCallbacks.deliver({ id: 'synthetic-reminder', text: 'Synthetic prompt' }, { isCurrent: () => true }),
    canDeliverReminder: () => reminderCallbacks.canDeliver(),
    post: (path, body = {}) => routes.get(path)({ ...request, body }), tick: () => tick(), unload: () => disposers[0](),
    records: (query = '小伴，关闭期间的问题') => { records = [{ time: Date.now() + 1, requestId: 'synthetic-request', query }]; },
    ownPlayback: value => { ownPlayback = value; },
    counts: () => ({ connections, arms, sessions, pauses }), status: () => routes.get('/status')(),
  };
}

async function verifyShutdowns() {
  for (const phase of ['preparing', 'waiting', 'verifying']) {
    const h = await fixture();
    await h.post('/speaker/listener/start');
    await h.post('/speaker/login/start');
    h.loginPhase(phase);
    const before = h.counts();
    await h.tick(); await settle();
    assert.deepEqual(h.counts(), before, 'Login must not reconnect using old credentials during ' + phase);
    assert.equal(await h.canDeliverReminder(), false, 'Login must defer reminders during ' + phase);
    await h.unload();
  }
  for (const phase of ['preference', 'cancel']) {
    const h = await fixture();
    await h.post('/speaker/listener/start');
    h.hold[phase] = true;
    const closing = h.post('/speaker/end');
    await h[phase + 'Started'].promise;
    h.records(); await h.tick(); await settle();
    assert.equal(h.questions.length, 0, phase + ' wait must not accept a new request');
    assert.equal((await h.status()).listener.active, false);
    h[phase + 'Wait'].resolve();
    const stopped = await closing;
    assert.equal(stopped.listener.enabled, false);
    assert.equal(stopped.listener.active, false);
    await h.unload();
  }
  {
    const h = await fixture();
    await h.post('/speaker/listener/start'); await h.post('/songs/check');
    h.hold.sync = true;
    const oldTick = h.tick(); await h.syncStarted.promise;
    await h.unload();
    h.syncWait.resolve(); await oldTick;
    assert.equal(h.counts().connections, 1, 'A tick resumed after unload cannot reconnect');
    assert.equal((await h.status()).listener.active, false);
    assert.equal((await h.status()).connected, false);
  }
  {
    const h = await fixture(); h.hold.session = true;
    const starting = h.post('/speaker/listener/start'); await h.sessionStarted.promise;
    await h.post('/speaker/end');
    h.sessionWait.resolve(); await starting;
    assert.equal(h.counts().arms, 0, 'A late session startup cannot rearm a closed entry');
    assert.equal((await h.status()).listener.active, false);
    await h.unload();
  }
  for (const hasPlaylist of [false, true]) {
    const h = await fixture();
    await h.post('/speaker/listener/start'); await h.post('/songs/check');
    if (hasPlaylist) h.ownPlayback({ phase: 'playing', selected: 'synthetic-song', playlist: { total: 2, index: 0 } });
    h.records(hasPlaylist ? '小伴，下一首' : '小伴，陪我聊两句');
    await h.tick(); await settle();
    assert.equal(h.questions.length, 1, 'A prefixed question reaches the same family session once');
    assert.equal(h.counts().pauses, hasPlaylist ? 0 : 1, 'Suppressing native speech must preserve an existing family playlist');
    await h.unload();
  }
  {
    const h = await fixture();
    assert.equal((await h.deliverReminder()).accepted, true);
    assert.deepEqual(h.reminderAudio, ['family-reminder:synthetic-reminder']);
    assert.equal(h.reminderCleanups(), 1);
    await h.unload();
  }
  for (const phase of ['reminder', 'reminderStatus']) {
    const h = await fixture();
    h.hold[phase] = true;
    const delivery = h.deliverReminder();
    await h[phase + 'Started'].promise;
    await h.post('/speaker/end');
    h[phase + 'Wait'].resolve();
    await assert.rejects(delivery, phase + ' cannot revive a reminder after close');
    assert.deepEqual(h.reminderAudio, []);
    assert.equal(h.reminderCleanups(), phase === 'reminderStatus' ? 1 : 0);
    await h.unload();
  }
  {
    const h = await fixture();
    const preview = await h.post('/reminders/preview', { text: 'Synthetic preview' });
    assert.equal(preview.ok, true); assert.equal(preview.preview, '隔离提醒');
    assert.deepEqual(h.reminderAudio, []); assert.equal(h.reminderCleanups(), 0);
    await h.unload();
  }
  {
    const h = await fixture(); h.hold.reminderStatus = true;
    const readiness = h.canDeliverReminder(); await h.reminderStatusStarted.promise;
    h.hold.reminder = true;
    const preview = h.post('/reminders/preview', { text: 'Synthetic preview' }); await h.reminderStarted.promise;
    h.reminderStatusWait.resolve();
    assert.equal(await readiness, false, 'A preview cannot overlap a scheduled reminder admitted after a status wait');
    h.reminderWait.resolve(); assert.equal((await preview).ok, true);
    assert.deepEqual(h.reminderAudio, []); await h.unload();
  }
  return { cases: 14, noVoice: true, noAccounts: true };
}

if (process.env.FAMILY_LISTENER_SHUTDOWN_CHILD === '1') {
  const result = await verifyShutdowns();
  process.stdout.write(JSON.stringify(result));
} else {
  test('closing and unloading the actual listener cannot admit new requests or resume stale startup work', async () => {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--no-warnings', '--experimental-vm-modules', fileURLToPath(import.meta.url)],
        { windowsHide: true, env: { ...process.env, FAMILY_LISTENER_SHUTDOWN_CHILD: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = '';
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Isolated listener shutdown check timed out')); }, 15000);
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { errors += data; });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', code => {
        clearTimeout(timeout);
        if (code !== 0) reject(new Error('Isolated listener shutdown check failed: ' + errors));
        else { try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid isolated shutdown result')); } }
      });
    });
    assert.deepEqual(result, { cases: 14, noVoice: true, noAccounts: true });
  });
}
