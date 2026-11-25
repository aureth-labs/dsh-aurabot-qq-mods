import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshFamilyToolBindings } from '../lib/companion/tool-refresh.mjs';

const names = ['xiaoai_music', 'xiaoai_reminder'];
const key = id => id.replace(/^session-/, '');
function tool(name, label = 'old') {
  return { name, description: 'unchanged schema', parameters: { type: 'object' },
    output: { schema: { type: 'object' } }, execute: async () => ({ label, name }) };
}
function harness() {
  const live = [], chats = new Map(), listeners = new Set(), calls = [];
  const global = new Map(names.map(name => [name, tool(name, 'global')]));
  const api = { core: { hub: { chatOfSession: id => chats.get(key(id)) || '' } }, dsh: {
    agents: { list: () => live },
    on(name, fn) { assert.equal(name, 'session/event'); listeners.add(fn); return () => listeners.delete(fn); },
  } };
  const builder = where => {
    calls.push(where);
    return [...names, 'unrelated'].map(name => ({ name,
      execute: async () => ({ label: 'current', name, sessionId: where.sessionId }) }));
  };
  function add(id, chatId) {
    const own = new Map([...names, 'unrelated'].map(name => [name, tool(name)]));
    const registry = { get(name, scope) { return scope ? own.get(name) || global.get(name) : global.get(name); } };
    const agent = { session: { id }, ctx: { tools: registry } };
    live.push(agent); if (chatId) chats.set(key(id), chatId);
    return { agent, own, registry };
  }
  const emit = (id, kind = 'user') => {
    for (const fn of listeners) fn({ id }, { type: 'user/message', data: { source: { kind } } });
  };
  return { api, builder, add, emit, global, calls, listeners };
}

test('existing mapped AuraBot agents receive only the two current execute handlers', async () => {
  const h = harness();
  const { own } = h.add('session-private', 'private:synthetic-owner');
  const saved = new Map(own);
  const oldHandlers = new Map([...own].map(([name, value]) => [name, value.execute]));
  const dispose = refreshFamilyToolBindings(h.api, h.builder);
  assert.deepEqual(h.calls, [{ chat: { kind: 'private' }, level: 'full', sessionId: 'session-private' }]);
  for (const name of names) {
    assert.equal(own.get(name), saved.get(name));
    assert.notEqual(own.get(name).execute, oldHandlers.get(name));
    assert.equal(own.get(name).description, 'unchanged schema');
    assert.equal((await own.get(name).execute()).sessionId, 'session-private');
    assert.equal((await h.global.get(name).execute()).label, 'global');
  }
  assert.equal(own.get('unrelated').execute, oldHandlers.get('unrelated'));
  dispose();
});

test('a newly live agent refreshes on its direct input and QQ events cannot refresh it', async () => {
  const h = harness();
  const dispose = refreshFamilyToolBindings(h.api, h.builder);
  const { own } = h.add('session-new', 'group:synthetic-family');
  h.emit('new', 'aurabot');
  assert.equal((await own.get(names[0]).execute()).label, 'old');
  assert.equal(h.calls.length, 0);
  h.emit('new');
  assert.equal((await own.get(names[0]).execute()).label, 'current');
  assert.equal(h.calls[0].chat.kind, 'group');
  dispose();
});

test('repeated input does not replace an already patched definition again', () => {
  const h = harness(), { own } = h.add('session-repeat', 'private:synthetic');
  const dispose = refreshFamilyToolBindings(h.api, h.builder);
  const installed = own.get(names[0]).execute;
  h.emit('repeat'); h.emit('session-repeat');
  assert.equal(own.get(names[0]).execute, installed);
  dispose();
});

test('missing scoped definitions and inherited global objects stay untouched', async () => {
  const h = harness(), { own } = h.add('session-inherited', 'private:synthetic');
  own.clear();
  const handlers = names.map(name => h.global.get(name).execute);
  const dispose = refreshFamilyToolBindings(h.api, h.builder);
  for (let i = 0; i < names.length; i++) assert.equal(h.global.get(names[i]).execute, handlers[i]);
  assert.equal(own.size, 0);
  dispose();
});

test('family reminder and unmapped dedicated sessions cannot be patched', async () => {
  const h = harness();
  const subjects = [h.add('session-family'), h.add('session-reminder'), h.add('session-system', 'system:synthetic')];
  const dispose = refreshFamilyToolBindings(h.api, h.builder);
  h.emit('family'); h.emit('reminder'); h.emit('system');
  assert.equal(h.calls.length, 0);
  for (const { own } of subjects) assert.equal((await own.get(names[0]).execute()).label, 'old');
  dispose();
});

test('host replacement definitions can be patched without losing their own original handlers', async () => {
  const h = harness(), { own } = h.add('session-replaced', 'group:synthetic');
  const old = own.get(names[0]), oldHandler = old.execute;
  const dispose = refreshFamilyToolBindings(h.api, h.builder);
  const replacement = tool(names[0], 'host-replacement'), replacementHandler = replacement.execute;
  own.set(names[0], replacement);
  h.emit('replaced');
  assert.equal((await replacement.execute()).label, 'current');
  dispose();
  assert.equal(old.execute, oldHandler);
  assert.equal(replacement.execute, replacementHandler);
});

test('closing restores only handlers still owned by this refresh and removes its hook', () => {
  const h = harness(), { own } = h.add('session-closing', 'private:synthetic');
  const original = own.get(names[0]).execute;
  const dispose = refreshFamilyToolBindings(h.api, h.builder);
  const laterHostHandler = async () => ({ label: 'later-host' });
  own.get(names[1]).execute = laterHostHandler;
  dispose(); dispose();
  assert.equal(own.get(names[0]).execute, original);
  assert.equal(own.get(names[1]).execute, laterHostHandler);
  assert.equal(h.listeners.size, 0);
  h.emit('closing');
  assert.equal(own.get(names[0]).execute, original);
});

test('refresh reads event provenance without touching message content', async () => {
  const h = harness();
  const dispose = refreshFamilyToolBindings(h.api, h.builder);
  const { own } = h.add('session-metadata', 'private:synthetic');
  const data = { source: { kind: 'user' } };
  Object.defineProperty(data, 'content', { get() { throw new Error('message content must not be read'); } });
  for (const fn of h.listeners) fn({ id: 'metadata' }, { type: 'user/message', data });
  assert.equal((await own.get(names[0]).execute()).label, 'current');
  dispose();
});
