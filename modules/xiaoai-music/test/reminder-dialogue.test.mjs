import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { createReminderDialogue, reminderDialogueFailure } from '../lib/companion/reminder-dialogue.mjs';
import { createFamilySession } from '../lib/companion/session.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'family-reminder-dialogue-'));
  t.after(async () => {
    const path = relative(tmpdir(), root); assert.ok(path && !isAbsolute(path) && !path.startsWith('..'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, sessionFile: join(root, 'Conversations', '家庭会话.json'),
    reminderSessionFile: join(root, 'Conversations', '提醒会话.json'), workspaceRoot: join(root, 'Conversations', 'Workspace') };
}
async function harness(t, options = {}) {
  const resources = await fixture(t);
  let persona = 'isolated current AuraBot role';
  let personaReads = 0;
  let ask = async () => ({ text: '  中，该歇一会儿啦。  ', suppressSpeech: false });
  const created = [], calls = [], forwarded = [];
  const api = { core: { personas: { current: () => { personaReads++; if (options.personaFailure) throw new Error('isolated-private-upstream'); return persona; } } },
    think: () => { throw new Error('api.think is forbidden'); }, ask: () => { throw new Error('standalone model fallback is forbidden'); } };
  const makeSession = async (_api, location, setup) => {
    const item = { location, setup, closed: 0, cancelled: 0, ensured: 0 };
    created.push(item);
    return { ensure: async () => { item.ensured++; return { sessionId: 'same-reminder-session' }; },
      status: () => ({ sessionId: 'same-reminder-session', persona: setup.persona, arbitraryPrivateField: 'not public' }),
      ask: async (text, context) => { calls.push({ text, context }); return ask(text, context); },
      cancel: () => item.cancelled++, close: async () => { item.closed++; } };
  };
  const service = createReminderDialogue(api, resources, { makeSession,
    ...(options.noExecute ? {} : { execute: async (args, context) => { forwarded.push({ args, context }); return { ok: true, count: 14 }; } }) });
  t.after(() => service.close());
  return { resources, service, created, calls, forwarded, setPersona: value => { persona = value; },
    setAsk: value => { ask = value; }, personaReads: () => personaReads };
}

test('reminder generation uses the current persona privately and its own session mapping in the same workspace', async t => {
  const h = await harness(t);
  assert.deepEqual(h.service.status(), { sessionId: null, title: '小爱音响接入 · 提醒', busy: false, error: null });
  assert.equal(h.personaReads(), 0);
  const text = 'Synthetic reminder hint';
  assert.equal(await h.service.generate(text), '中，该歇一会儿啦。');
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].location.sessionFile, h.resources.reminderSessionFile);
  assert.notEqual(h.created[0].location.sessionFile, h.resources.sessionFile);
  assert.equal(h.created[0].location.workspaceRoot, h.resources.workspaceRoot);
  assert.equal(h.created[0].setup.title, '小爱音响接入 · 提醒');
  assert.equal(h.created[0].setup.persona, 'isolated current AuraBot role');
  assert.equal(h.calls[0].context.readOnly, true);
  assert.equal(h.calls[0].context.isCurrent(), true);
  assert.ok(h.calls[0].text.includes(JSON.stringify(text)));
  assert.equal(h.calls[0].text.includes('isolated current AuraBot role'), false);
  assert.equal(JSON.stringify(h.service.status()).includes(text), false);
  assert.equal(JSON.stringify(h.service.status()).includes('isolated current AuraBot role'), false);
  assert.equal(JSON.stringify(h.service.status()).includes('arbitraryPrivateField'), false);
});

test('persona updates rebind the reminder adapter while preserving its session identity', async t => {
  const h = await harness(t);
  const first = await h.service.ensureSession();
  await h.service.generate('First isolated reminder');
  assert.equal(h.created.length, 1);
  h.setPersona('a changed isolated AuraBot role');
  await h.service.generate('Second isolated reminder');
  assert.equal(h.created.length, 2);
  assert.equal(h.created[0].closed, 1);
  assert.equal(h.created[1].setup.persona, 'a changed isolated AuraBot role');
  assert.equal(h.created[1].location.sessionFile, h.created[0].location.sessionFile);
  assert.equal(h.service.status().sessionId, first.status().sessionId);
  assert.equal(h.personaReads(), 3);
});

