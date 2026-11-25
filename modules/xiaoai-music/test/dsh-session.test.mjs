import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { createFamilySession } from '../lib/companion/session.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function harness(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'family-dsh-session-'));
  const resources = { sessionFile: join(root, 'Conversations', '家庭会话.json'), workspaceRoot: join(root, 'Conversations', 'Workspace') };
  const workspaces = [], listeners = new Set(), tools = new Map(), variables = new Map(), guards = [];
  const services = [], inputs = [], calls = [], selections = [], creates = [];
  let presentation = 'code';
  let masked = false;
  let turnNumber = 0;
  let live;
  let behavior = async () => '中，我听着呢。';
  const globalConfig = { voice: { engine: 'edge' }, model: { provider: 'isolated-provider', model: 'isolated-model', reasoningEffort: 'low' } };
  const baseline = JSON.stringify(globalConfig);
  const agent = { id: 'family-session', session: { id: 'family-session' }, status: 'idle',
    ctx: {
      on(name, fn) { assert.equal(name, 'session/event'); listeners.add(fn); return () => listeners.delete(fn); },
      systemPrompt: { variable(name, fn) { assert.equal(variables.has(name), false); variables.set(name, fn); return () => variables.delete(name); } },
      tools: {
        presentAs(mode) { assert.equal(presentation, 'code'); assert.equal(mode, 'native'); presentation = mode; return () => { presentation = 'code'; }; },
        restrict(value) { assert.deepEqual(value, { allow: [] }); masked = true; return () => { masked = false; }; },
        register(tool) { assert.equal(tools.has(tool.name), false); tools.set(tool.name, tool); return () => tools.delete(tool.name); },
        guard(fn) { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1); },
        schemas(scope) { assert.equal(scope, agent); return [
          ...[...tools.keys()].map(name => ({ name })),
          ...(!masked ? [{ name: 'isolated-global-tool' }] : []),
          ...(presentation !== 'native' ? [{ name: 'run_code' }] : []),
          ...(options.foreignScopedTool ? [{ name: 'isolated-foreign-scoped-tool' }] : []),
        ]; },
      },
    },
    whenIdle() { return live ? live.idle.promise : Promise.resolve(); },
    cancel(cause) {
      assert.deepEqual(cause, { kind: 'user' });
      if (live) live.controller.abort();
    },
    followup(message) {
      assert.equal(agent.status, 'idle');
      inputs.push(message);
      const item = begin(message);
      void Promise.resolve().then(() => behavior({ message, signal: item.controller.signal,
        invoke: args => invoke(args, item.controller.signal) })).then(text => finish(item, text));
    },
  };
  function emit(type, data, sessionId = agent.id) { for (const fn of listeners) fn({ id: sessionId }, { type, data }); }
  function begin(message) {
    const item = { turn: ++turnNumber, controller: new AbortController(), idle: deferred() };
    live = item; agent.status = 'running'; emit('turn/start', { turn: item.turn }); emit('user/message', message); return item;
  }
  function finish(item, text = '中。') {
    const cancelled = item.controller.signal.aborted;
    emit('assistant/message', { turn: item.turn, step: 1, message: { content: [{ type: 'text', text }] }, ...(cancelled ? { interrupted: true } : {}) });
    emit('turn/end', { turn: item.turn, reason: { kind: cancelled ? 'cancelled' : 'completed' } });
    if (live === item) { live = null; agent.status = 'idle'; }
    item.idle.resolve();
  }
  async function invoke(args, signal = live?.controller.signal || new AbortController().signal) {
    const exec = { agent, signal, name: 'xiaoai_music' };
    const denial = guards.map(fn => fn(exec)).find(Boolean);
    if (denial) return { ok: false, message: denial };
    return tools.get('xiaoai_music').execute(args, exec);
  }
  const registry = { archivedSessionIds: [], list: () => workspaces,
    async create(path, title) { const workspace = { id: 'family-workspace', path, title, sessionIds: [] }; workspaces.push(workspace); return workspace; } };
  const controller = { agents: { selectForNextRequest: (subject, selection) => { assert.equal(subject, agent); selections.push(selection); } },
    async create(value) {
      creates.push(value); assert.equal(value.agentPreset, 'aurabot-social');
      workspaces.find(item => item.id === value.workspaceId).sessionIds.push(agent.id);
      return { sessionId: agent.id };
    },
    async resolveAgent(id) { assert.equal(id, agent.id); if (options.resolveFailure) throw new Error('isolated-private-upstream'); return { agent }; },
    async rename(value) { assert.equal(value.sessionId, agent.id); assert.equal(value.title, '小爱音响接入 · 对话'); },
  };
  let flushes = 0;
  if (options.modernModelSelection) {
    delete controller.agents.selectForNextRequest;
    agent.model = { select(selection) { selections.push(selection); } };
    delete agent.ctx.tools.presentAs;
    presentation = 'native';
    agent.ctx.tools.selectExecutor = () => ({
      describe: tools => ({ schemas: options.invalidNativeExecutor ? [{ name: 'unrelated-tool' }] : tools.map(tool => ({ name: tool.name })) }),
    });
  }
  const dsh = { workspaceRegistry: registry, sessions: { flush: async () => { flushes++; return true; } }, get: name => {
    if (name === 'sessionController') return controller;
    if (name === 'workspaceRegistry') return registry;
    throw new Error('Unexpected DSH service');
  } };
  const api = { dsh, config: () => globalConfig,
    lib: name => { assert.equal(name, 'core/llm.js'); return {
      defaultModel: (_ctx, config) => config.model,
      pickReasoningEffort: async (_ctx, _provider, _model, effort) => effort,
    }; },
    ask: () => { throw new Error('A standalone-model fallback is forbidden'); },
  };
  const execute = async (args, context) => { calls.push(args); assert.equal(context.isCurrent(), true); return { ok: true, message: 'Synthetic family result' }; };
  async function service(extra = {}) {
    const value = await createFamilySession(api, resources, { persona: 'isolated sister persona', execute, ...extra });
    services.push(value); return value;
  }
  t.after(async () => {
    if (live) finish(live);
    for (const value of services) await value.close();
    assert.equal(JSON.stringify(globalConfig), baseline);
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('family-dsh-session-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, resources, workspaces, registry, creates, selections, variables, tools, guards, calls, inputs, agent,
    service, setBehavior: value => { behavior = value; }, invoke, emit, begin, finish,
    get mode() { return presentation; }, get masked() { return masked; }, get flushes() { return flushes; } };
}

test('DSH family mapping and scope survive a module reload without another session or global changes', async t => {
  const h = await harness(t), first = await h.service();
  await Promise.all([first.ensure(), first.ensure()]);
  assert.equal(h.creates.length, 1);
  assert.equal(h.workspaces[0].path, h.resources.workspaceRoot);
  assert.equal(h.mode, 'native'); assert.equal(h.masked, true);
  assert.deepEqual(first.status().toolNames, ['xiaoai_music']);
  assert.match(h.variables.get('aurabot_persona')(), /^isolated sister persona/);
  assert.equal(h.variables.get('aurabot_rules_social')(), '');
  assert.deepEqual(h.selections.at(-1), { provider: 'isolated-provider', model: 'isolated-model', reasoningEffort: 'low' });
  await first.close();
  assert.equal(h.tools.size, 0);
  assert.equal(h.mode, 'native'); assert.equal(h.masked, true);
  assert.ok(h.guards.some(fn => fn({ name: 'isolated-global-tool' })));
  const second = await h.service(); await second.ensure();
  assert.equal(h.creates.length, 1);
  assert.equal(second.status().sessionId, first.status().sessionId);
  assert.equal(JSON.parse(await readFile(h.resources.sessionFile, 'utf8')).sessionId, h.agent.id);
});

test('two family questions reuse the same DSH session and return only their own completed turns', async t => {
  const h = await harness(t), service = await h.service();
  h.setBehavior(async ({ message }) => message.content[0].text === 'first' ? '第一轮。' : '第二轮。');
  assert.deepEqual(await service.ask('first'), { text: '第一轮。', suppressSpeech: false, toolCalls: 0 });
  assert.deepEqual(await service.ask('second'), { text: '第二轮。', suppressSpeech: false, toolCalls: 0 });
  assert.equal(h.creates.length, 1); assert.equal(h.inputs.length, 2); assert.equal(h.flushes, 2);
  assert.equal(JSON.stringify(service.status()).includes('第二轮'), false);
});

test('read tools allow the spoken answer while successful playback tools suppress a second voice over music', async t => {
  const h = await harness(t), service = await h.service();
  h.setBehavior(async ({ invoke }) => { await invoke({ action: 'catalog' }); await invoke({ action: 'status' }); return '曲库已找到。'; });
  assert.deepEqual(await service.ask('catalog'), { text: '曲库已找到。', suppressSpeech: false, toolCalls: 2 });
  h.setBehavior(async ({ invoke }) => { await invoke({ action: 'play-song', query: 'Synthetic song' }); return '现在开始播放。'; });
  assert.deepEqual(await service.ask('play'), { text: '现在开始播放。', suppressSpeech: true, toolCalls: 1 });
  assert.deepEqual(h.calls.map(item => item.action), ['catalog', 'status', 'play-song']);
});

test('read-only diagnostics deny playback in the backend and count only successful executed tools', async t => {
  const h = await harness(t), service = await h.service();
  h.setBehavior(async ({ invoke }) => {
    const denied = await invoke({ action: 'play-playlist', query: 'Synthetic list' });
    assert.equal(denied.code, 'FAMILY_SESSION_READ_ONLY');
    await invoke({ action: 'catalog' });
    return '只读检查完成。';
  });
  assert.deepEqual(await service.ask('Check only', { readOnly: true }), { text: '只读检查完成。', suppressSpeech: false, toolCalls: 1 });
  assert.deepEqual(h.calls.map(item => item.action), ['catalog']);
});

test('a newer question cancels and drains an old tool turn before it starts the replacement', async t => {
  const h = await harness(t), started = deferred(), release = deferred(), effects = [];
  const service = await h.service({ execute: async (args, context) => {
    started.resolve(); await release.promise;
    if (context.isCurrent()) effects.push(args.action);
    return { ok: context.isCurrent() };
  } });
  h.setBehavior(async ({ message, invoke }) => {
    if (message.content[0].text === 'old') { await invoke({ action: 'play-song', query: 'Synthetic old song' }); return '迟到的旧答复。'; }
    return '新的回答。';
  });
  const old = service.ask('old').catch(error => error);
  await started.promise;
  const replacement = service.ask('new');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.inputs.length, 1);
  release.resolve();
  assert.equal((await old).code, 'FAMILY_SESSION_CANCELLED');
  assert.equal((await replacement).text, '新的回答。');
  assert.deepEqual(effects, []); assert.equal(h.inputs.length, 2);
});

