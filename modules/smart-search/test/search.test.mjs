import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearch, parseSearch, routeSources } from '../lib/search.mjs';
import { options } from '../lib/options.mjs';
import { harness, response } from './helpers.mjs';
const configured = { sources: ['dsh', 'tavily', 'exa'], tavilyApiKey: 'fixture', exaApiKey: 'fixture' };
test('query, domains, recency and result limits are validated', () => {
  for (const query of ['', ' ', 123, 'x'.repeat(501)]) assert.throws(() => parseSearch({ query }, options()), { code: 'query' });
  assert.throws(() => parseSearch({ query: 'ok', domains: ['example.com/path'] }, options()), { code: 'domains' });
  assert.throws(() => parseSearch({ query: 'ok', recency: 'hour' }, options()), { code: 'recency' });
  assert.equal(parseSearch({ query: 'ok', limit: 100 }, options()).limit, 5);
});
test('routing prefers appropriate channels and excludes Context7 from ordinary search', () => {
  const s = options({ ...configured, sources: ['dsh', 'zhipu', 'context7', 'exa', 'tavily'] });
  assert.equal(routeSources(s.sources, { query: '最新中文消息' }, {}, s).candidates[0], 'zhipu');
  assert.equal(routeSources(s.sources, { query: 'React API documentation' }, {}, s).candidates[0], 'exa');
  assert.equal(routeSources(s.sources, { query: 'latest news' }, {}, s).candidates[0], 'tavily');
  assert.throws(() => routeSources(s.sources, { query: 'q' }, { sources: ['context7'] }, s), { code: 'source' });
  assert.throws(() => routeSources(s.sources, { query: 'q' }, { sources: ['firecrawl'] }, s), { code: 'source' });
});
test('quick mode calls one source; cache is bounded and isolated by chat', async () => {
  let calls = 0; const h = harness(configured, { search: async () => { calls++; return { sources: [{ url: 'https://example.com/', title: 'Example' }] }; } });
  const service = createSearch(h.api);
  assert.equal((await service.run('search', { query: 'hello' }, { chatId: 'a' })).sources.length, 1);
  assert.equal((await service.run('search', { query: 'hello' }, { chatId: 'a' })).cached, true);
  await service.run('search', { query: 'hello' }, { chatId: 'b' }); assert.equal(calls, 2); service.dispose();
});
test('verify runs concurrently, merges round-robin, keeps source provenance and deduplicates URLs', async () => {
  const h = harness(configured, { search: async () => ({ sources: [{ url: 'https://example.com/shared' }, { url: 'https://example.com/dsh' }] }) });
  const service = createSearch(h.api, { fetcher: async () => response({ results: [{ url: 'https://example.com/shared', content: 'same' }, { url: 'https://example.com/tavily' }] }) });
  const result = await service.run('search', { query: 'hello', mode: 'verify' });
  assert.equal(result.attempts.length, 2); assert.equal(result.sources.length, 3);
  assert.deepEqual(result.sources[0].providers, ['dsh', 'tavily']); service.dispose();
});
test('one failed source retains successful results and reports partial failure safely', async () => {
  const h = harness(configured); const service = createSearch(h.api, { fetcher: async () => new Response('secret error', { status: 401 }) });
  const result = await service.run('search', { query: 'hello', mode: 'verify' });
  assert.equal(result.ok, true); assert.equal(result.partial, true); assert.equal(result.sources.length, 1);
  assert.equal(result.attempts[1].code, 'auth'); assert.doesNotMatch(result.message, /secret error/); service.dispose();
});
test('failover only uses enabled sources within the cap, and is disabled in economy mode', async () => {
  for (const strategy of ['adaptive', 'economy']) {
    let calls = 0; const h = harness({ ...configured, strategy }, { search: async () => { throw Error('failed'); } });
    const service = createSearch(h.api, { fetcher: async () => { calls++; return response({ results: [{ url: 'https://example.com/' }] }); } });
    const result = await service.run('search', { query: 'hello' });
    assert.equal(calls, strategy === 'adaptive' ? 1 : 0); assert.equal(result.ok, strategy === 'adaptive'); service.dispose();
  }
});
test('explicit sources never expand to unrequested channels', async () => {
  let calls = 0; const h = harness(configured, { search: async () => { throw Error('failed'); } });
  const service = createSearch(h.api, { fetcher: async () => { calls++; return response({ results: [] }); } });
  const result = await service.run('search', { query: 'hello', sources: ['dsh'] });
  assert.equal(result.ok, false); assert.equal(calls, 0); service.dispose();
});
test('empty results may change source but stay explicit if all return empty', async () => {
  const h = harness(configured, { search: async () => ({ sources: [] }) });
  const service = createSearch(h.api, { fetcher: async () => response({ results: [] }) });
  const result = await service.run('search', { query: 'hello' });
  assert.equal(result.ok, true); assert.equal(result.sources.length, 0); assert.equal(result.attempts.length, 2); service.dispose();
});
test('request quota counts per provider and retains results when another source hits quota', async () => {
  let calls = 0; const h = harness({ ...configured, hourlyLimit: 1 });
  const service = createSearch(h.api, { fetcher: async () => { calls++; return response({ results: [] }); } });
  const result = await service.run('search', { query: 'hello', mode: 'verify' });
  assert.equal(result.ok, true); assert.equal(result.partial, true); assert.equal(calls, 0);
  const next = await service.run('search', { query: 'another' }); assert.equal(next.code, 'quota'); service.dispose();
});
test('concurrent capacity and cancellation are enforced, even if upstream ignores abort', async () => {
  const h = harness({}, { search: () => new Promise(() => {}) }); const service = createSearch(h.api);
  const waiting = [1, 2, 3].map(n => service.run('search', { query: String(n) }));
  const fourth = await service.run('search', { query: 'four' }); assert.equal(fourth.code, 'busy');
  service.dispose(); assert.ok((await Promise.all(waiting)).every(x => !x.ok));
});
test('direct reads reject private destinations before invoking transport', async () => {
  let called = false; const h = harness(); const service = createSearch(h.api, { pageReader: async () => { called = true; } });
  assert.equal((await service.run('read', { url: 'http://127.0.0.1/secret' })).code, 'url'); assert.equal(called, false); service.dispose();
});
test('default page reading prefers an enabled direct channel over paid extraction', async () => {
  let paid = 0, direct = 0;
  const h = harness({ sources: ['tavily', 'searxng'], tavilyApiKey: 'fixture', searxngUrl: 'http://localhost:8080' });
  const service = createSearch(h.api, {
    pageReader: async url => { direct++; return { url, content: 'direct text' }; },
    fetcher: async () => { paid++; return response({ results: [{ raw_content: 'paid text' }] }); },
  });
  try {
    const result = await service.run('read', { url: 'https://example.com/' });
    assert.equal(result.provider, 'searxng'); assert.equal(direct, 1); assert.equal(paid, 0);
    const explicit = await service.run('read', { url: 'https://example.com/', source: 'tavily' });
    assert.equal(explicit.provider, 'tavily'); assert.equal(paid, 1);
  } finally { service.dispose(); }
});
test('Context7 library lookup and document reads stay in their capability family', async () => {
  const h = harness({ sources: ['context7'], context7ApiKey: 'fixture' }); let calls = 0;
  const service = createSearch(h.api, { fetcher: async url => { calls++; return response(String(url).includes('/libs/search')
    ? { results: [{ id: '/facebook/react', title: 'React' }] } : { codeSnippets: [{ code: 'useEffect()', url: 'https://react.dev/' }] }); } });
  assert.equal((await service.run('search', { query: 'news' })).code, 'setup');
  assert.equal((await service.run('docs', { query: 'cleanup', library: 'react' })).kind, 'libraries');
  assert.equal((await service.run('docs', { query: 'cleanup', libraryId: '/facebook/react' })).kind, 'docs');
  assert.equal(calls, 2); service.dispose();
});
