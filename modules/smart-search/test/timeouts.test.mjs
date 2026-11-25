import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearch } from '../lib/search.mjs';
import { harness, response } from './helpers.mjs';
test('a hanging parallel channel times out without discarding completed evidence', async () => {
  const h = harness({ sources: ['dsh', 'tavily'], tavilyApiKey: 'fixture', timeoutSeconds: 5 });
  const service = createSearch(h.api, { fetcher: () => new Promise(() => {}) });
  try {
    const result = await service.run('search', { query: 'test', mode: 'verify' });
    assert.equal(result.ok, true); assert.equal(result.partial, true); assert.equal(result.sources.length, 1);
    assert.equal(result.attempts.find(x => x.provider === 'tavily').code, 'timeout');
  } finally { service.dispose(); }
});
test('quick search reserves enough of its deadline for a different enabled source', async () => {
  const h = harness({ sources: ['dsh', 'tavily'], tavilyApiKey: 'fixture', timeoutSeconds: 5 }, { search: () => new Promise(() => {}) });
  const service = createSearch(h.api, { fetcher: async () => response({ results: [{ url: 'https://example.com/', content: 'second source' }] }) });
  try {
    const result = await service.run('search', { query: 'test' });
    assert.equal(result.ok, true); assert.equal(result.attempts[0].code, 'timeout');
    assert.equal(result.sources[0].providers[0], 'tavily');
  } finally { service.dispose(); }
});