test('reminder tools always deny playback and mutations even outside a programmatic read-only turn', async t => {
  const h = await harness(t); await h.service.ensureSession();
  const run = h.created[0].setup.execute;
  const context = { isCurrent: () => true, signal: new AbortController().signal };
  for (const action of ['play-song', 'play-playlist', 'shuffle-playlist', 'next', 'pause', 'resume', 'stop', 'send-message', 'change-settings']) {
    const result = await run({ action, query: 'Synthetic content' }, context);
    assert.equal(result.ok, false, action);
    assert.equal(result.code, 'REMINDER_READ_ONLY', action);
  }
  assert.deepEqual(h.forwarded, []);
  assert.equal((await run({ action: 'catalog' }, context)).ok, true);
  assert.equal((await run({ action: 'status' }, context)).ok, true);
  assert.deepEqual(h.forwarded.map(value => value.args.action), ['catalog', 'status']);
  assert.equal((await run({ action: 'catalog' }, { isCurrent: () => false })).cancelled, true);
  assert.equal(h.forwarded.length, 2);
});

test('an absent read interface is explicitly denied without reaching an unrelated service', async t => {
  const h = await harness(t, { noExecute: true }); await h.service.ensureSession();
  assert.equal((await h.created[0].setup.execute({ action: 'catalog' }, { isCurrent: () => true })).ok, false);
  assert.equal(h.forwarded.length, 0);
});

test('a cancelled reminder cannot return a late generated phrase', async t => {
  const h = await harness(t), started = deferred(), result = deferred();
  let current = true;
  h.setAsk(async () => { started.resolve(); return result.promise; });
  const pending = h.service.generate('Synthetic scheduled phrase', { isCurrent: () => current });
  await started.promise;
  assert.equal(h.service.status().busy, true);
  current = false;
  result.resolve({ text: 'A late phrase', suppressSpeech: false });
  await assert.rejects(pending, { code: 'REMINDER_DIALOGUE_CANCELLED' });
  assert.equal(h.service.status().busy, false);
});

test('a newer reminder invalidates an older result without replacing the latest status', async t => {
  const h = await harness(t), firstStarted = deferred(), old = deferred();
  h.setAsk(async text => {
    if (text.includes('first isolated hint')) { firstStarted.resolve(); return old.promise; }
    return { text: 'Latest isolated phrase', suppressSpeech: false };
  });
  const first = h.service.generate('first isolated hint');
  await firstStarted.promise;
  assert.equal(await h.service.generate('second isolated hint'), 'Latest isolated phrase');
  old.resolve({ text: 'Old isolated phrase', suppressSpeech: false });
  await assert.rejects(first, { code: 'REMINDER_DIALOGUE_CANCELLED' });
  assert.equal(h.service.status().busy, false);
  assert.equal(h.service.status().error, null);
});

test('a replacement already cancelled by its caller clears the previous busy state', async t => {
  const h = await harness(t), started = deferred(), output = deferred();
  h.setAsk(async () => { started.resolve(); return output.promise; });
  const first = h.service.generate('First isolated hint'); await started.promise;
  assert.equal(h.service.status().busy, true);
  await assert.rejects(h.service.generate('Cancelled replacement', { isCurrent: () => false }), { code: 'REMINDER_DIALOGUE_CANCELLED' });
  output.resolve({ text: 'Late isolated text', suppressSpeech: false });
  await assert.rejects(first, { code: 'REMINDER_DIALOGUE_CANCELLED' });
  assert.equal(h.service.status().busy, false);
});

test('input, unavailable persona and upstream failures return fixed classifications without private details', async t => {
  const h = await harness(t);
  await assert.rejects(h.service.generate('  '), { code: 'REMINDER_DIALOGUE_INPUT' });
  assert.equal(h.personaReads(), 0);
  for (const value of [{ text: '  ' }, { text: 'Not a spoken response', suppressSpeech: true }, null]) {
    h.setAsk(async () => value);
    await assert.rejects(h.service.generate('Synthetic hint'), { code: 'REMINDER_DIALOGUE_FAILED' });
  }
  h.setAsk(async () => { throw new Error('isolated-private-upstream'); });
  await assert.rejects(h.service.generate('Synthetic hint'), error => {
    assert.equal(error.code, 'REMINDER_DIALOGUE_FAILED');
    assert.equal(error.message.includes('isolated-private-upstream'), false); return true;
  });
  assert.equal(JSON.stringify(h.service.status()).includes('isolated-private-upstream'), false);
  const unavailable = await harness(t, { personaFailure: true });
  await assert.rejects(unavailable.service.ensureSession(), { code: 'REMINDER_PERSONA_UNAVAILABLE' });
  assert.equal(unavailable.created.length, 0);
  assert.equal(JSON.stringify(unavailable.service.status()).includes('isolated-private-upstream'), false);
  assert.equal(reminderDialogueFailure(new Error('private detail')).message.includes('private detail'), false);
});