test('direct DSH UI turns may call family tools, but a cancelled old turn cannot be treated as manual', async t => {
  const h = await harness(t), service = await h.service(); await service.ensure();
  const manual = h.begin({ id: 'manual', role: 'user', content: [{ type: 'text', text: 'Synthetic manual' }], source: { kind: 'user' } });
  assert.equal((await h.invoke({ action: 'status' })).ok, true);
  service.cancel();
  assert.equal((await h.invoke({ action: 'play-song', query: 'Synthetic' }, new AbortController().signal)).code, 'FAMILY_SESSION_CANCELLED');
  assert.deepEqual(h.calls.map(item => item.action), ['status']);
  h.finish(manual);
});

test('damaged or foreign-workspace mappings are preserved without opening or modifying another agent', async t => {
  for (const foreign of [false, true]) {
    const h = await harness(t);
    await mkdir(dirname(h.resources.sessionFile), { recursive: true });
    const content = foreign ? JSON.stringify({ schema: 1, sessionId: h.agent.id, workspaceId: 'other-workspace', preset: 'aurabot-social' }) : '{damaged';
    await writeFile(h.resources.sessionFile, content);
    if (foreign) h.workspaces.push({ id: 'other-workspace', path: join(h.root, 'other'), sessionIds: [h.agent.id] });
    const service = await h.service();
    await assert.rejects(service.ensure(), { code: foreign ? 'FAMILY_SESSION_RESOLVE' : 'FAMILY_SESSION_STORAGE' });
    assert.equal(await readFile(h.resources.sessionFile, 'utf8'), content);
    assert.equal(h.creates.length, 0); assert.equal(h.variables.size, 0); assert.equal(h.tools.size, 0);
  }
});

