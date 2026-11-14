import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, req } from './helpers.mjs';
import { localRequest } from '../index.mjs';

test('native tools and rules are registered, without message interception or global tools', () => {
  const h = harness(); h.load();
  assert.deepEqual(h.tools().map(t => t.name), ['qq_web_search', 'qq_read_webpage', 'qq_search_docs']);
  assert.match(h.rules[0](), /不要求用户/); assert.equal(h.events.message, undefined);
  assert.equal(h.secrets.length, 6); h.dispose();
});
test('search guidance balances uncertain facts, reuse and non-search tasks', () => {
  const h = harness(); h.load();
  const rule = h.rules[0]();
  for (const text of ['拿不准', '仅改写或翻译已有内容无需搜索', '有具体证据缺口才补查', '优先复用本轮', '权限、配置或额度错误时停止调用']) assert.ok(rule.includes(text));
  h.set({ enabled: false }); assert.equal(h.rules[0](), ''); h.dispose();
});
test('system/chat-only/other private chats receive no tools', () => {
  const h = harness(); h.load();
  assert.equal(h.tools('system').length, 0); assert.equal(h.tools('group', 'owner', 'chat').length, 0);
  assert.equal(h.tools('private', 'other').length, 0);
  h.set({ groups: '99999' }); assert.equal(h.tools().length, 0); h.dispose();
});
test('owner-only is enforced at execution, including mixed-owner group turns', async () => {
  let calls = 0; const h = harness({}, { search: async () => { calls++; return { sources: [] }; } }); h.load();
  const tool = h.tools()[0]; h.owner(false);
  assert.equal((await tool.execute({ query: 'test' })).code, 'forbidden'); assert.equal(calls, 0);
  h.owner(true); assert.equal((await tool.execute({ query: 'test' })).ok, true); assert.equal(calls, 1); h.dispose();
});
test('stale tools honor changed scope, enablement and disposal', async () => {
  const h = harness(); h.load(); const tool = h.tools()[0];
  h.set({ enabled: false }); assert.equal((await tool.execute({ query: 'test' })).code, 'disabled');
  h.set({ enabled: true, groups: '999' }); assert.equal((await tool.execute({ query: 'test' })).code, 'scope');
  h.set({ groups: '' }); h.dispose(); assert.equal((await tool.execute({ query: 'test' })).ok, false);
});
test('settings change aborts in-flight work and does not release a late result', async () => {
  let finish; const h = harness({}, { search: () => new Promise(r => { finish = r; }) }); h.load();
  const promise = h.tools()[0].execute({ query: 'test' });
  await new Promise(r => setImmediate(r)); h.set({ ownerOnly: false });
  assert.equal((await promise).code, 'aborted');
  finish({ sources: [] }); h.dispose();
});
test('panel routes reject remote requests, cross-origin, DNS rebinding and non-JSON mutations', () => {
  assert.doesNotThrow(() => localRequest(req()));
  for (const r of [
    { ...req(), socket: { remoteAddress: '192.168.1.2' } },
    { ...req(), headers: { host: 'attacker.example' } },
    { ...req(), headers: { host: '127.0.0.1:12345', origin: 'https://attacker.example' } },
  ]) assert.throws(() => localRequest(r), { code: 'local' });
  assert.throws(() => localRequest(req(), true), { code: 'request' });
  assert.throws(() => localRequest({ ...req('POST'), headers: { host: 'localhost', 'content-type': 'text/plain' } }, true), { code: 'request' });
});
test('status and errors contain no credentials, raw exceptions or query history', async () => {
  const secret = 'fixture-secret-do-not-print';
  const h = harness({ tavilyApiKey: secret }, { search: async () => { throw Error('C:/private/key=' + secret); } }); h.load();
  const value = await h.tools()[0].execute({ query: 'private query' });
  const status = await h.routes['/status'](req());
  assert.equal(value.ok, false); assert.doesNotMatch(JSON.stringify([value, status, h.logs]), /fixture-secret|C:\/private|private query/); h.dispose();
});
test('panel test uses same validated search path and sends no messages', async () => {
  const h = harness(); h.load();
  assert.equal((await h.routes['/test'](req('POST', { query: '' }))).code, 'query');
  const result = await h.routes['/test'](req('POST', { query: 'example' }));
  assert.equal(result.sources.length, 1); h.dispose();
});
