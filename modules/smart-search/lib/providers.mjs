import { SearchError } from './errors.mjs';
import { publicUrl, readPublicPage } from './public-web.mjs';
import { PROVIDERS } from './options.mjs';

export function endpoint(base, path) {
  let url;
  try { url = new URL(String(base).trim().replace(/\/+$/, '') + path); } catch { throw new SearchError('setup'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new SearchError('setup');
  return url.href;
}

export function getWeb(api) {
  try { return api.dsh?.get('web'); } catch { return undefined; }
}
export function searxngEndpoint(input) {
  let url;
  try { url = new URL(String(input)); } catch { throw new SearchError('searxng'); }
  // This is an administrator-selected service, not a model-supplied URL.
  // Local/self-hosted instances are deliberately supported. No redirects.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new SearchError('searxng');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/search$/, '') + '/search';
  return url;
}
export async function providerStatus(api, settings) {
  let dsh = false;
  const web = getWeb(api);
  if (settings.sources.includes('dsh') && typeof web?.search === 'function') {
    try {
      // searchReady alone returns true on selection failure in current DSH.
      web.selectSearchProvider?.();
      dsh = (await web.searchReady?.()) !== false;
    } catch { dsh = false; }
  }
  let searxng = false;
  try { searxngEndpoint(settings.searxngUrl); searxng = true; } catch {}
  return Object.keys(PROVIDERS).map(id => ({ id, name: PROVIDERS[id],
    enabled: settings.sources.includes(id),
    ready: id === 'dsh' ? dsh : id === 'searxng' ? searxng : Boolean(settings[id + 'ApiKey']?.trim()),
  }));
}

async function jsonPost(url, headers, payload, signal, fetcher) {
  const response = await fetcher(url, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload), signal });
  return responseJson(response);
}
async function responseJson(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new SearchError([401, 403].includes(response.status) ? 'auth' : [402, 429].includes(response.status) ? 'limit' : 'network');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SearchError('format');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new SearchError('size');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SearchError('format'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SearchError('format');
  if (data.error || data.success === false) {
    const code = String(data.error?.code || data.code || '');
    throw new SearchError(['1000', '1001', '1002', '1003', '1004', '1110', '401'].includes(code) ? 'auth'
      : ['1113', '1301', '1302', '1303', '1304', '1305', '429'].includes(code) ? 'limit' : 'format');
  }
  return data;
}
function afterDate(recency) {
  const days = { day: 1, week: 7, month: 30, year: 365 }[recency];
  return days ? new Date(Date.now() - days * 86400000).toISOString() : undefined;
}
export async function searchProvider(id, input, settings, api, signal, fetcher = fetch) {
  const { query, limit, domains, recency } = input;
  if (id === 'dsh') {
    const web = getWeb(api);
    if (typeof web?.search !== 'function') throw new SearchError('dsh');
    const sites = domains.length ? ` (${domains.map(d => 'site:' + d).join(' OR ')})` : '';
    const after = afterDate(recency);
    return web.search({ query: query + sites + (after ? ' after:' + after.slice(0, 10) : ''), maxResults: limit }, signal);
  }
  if (id === 'tavily') {
    const data = await jsonPost(endpoint(settings.tavilyUrl, '/search'), { Authorization: 'Bearer ' + settings.tavilyApiKey.trim() }, {
      api_key: settings.tavilyApiKey.trim(), query, max_results: limit, search_depth: 'basic', include_answer: false, include_raw_content: false,
      ...(domains.length ? { include_domains: domains } : {}), ...(recency !== 'any' ? { time_range: recency } : {}),
    }, signal, fetcher);
    if (!Array.isArray(data.results)) throw new SearchError('format');
    return { sources: data.results.map(x => ({ url: x?.url, title: x?.title, snippet: x?.content, publishedAt: x?.published_date })) };
  }
  if (id === 'exa') {
    const data = await jsonPost(endpoint(settings.exaUrl, '/search'), { 'x-api-key': settings.exaApiKey.trim() }, {
      query, numResults: limit, type: 'auto', contents: { text: { maxCharacters: 1000 } },
      ...(domains.length ? { includeDomains: domains } : {}), ...(afterDate(recency) ? { startPublishedDate: afterDate(recency) } : {}),
    }, signal, fetcher);
    if (!Array.isArray(data.results)) throw new SearchError('format');
    return { sources: data.results.map(x => ({ url: x?.url, title: x?.title, snippet: x?.text, publishedAt: x?.publishedDate })) };
  }
  if (id === 'zhipu') {
    if ([...query].length > 70) throw new SearchError('zhipuQuery');
    const data = await jsonPost(endpoint(settings.zhipuUrl, '/paas/v4/web_search'), { Authorization: 'Bearer ' + settings.zhipuApiKey.trim() }, {
      search_query: query, search_engine: settings.zhipuEngine || 'search_std', search_intent: false,
      count: limit, content_size: 'medium', search_recency_filter: recency === 'any' ? 'noLimit' : 'one' + recency[0].toUpperCase() + recency.slice(1),
      ...(domains.length === 1 ? { search_domain_filter: domains[0] } : {}),
    }, signal, fetcher);
    if (!Array.isArray(data.search_result)) throw new SearchError('format');
    return { sources: data.search_result.map(x => ({ url: x?.link || x?.url, title: x?.title, snippet: x?.content, publishedAt: x?.publish_date })) };
  }
  if (id === 'firecrawl') {
    const sites = domains.length ? ' (' + domains.map(d => 'site:' + d).join(' OR ') + ')' : '';
    const after = afterDate(recency);
    const data = await jsonPost(endpoint(settings.firecrawlUrl, '/search'), { Authorization: 'Bearer ' + settings.firecrawlApiKey.trim() },
      { query: query + sites + (after ? ' after:' + after.slice(0, 10) : ''), limit, sources: ['web'] }, signal, fetcher);
    if (!Array.isArray(data.data?.web)) throw new SearchError('format');
    return { sources: data.data.web.map(x => ({ url: x?.url, title: x?.title, snippet: x?.description })) };
  }
  if (id === 'searxng') {
    const url = searxngEndpoint(settings.searxngUrl);
    const queryWithDomains = query + (domains.length ? ' (' + domains.map(d => 'site:' + d).join(' OR ') + ')' : '');
    url.searchParams.set('q', queryWithDomains); url.searchParams.set('format', 'json');
    if (recency !== 'any') url.searchParams.set('time_range', recency === 'week' ? 'month' : recency);
    if (settings.searxngEngines?.trim()) url.searchParams.set('engines', settings.searxngEngines.trim());
    const response = await fetcher(url, { redirect: 'error', signal,
      headers: { Accept: 'application/json', ...(settings.searxngApiKey?.trim() ? { Authorization: 'Bearer ' + settings.searxngApiKey.trim() } : {}) } });
    if (response.status === 403 || !String(response.headers.get('content-type')).includes('application/json')) {
      await response.body?.cancel(); throw new SearchError('searxng');
    }
    const data = await responseJson(response);
    if (!Array.isArray(data.results)) throw new SearchError('searxng');
    return { sources: data.results.slice(0, limit * 3).map(x => ({ url: x?.url, title: x?.title, snippet: x?.content, publishedAt: x?.publishedDate })),
      truncated: data.results.length > limit,
      ...(Array.isArray(data.unresponsive_engines) && data.unresponsive_engines.length ? { warning: '部分 SearXNG 引擎未响应，已保留其他引擎的结果。' } : {}) };
  }
  throw new SearchError('source');
}
export async function readProvider(id, input, settings, signal, fetcher = fetch, pageReader = readPublicPage) {
  const url = publicUrl(input).href;
  if (['dsh', 'searxng', 'zhipu'].includes(id)) return pageReader(url, signal);
  if (id === 'tavily') {
    const data = await jsonPost(endpoint(settings.tavilyUrl, '/extract'), { Authorization: 'Bearer ' + settings.tavilyApiKey.trim() },
      { api_key: settings.tavilyApiKey.trim(), urls: [url], extract_depth: 'basic', format: 'text' }, signal, fetcher);
    const page = data.results?.[0];
    if (!page?.raw_content) throw new SearchError('page');
    return { url: page.url || url, content: page.raw_content };
  }
  if (id === 'exa') {
    const data = await jsonPost(endpoint(settings.exaUrl, '/contents'), { 'x-api-key': settings.exaApiKey.trim() },
      { ids: [url], text: { maxCharacters: 12000 } }, signal, fetcher);
    const page = data.results?.[0];
    if (!page?.text) throw new SearchError('page');
    return { url: page.url || url, title: page.title, content: page.text, truncated: page.text.length >= 12000 };
  }
  if (id === 'firecrawl') {
    const data = await jsonPost(endpoint(settings.firecrawlUrl, '/scrape'), { Authorization: 'Bearer ' + settings.firecrawlApiKey.trim() },
      { url, formats: ['markdown'], onlyMainContent: true, timeout: Math.min(settings.timeoutSeconds * 1000, 30000) }, signal, fetcher);
    if (typeof data.data?.markdown !== 'string' || !data.data.markdown.trim()) throw new SearchError('page');
    return { url: data.data.metadata?.sourceURL || url, title: data.data.metadata?.title, content: data.data.markdown };
  }
  throw new SearchError('source');
}

export async function context7Request(args, settings, signal, fetcher = fetch) {
  const lookup = !args.libraryId;
  const url = new URL(endpoint(settings.context7Url, lookup ? '/api/v2/libs/search' : '/api/v2/context'));
  url.searchParams.set('query', args.query);
  if (!lookup) url.searchParams.set('type', 'json');
  url.searchParams.set(lookup ? 'libraryName' : 'libraryId', lookup ? args.library : args.libraryId);
  return responseJson(await fetcher(url, { redirect: 'error', signal,
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + settings.context7ApiKey.trim(), 'X-Context7-Source': 'aurabot-smart-search' } }));
}
