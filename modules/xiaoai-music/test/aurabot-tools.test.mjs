import test from 'node:test';
import assert from 'node:assert/strict';
import { registerFamilyTools } from '../lib/companion/aurabot-tools.mjs';

function harness() {
  let builder, owner = true, available = true;
  const calls = [], definitions = [], rules = [];
  const api = { tool: fn => { builder = fn; }, rule: fn => rules.push(fn),
    core: { hub: { turnHasOwner: session => { assert.equal(session, 'synthetic-session'); return owner; } } },
    defineTool: value => {
      definitions.push(value);
      assert.equal(Object.hasOwn(value, 'parameters'), false);
      assert.deepEqual(value.required, ['action']);
      assert.ok(value.properties.action.enum.length);
      return value;
    } };
  registerFamilyTools(api, { execute: async (args, options) => { calls.push(['playback', args]); return { ok: options.isCurrent(), songs: [{ id: 'synthetic-song' }] }; },
    remind: async (args, options) => { calls.push(['reminder', args]); return { ok: options.isCurrent(), reminders: [] }; }, available: () => available });
  return { definitions, calls, rules, setOwner: value => { owner = value; }, stop: () => { available = false; },
    build: (chat = { kind: 'private' }, level = 'full') => builder({ chat, level, sessionId: 'synthetic-session' }) };
}

test('AuraBot builds both tools using its properties/required contract and retains structured results', async () => {
  const h = harness(), tools = h.build();
  assert.deepEqual(tools.map(tool => tool.name), ['xiaoai_music', 'xiaoai_reminder']);
  const result = await tools[0].execute({ action: 'catalog' }, {});
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(tools[0].render({}, result)[0].text).songs, [{ id: 'synthetic-song' }]);
  assert.equal((await tools[1].execute({ action: 'list' }, {})).ok, true);
  assert.match(h.rules[0](), /xiaoai_reminder/);
  assert.deepEqual(h.definitions[1].properties.schedule.properties.frequency.enum, ['daily', 'weekly', 'monthly', 'once']);
});

test('cached global tools recheck the current owner and reject background/no-tool contexts', async () => {
  const h = harness(), tools = h.build();
  h.setOwner(false);
  for (const tool of tools) assert.equal((await tool.execute({ action: 'list' }, {})).code, 'FAMILY_OWNER_REQUIRED');
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.build({ kind: 'system' }), []);
  assert.deepEqual(h.build({ kind: 'private' }, 'chat'), []);
  h.setOwner(true);
  assert.equal((await h.build({ kind: 'group' }, 'social')[0].execute({ action: 'status' }, {})).ok, true);
  const controller = new AbortController(); controller.abort();
  assert.equal((await tools[0].execute({ action: 'stop' }, { signal: controller.signal })).cancelled, true);
  h.stop();
  assert.equal((await tools[0].execute({ action: 'status' }, {})).code, 'FAMILY_MODULE_UNAVAILABLE');
  assert.equal(h.calls.length, 1);
});

function directExecution(kind = 'user') {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind } } },
    { type: 'tool/call', data: { turn: 1, callId: 'synthetic-call' } },
  ];
  return { callId: 'synthetic-call', signal: new AbortController().signal,
    agent: { session: { id: 'synthetic-session', seq: events.length, eventAt: index => events[index] } } };
}

test('native DSH committed calls work without the Hub in-memory owner mapping', async () => {
  const h = harness(), tools = h.build();
  h.setOwner(false);
  for (const tool of tools) assert.equal((await tool.execute({ action: 'list' }, directExecution())).ok, true);
  assert.equal(h.calls.length, 2);
});

test('QQ and arbitrary agent calls retain the owner restriction', async () => {
  const h = harness(), tool = h.build()[0];
  h.setOwner(false);
  for (const exec of [directExecution('aurabot'), { agent: { session: { id: 'synthetic-session' } } }]) {
    assert.equal((await tool.execute({ action: 'catalog' }, exec)).code, 'FAMILY_OWNER_REQUIRED');
  }
  assert.deepEqual(h.calls, []);
  h.stop();
  assert.equal((await tool.execute({ action: 'catalog' }, directExecution())).code, 'FAMILY_MODULE_UNAVAILABLE');
});
