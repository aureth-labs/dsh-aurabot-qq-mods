export const DEFAULTS = Object.freeze({
  enabled: true, sources: ['dsh'], strategy: 'adaptive', fallback: true,
  maxSources: 2, ownerOnly: true, groups: '', private: true,
  tavilyApiKey: '', exaApiKey: '', maxResults: 5, timeoutSeconds: 30,
  searxngUrl: '', searxngApiKey: '', searxngEngines: '',
  zhipuApiKey: '', firecrawlApiKey: '', context7ApiKey: '',
  tavilyUrl: 'https://api.tavily.com', exaUrl: 'https://api.exa.ai',
  zhipuUrl: 'https://open.bigmodel.cn/api', zhipuEngine: 'search_std',
  firecrawlUrl: 'https://api.firecrawl.dev/v2', context7Url: 'https://context7.com',
  hourlyLimit: 30,
});
export const PROVIDERS = { dsh: 'DSH 搜索', zhipu: '智谱', tavily: 'Tavily', exa: 'Exa', firecrawl: 'Firecrawl', searxng: 'SearXNG', context7: 'Context7' };
export const WEB_SOURCES = Object.keys(PROVIDERS).filter(x => x !== 'context7');
export function bounded(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}
export function options(raw = {}) {
  return {
    ...DEFAULTS, ...raw,
    sources: [...new Set((Array.isArray(raw.sources) ? raw.sources : DEFAULTS.sources).filter(x => Object.hasOwn(PROVIDERS, x)))],
    strategy: ['adaptive', 'economy', 'verify'].includes(raw.strategy) ? raw.strategy : 'adaptive',
    maxSources: bounded(raw.maxSources ?? 2, 2, 1, 6),
    maxResults: bounded(raw.maxResults ?? 5, 5, 1, 10),
    timeoutSeconds: bounded(raw.timeoutSeconds ?? 30, 30, 5, 60),
    hourlyLimit: bounded(raw.hourlyLimit ?? 30, 30, 1, 200),
  };
}
export const groupList = value => String(value || '').split(/[\s,，;；]+/u).filter(Boolean);
export function allowsChat(chat, settings) {
  if (!settings.enabled || !chat || !['private', 'group'].includes(chat.kind)) return false;
  if (chat.kind === 'private') return settings.private !== false;
  const groups = groupList(settings.groups);
  return groups.length === 0 || groups.includes(String(chat.groupId));
}
