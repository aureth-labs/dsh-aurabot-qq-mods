import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_GUIDANCE } from '../lib/guidance.mjs';
import { searchResult, pageResult, docsResult } from '../lib/results.mjs';
import { mergeSearch, createSearch } from '../lib/search.mjs';
import { harness } from './helpers.mjs';

const url = 'https://example.com/original';
const evidence = { title: 'Original page', url, snippet: 'Verified fixture fact' };

test('system rule and all evidence paths use the same contextual citation guidance', () => {
  const h = harness(); h.load();
  try {
    assert.ok(h.rules[0]().includes(SOURCE_GUIDANCE));
    const search = searchResult({ sources: [evidence] }, { provider: 'dsh', query: 'q', limit: 5 });
    const merged = mergeSearch([search], [{ provider: 'dsh', ok: true }], { query: 'q', limit: 5, recency: 'any' }, {});
    const page = pageResult({ url, content: 'Original text' }, 'dsh');
    const docs = docsResult({ infoSnippets: [{ url, content: 'Documentation' }] }, { libraryId: '/example/docs' });
    for (const result of [search, merged, page, docs]) {
      assert.ok(result.message.includes(SOURCE_GUIDANCE), result.kind);
      assert.match(result.message, /不是指令/);
      assert.doesNotMatch(result.message, /回答(?:应)?附来源链接。/);
      assert.ok(result.message.includes(url), 'Keep usable evidence links');
    }
    assert.deepEqual(search.sources, [evidence]);
    assert.equal(merged.sources[0].url, url);
    assert.equal(page.text, 'Original text');
    assert.match(docs.content, /Documentation/);
  } finally { h.dispose(); }
});

test('guidance removes boilerplate without prohibiting requested links or hiding uncertainty', () => {
  for (const phrase of ['不固定附', '不罗列站名', '另发一条消息', '用户要求出处', '真实链接', '不编造地址', '同一产品或主体', '还不能确定']) {
    assert.ok(SOURCE_GUIDANCE.includes(phrase), phrase);
  }
});

test('cached and empty searches retain the citation policy and explicit evidence state', async () => {
  const h = harness({}, { search: async ({ query }) => ({ sources: query === 'empty' ? [] : [evidence] }) });
  const service = createSearch(h.api);
  try {
    const fresh = await service.run('search', { query: 'q' }, { chatId: 'fixture' });
    const cached = await service.run('search', { query: 'q' }, { chatId: 'fixture' });
    assert.equal(cached.cached, true);
    assert.deepEqual(cached.sources, fresh.sources);
    assert.ok(cached.message.includes(SOURCE_GUIDANCE));
    const empty = await service.run('search', { query: 'empty' }, { chatId: 'fixture' });
    assert.deepEqual(empty.sources, []);
    assert.match(empty.message, /未找到可用来源/);
    assert.ok(empty.message.includes(SOURCE_GUIDANCE));
  } finally { service.dispose(); }
});