test('reminder service rejects a missing or shared conversation mapping instead of touching the dialogue session', async t => {
  const resources = await fixture(t);
  assert.throws(() => createReminderDialogue({}, { ...resources, reminderSessionFile: undefined }), { code: 'REMINDER_SESSION_CONFIG' });
  assert.throws(() => createReminderDialogue({}, { ...resources, reminderSessionFile: resources.sessionFile }), { code: 'REMINDER_SESSION_CONFIG' });
});

test('closing during session construction closes the late adapter without starting it', async t => {
  const resources = await fixture(t), started = deferred(), ready = deferred();
  let closed = 0, ensured = 0;
  const service = createReminderDialogue({ core: { personas: { current: () => 'Synthetic persona' } } }, resources, {
    makeSession: async () => { started.resolve(); return ready.promise; },
  });
  const pending = service.ensureSession(); await started.promise;
  const closing = service.close();
  ready.resolve({ close: async () => closed++, ensure: async () => ensured++ });
  await assert.rejects(pending, { code: 'REMINDER_DIALOGUE_CANCELLED' });
  await closing;
  assert.equal(closed, 1); assert.equal(ensured, 0);
});

test('FamilySession applies an optional reminder title to the controller and persisted mapping', async t => {
  const resources = await fixture(t), workspaces = [], tools = new Map(), variables = new Map(), renames = [];
  let creates = 0;
  const agent = { id: 'owned-reminder-agent', session: { id: 'owned-reminder-agent' }, followup() {}, cancel() {}, whenIdle: async () => {},
    ctx: { on: () => () => {}, systemPrompt: { variable: (name, value) => { variables.set(name, value); return () => variables.delete(name); } },
      tools: { presentAs: () => () => {}, restrict: () => () => {}, guard: () => () => {},
        register: value => { tools.set(value.name, value); return () => tools.delete(value.name); },
        schemas: () => [...tools.keys()].map(name => ({ name })) } } };
  const registry = { list: () => workspaces, archivedSessionIds: [], create: async path => {
    const workspace = { id: 'owned-family-workspace', path, sessionIds: [] }; workspaces.push(workspace); return workspace;
  } };
  const controller = { create: async ({ workspaceId }) => { creates++; workspaces.find(value => value.id === workspaceId).sessionIds.push(agent.id); return { sessionId: agent.id }; },
    rename: async value => renames.push(value), resolveAgent: async () => ({ agent }), agents: { selectForNextRequest() {} } };
  const api = { dsh: { workspaceRegistry: registry, get: name => name === 'sessionController' ? controller : undefined },
    config: () => ({ model: { provider: 'synthetic-provider', model: 'synthetic-model' } }),
    lib: () => ({ defaultModel: (_dsh, config) => config.model, pickReasoningEffort: async () => '' }) };
  const location = { ...resources, sessionFile: resources.reminderSessionFile };
  const first = await createFamilySession(api, location, { persona: 'Synthetic persona', execute: async () => ({ ok: false }), title: '小爱音响接入 · 提醒' });
  t.after(() => first.close());
  assert.equal((await first.ensure()).title, '小爱音响接入 · 提醒');
  assert.equal(first.status().title, '小爱音响接入 · 提醒');
  assert.equal(renames[0].title, '小爱音响接入 · 提醒');
  assert.equal(JSON.parse(await readFile(resources.reminderSessionFile, 'utf8')).title, '小爱音响接入 · 提醒');
  await first.close();
  const restored = await createFamilySession(api, location, { persona: 'Synthetic persona', execute: async () => ({ ok: false }), title: '小爱音响接入 · 提醒' });
  t.after(() => restored.close());
  await restored.ensure();
  assert.equal(creates, 1);
  assert.equal(restored.status().sessionId, first.status().sessionId);
});