test('unexpected same-agent tools fail scope verification instead of exposing them or falling back', async t => {
  const h = await harness(t, { foreignScopedTool: true }), service = await h.service();
  await assert.rejects(service.ensure(), { code: 'FAMILY_SESSION_SCOPE' });
  assert.deepEqual(service.status().toolNames, []);
  assert.equal(h.mode, 'native'); assert.equal(h.masked, true);
  assert.ok(h.guards.some(fn => fn({ name: 'isolated-foreign-scoped-tool' })));
});

test('current DSH selects the model on the agent and completes a silent text turn', async t => {
  const h = await harness(t, { modernModelSelection: true });
  const service = await h.service();
  await service.ensure();
  assert.deepEqual(await service.ask('Isolated text check', { readOnly: true }),
    { text: '中，我听着呢。', suppressSpeech: false, toolCalls: 0 });
  assert.equal(h.selections.length, 2);
  assert.deepEqual(h.selections[1], { provider: 'isolated-provider', model: 'isolated-model', reasoningEffort: 'low' });
  assert.deepEqual(h.calls, []);
});

test('current DSH rejects an unexpected native executor schema', async t => {
  const h = await harness(t, { modernModelSelection: true, invalidNativeExecutor: true });
  const service = await h.service();
  await assert.rejects(service.ensure(), { code: 'FAMILY_SESSION_SCOPE' });
  assert.deepEqual(h.calls, []);
});
