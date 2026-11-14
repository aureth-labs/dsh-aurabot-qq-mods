import test from 'node:test';
import assert from 'node:assert/strict';
import { searchProvider, readProvider, context7Request, endpoint, searxngEndpoint, providerStatus } from '../lib/providers.mjs';
import { options } from '../lib/options.mjs';
import { response, harness } from './helpers.mjs';
import { createServer } from 'node:http';
const input = { query: 'test', limit: 5, domains: ['example.com'], recency: 'week' };
const s = options({ tavilyApiKey: 'fixture', exaApiKey: 'fixture', zhipuApiKey: 'fixture', firecrawlApiKey: 'fixture', searxngUrl: 'http://localhost:8080/searx/', searxngEngines: 'bing,google' });
const signal = () => AbortSignal.timeout(5000);
test('provider contracts: bodies, auth, custom base URLs, recency and source mapping', async () => {
  const fixtures = {
    tavily: { results: [{ url: 'https://example.com', content: 'snippet' }] },
    exa: { results: [{ url: 'https://example.com', text: 'snippet' }] },
    zhipu: { search_result: [{ link: 'https://example.com', content: 'snippet' }] },
    firecrawl: { success: true, data: { web: [{ url: 'https://example.com', description: 'snippet' }] } },
    searxng: { results: [{ url: 'https://example.com', content: 'snippet' }], unresponsive_engines: [['bing', 'timeout']] },
  };
  for (const [id, fixture] of Object.entries(fixtures)) {
    const fetcher = async (url, init) => {
      assert.equal(init.redirect, 'error');
      if (id === 'searxng') {
        assert.equal(url.origin, 'http://localhost:8080'); assert.equal(url.pathname, '/searx/search');
        assert.equal(url.searchParams.get('format'), 'json'); assert.equal(url.searchParams.get('engines'), 'bing,google');
        assert.equal(url.searchParams.get('time_range'), 'month');
      } else {
        const body = JSON.parse(init.body);
        if (id === 'tavily') { assert.equal(body.search_depth, 'basic'); assert.equal(body.include_answer, false); assert.equal(body.time_range, 'week'); }
        if (id === 'exa') { assert.equal(body.type, 'auto'); assert.ok(body.startPublishedDate); }
        if (id === 'zhipu') { assert.equal(body.search_recency_filter, 'oneWeek'); assert.equal(body.search_engine, 'search_std'); }
        assert.ok(init.headers.Authorization || init.headers['x-api-key']);
      }
      return response(fixture);
    };
    const result = await searchProvider(id, input, s, {}, signal(), fetcher);
    assert.equal(result.sources[0].snippet, 'snippet');
  }
});
test('configured relay paths remain intact and credentials never follow redirects', async () => {
  const cfg = { ...s, tavilyUrl: 'https://relay.example/api/tavily/' };
  await searchProvider('tavily', input, cfg, {}, signal(), async (url, init) => {
    assert.equal(url, 'https://relay.example/api/tavily/search'); assert.equal(init.redirect, 'error'); return response({ results: [] });
  });
  assert.throws(() => endpoint('http://example.com', '/search'), { code: 'setup' });
  assert.throws(() => endpoint('https://user:pass@example.com', '/search'), { code: 'setup' });
});
test('HTTP errors, embedded Zhipu errors, malformed JSON and oversized bodies are safe', async () => {
  for (const [status, code] of [[401, 'auth'], [429, 'limit'], [500, 'network']]) {
    await assert.rejects(searchProvider('tavily', input, s, {}, signal(), async () => new Response('SECRET', { status })), { code });
  }
  await assert.rejects(searchProvider('zhipu', input, s, {}, signal(), async () => response({ error: { code: '1002', message: 'SECRET' } })), { code: 'auth' });
  await assert.rejects(searchProvider('exa', input, s, {}, signal(), async () => new Response('not json')), { code: 'format' });
  await assert.rejects(searchProvider('exa', input, s, {}, signal(), async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))), { code: 'size' });
});
test('SearXNG requires JSON and accepts only administrator-selected base paths', async () => {
  assert.equal(searxngEndpoint('https://search.example/search').pathname, '/search');
  assert.throws(() => searxngEndpoint('file:///etc/passwd'), { code: 'searxng' });
  await assert.rejects(searchProvider('searxng', input, s, {}, signal(), async () => new Response('<html>blocked</html>', { status: 403 })), { code: 'searxng' });
});
test('Zhipu never silently truncates a query', async () => {
  await assert.rejects(searchProvider('zhipu', { ...input, query: '字'.repeat(71) }, s, {}, signal(), async () => { throw Error('must not send'); }), { code: 'zhipuQuery' });
});
test('page extraction maps Tavily, Exa and Firecrawl actual response shapes', async () => {
  for (const [id, fixture] of Object.entries({ tavily: { results: [{ raw_content: 'text' }] }, exa: { results: [{ text: 'text' }] }, firecrawl: { success: true, data: { markdown: 'text' } } })) {
    const result = await readProvider(id, 'https://example.com/', s, signal(), async () => response(fixture)); assert.equal(result.content, 'text');
  }
});
test('DSH readiness checks provider selection, not only its optimistic searchReady', async () => {
  const h = harness({}, { search() {}, searchReady: async () => true, selectSearchProvider: () => { throw Error('unavailable'); } });
  assert.equal((await providerStatus(h.api, s)).find(x => x.id === 'dsh').ready, false);
});
test('Context7 explicitly requests JSON; Accept alone does not select its format', async () => {
  await context7Request({ libraryId: '/reactjs/react.dev', query: 'cleanup' }, { ...s, context7ApiKey: 'fixture' }, signal(), async url => {
    assert.equal(url.searchParams.get('type'), 'json'); return response({ codeSnippets: [] });
  });
});
test('SearXNG uses its configured local instance over real HTTP without redirecting', async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.pathname, '/search'); assert.equal(url.searchParams.get('format'), 'json');
    assert.match(url.searchParams.get('q'), /site:example.com/);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ results: [{ url: 'https://example.com/', content: 'local fixture' }] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const result = await searchProvider('searxng', input, { ...s, searxngUrl: 'http://127.0.0.1:' + server.address().port }, {}, signal());
    assert.equal(result.sources[0].snippet, 'local fixture');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
