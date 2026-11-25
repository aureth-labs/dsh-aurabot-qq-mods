import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchError, failure } from '../lib/errors.mjs';
import { createSearch } from '../lib/search.mjs';
import { harness, response, req } from './helpers.mjs';

// Synthetic diagnostics only; never use actual credentials or host files.
const diagnostic = 'fixture-secret-key C:\\Users\\Fixture\\private.txt /root/fixture/private.txt \\\\wsl.localhost\\Ubuntu\\root\\fixture\n    at fixture (file:///root/fixture/index.mjs:42:1)';
const privateText = /fixture-secret|C:\\Users|\/root\/fixture|wsl\.localhost|at fixture|file:\/\//;
function safe(value) { assert.doesNotMatch(JSON.stringify(value), privateText); }
const configured = { sources: ['dsh', 'tavily'], tavilyApiKey: 'fixture' };

test('error output is an allowlisted message, not mutable exception diagnostics', () => {
  const own = new SearchError('timeout'); own.message = diagnostic; own.stack = diagnostic;
  assert.deepEqual(failure(own), { ok: false, code: 'timeout', message: '搜索等待超时，请稍后再试。' });
  own.code = diagnostic; safe(failure(own)); assert.equal(failure(own).code, 'network');
  for (const code of ['__proto__', 'constructor', 'toString', undefined, diagnostic]) {
    assert.equal(new SearchError(code).code, 'network'); safe(failure(new SearchError(code)));
  }
  for (const error of [new Error(diagnostic), { message: diagnostic, code: diagnostic, stack: diagnostic }, diagnostic, null]) safe(failure(error));
  assert.equal(failure({ name: 'AbortError', message: diagnostic }).code, 'aborted');
  assert.equal(failure({ code: 'WEB_FETCH_TIMEOUT', message: diagnostic }).code, 'timeout');
});

test('a failed first source can fall back without exposing its exception in results, status or logs', async () => {
  const h = harness(configured, { search: async () => { throw new Error(diagnostic); } });
  const service = createSearch(h.api, { fetcher: async () => response({ results: [{ url: 'https://example.com/', content: 'verified source' }] }) });
  try {
    const result = await service.run('search', { query: 'hello' }, { chatId: 'same-chat' });
    assert.equal(result.ok, true); assert.equal(result.partial, true);
    assert.deepEqual(result.attempts.map(x => [x.provider, x.ok]), [['dsh', false], ['tavily', true]]);
    safe([result, await service.status(), h.logs]);
  } finally { service.dispose(); }
});

test('all-source failure is bounded, not cached, and the next request in the same chat succeeds', async () => {
  let recovered = false, dshCalls = 0, apiCalls = 0;
  const h = harness(configured, { search: async () => {
    dshCalls++;
    if (!recovered) throw new Error(diagnostic);
    return { sources: [{ url: 'https://example.com/' }] };
  } });
  const service = createSearch(h.api, { fetcher: async () => { apiCalls++; return new Response(diagnostic, { status: 503 }); } });
  try {
    const failed = await service.run('search', { query: 'hello' }, { chatId: 'same-chat' });
    assert.equal(failed.ok, false); assert.equal(failed.attempts.length, 2);
    assert.equal((await service.status()).active, 0); safe([failed, await service.status(), h.logs]);
    recovered = true;
    const next = await service.run('search', { query: 'hello' }, { chatId: 'same-chat' });
    assert.equal(next.ok, true); assert.equal(next.cached, undefined);
    assert.equal(dshCalls, 2); assert.equal(apiCalls, 1); assert.equal((await service.status()).active, 0);
  } finally { service.dispose(); }
});

test('public tool and panel failures remain structured results and do not throw diagnostics', async () => {
  let recovered = false;
  const h = harness({}, { search: async () => {
    if (!recovered) throw new Error(diagnostic);
    return { sources: [{ url: 'https://example.com/' }] };
  } }); h.load();
  try {
    const tool = h.tools()[0];
    const failed = await tool.execute({ query: 'hello' });
    assert.equal(failed.ok, false);
    const panel = await h.routes['/test'](req('POST', { query: 'hello' }));
    assert.equal(panel.ok, false); safe([failed, panel, await h.routes['/status'](req()), h.logs]);
    recovered = true; assert.equal((await tool.execute({ query: 'hello' })).ok, true);
  } finally { h.dispose(); }
});

test('read and Context7 errors never expose raw HTTP bodies or local exceptions', async () => {
  const h = harness({ sources: ['dsh', 'context7'], context7ApiKey: 'fixture' });
  const service = createSearch(h.api, {
    pageReader: async () => { throw new Error(diagnostic); },
    fetcher: async () => response({ error: { code: '401', message: diagnostic, stack: diagnostic } }),
  });
  try {
    const read = await service.run('read', { url: 'https://example.com/' });
    const docs = await service.run('docs', { library: 'react', query: 'cleanup' });
    assert.equal(read.ok, false); assert.equal(docs.code, 'auth');
    safe([read, docs, await service.status(), h.logs]); assert.equal((await service.status()).active, 0);
  } finally { service.dispose(); }
});

test('caller cancellation does not trigger fallback or poison the next request', async () => {
  let entered; const started = new Promise(r => { entered = r; }); let recover = false, apiCalls = 0;
  const h = harness(configured, { search: async () => {
    if (recover) return { sources: [{ url: 'https://example.com/' }] };
    entered(); return new Promise(() => {});
  } });
  const service = createSearch(h.api, { fetcher: async () => { apiCalls++; return response({ results: [] }); } });
  try {
    const controller = new AbortController();
    const pending = service.run('search', { query: 'hello' }, { chatId: 'same-chat', signal: controller.signal });
    await started; controller.abort(new DOMException(diagnostic, 'AbortError'));
    const result = await pending; assert.equal(result.code, 'aborted'); safe(result);
    assert.equal(apiCalls, 0); assert.equal((await service.status()).active, 0);
    recover = true;
    assert.equal((await service.run('search', { query: 'hello' }, { chatId: 'same-chat' })).ok, true);
  } finally { service.dispose(); }
});

test('disabled DSH readiness cannot block an enabled independent search source', async () => {
  let checked = false;
  const h = harness({ sources: ['tavily'], tavilyApiKey: 'fixture' }, {
    search() {}, searchReady: async () => { checked = true; return true; },
  });
  const service = createSearch(h.api, { fetcher: async () => response({ results: [{ url: 'https://example.com/' }] }) });
  try {
    assert.equal((await service.run('search', { query: 'hello' })).ok, true);
    assert.equal(checked, false);
  } finally { service.dispose(); }
});
