import test from 'node:test';
import assert from 'node:assert/strict';
import { isDirectDshCall } from '../lib/companion/dsh-source.mjs';

const event = (type, data) => ({ type, data });
const turnStart = turn => event('turn/start', { turn });
const input = kind => event('user/message', { ...(kind ? { source: { kind } } : {}) });
const call = (turn = 1, callId = 'synthetic-call', name = 'xiaoai_reminder') => event('tool/call', { turn, callId, name });
const nativeTurn = () => [turnStart(1), input('user'), call()];
function execution(events, overrides = {}) {
  const controller = new AbortController();
  const session = { id: 'session-synthetic-native', get seq() { return events.length; }, eventAt: seq => events[seq] };
  return { exec: { name: 'xiaoai_reminder', callId: 'synthetic-call', signal: controller.signal,
    agent: { session }, ...overrides }, controller, session };
}

test('a direct DSH turn requires its committed call and normalized bound session', () => {
  const { exec } = execution(nativeTurn());
  assert.equal(isDirectDshCall(exec, 'synthetic-native'), true);
  assert.equal(isDirectDshCall(exec, 'session-synthetic-native'), true);
  assert.equal(isDirectDshCall(exec, 'different-session'), false);
  assert.equal(isDirectDshCall(exec, ''), false);
  assert.equal(isDirectDshCall({ ...exec, callId: 'uncommitted-call' }, 'synthetic-native'), false);
  assert.equal(isDirectDshCall({ ...exec, callId: undefined }, 'synthetic-native'), false);
});

test('Code Mode nested dispatch binds to the committed root call', () => {
  const { exec } = execution([turnStart(1), input('user'), call(1, 'code-root', 'run_code')], {
    callId: 'nested-call', rootCallId: 'code-root',
  });
  assert.equal(isDirectDshCall(exec, 'synthetic-native'), true);
  assert.equal(isDirectDshCall({ ...exec, rootCallId: 'uncommitted-root' }, 'synthetic-native'), false);
});

test('QQ forwarded plugin cron and absent provenance cannot impersonate a direct user', () => {
  for (const kind of ['aurabot', 'plugin', 'cron', undefined]) {
    const { exec } = execution([turnStart(1), input(kind), call()]);
    assert.equal(isDirectDshCall(exec, 'synthetic-native'), false, String(kind));
  }
});

test('completed native history and an old call cannot authorize a new turn', () => {
  const ended = [...nativeTurn(), event('turn/end', { turn: 1, reason: { kind: 'completed' } })];
  assert.equal(isDirectDshCall(execution(ended).exec, 'synthetic-native'), false);
  const nextTurn = [...ended, turnStart(2), input('user')];
  assert.equal(isDirectDshCall(execution(nextTurn).exec, 'synthetic-native'), false);
  nextTurn.push(call(2, 'new-call'));
  assert.equal(isDirectDshCall(execution(nextTurn, { callId: 'new-call' }).exec, 'synthetic-native'), true);
  assert.equal(isDirectDshCall(execution([turnStart(2), input('user'), call(1)]).exec, 'synthetic-native'), false);
});

test('past direct provenance cannot authorize a current remote turn', () => {
  const events = [...nativeTurn(), event('turn/end', { turn: 1 }), turnStart(2), input('aurabot'), call(2, 'remote-call')];
  const { exec } = execution(events, { callId: 'remote-call' });
  assert.equal(isDirectDshCall(exec, 'synthetic-native'), false);
});

test('cancellation and turn completion immediately revoke an existing execution', () => {
  const events = nativeTurn();
  const { exec, controller } = execution(events);
  assert.equal(isDirectDshCall(exec, 'synthetic-native'), true);
  controller.abort();
  assert.equal(isDirectDshCall(exec, 'synthetic-native'), false);
  const active = execution(events);
  assert.equal(isDirectDshCall(active.exec, 'synthetic-native'), true);
  events.push(event('turn/end', { turn: 1 }));
  assert.equal(isDirectDshCall(active.exec, 'synthetic-native'), false);
});

test('an arbitrary agent or unavailable session log is insufficient', () => {
  const { exec } = execution(nativeTurn());
  for (const agent of [undefined, { id: 'synthetic-native' }, { session: { id: 'synthetic-native' } },
    { session: { id: 'synthetic-native', seq: 1, eventAt() { throw new Error('isolated unavailable log'); } } }]) {
    assert.equal(isDirectDshCall({ ...exec, agent }, 'synthetic-native'), false);
  }
  assert.equal(isDirectDshCall({ ...exec, signal: undefined }, 'synthetic-native'), false);
  assert.equal(isDirectDshCall(execution([]).exec, 'synthetic-native'), false);
  assert.equal(isDirectDshCall(execution([input('user'), call()]).exec, 'synthetic-native'), false);
});

test('provenance inspection never reads text content or tool arguments', () => {
  const message = input('user');
  Object.defineProperty(message.data, 'content', { get() { throw new Error('message content must not be read'); } });
  const tool = call();
  Object.defineProperty(tool.data, 'arguments', { get() { throw new Error('tool arguments must not be read'); } });
  assert.equal(isDirectDshCall(execution([turnStart(1), message, tool]).exec, 'synthetic-native'), true);
});
