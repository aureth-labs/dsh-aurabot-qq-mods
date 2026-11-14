const messages = {
  disabled: '联网搜索已关闭。', forbidden: '这次搜索只允许主人发起；群里请主人单独提问。',
  scope: '这个聊天暂未开放联网搜索。', busy: '搜索正在忙，请稍后再试。',
  quota: '本小时搜索次数已用完，请稍后再试。',
  query: '请提供 1～500 字的搜索问题。', domains: '限定网站请填写域名，最多 5 个。',
  recency: '时间范围请选择不限、一天、一周、一个月或一年。',
  url: '只能读取公开的 http / https 网页，不支持本机、内网或带密码的网址。',
  setup: '请在「联网搜索」面板选择搜索服务并完成配置。',
  source: '只能使用面板中已启用且已配置的搜索源。',
  searxng: 'SearXNG 暂不可用，请检查实例地址及 JSON 搜索设置。',
  docs: '请填写库名或有效的 Context7 文档编号。',
  zhipuQuery: '智谱搜索词最多 70 字，请缩短问题或改用其他已启用的源。',
  dsh: 'DSH 搜索暂不可用，请检查 DSH 的搜索设置，或在本面板改用 Tavily / Exa。',
  auth: '搜索服务的密钥无效，请在面板重新填写。',
  limit: '搜索服务额度不足或请求太频繁，请稍后再试或检查服务账户。',
  timeout: '搜索等待超时，请稍后再试。', aborted: '本次搜索已取消。',
  network: '暂时连不上搜索服务，请稍后重试。',
  format: '搜索服务返回了无法读取的结果，请稍后重试。',
  page: '网页暂时无法读取，可能需要登录或限制了访问。可换一个来源，或改用 Tavily / Exa。',
  size: '网页内容过大，请换一个具体页面。',
  local: '请从本机打开联网搜索面板。', request: '请求格式不正确，请刷新面板后重试。',
};
export class SearchError extends Error {
  constructor(code) {
    const safe = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'network';
    super(messages[safe]); this.code = safe;
  }
}
export function failure(error) {
  // Rebuild even our own errors from the allowlist. An exception's mutable
  // message/code must never become a route for diagnostics into tool history.
  if (error instanceof SearchError) {
    const safe = new SearchError(error.code);
    return { ok: false, code: safe.code, message: safe.message };
  }
  if (error?.name === 'TimeoutError' || error?.code === 'WEB_FETCH_TIMEOUT') return failure(new SearchError('timeout'));
  if (error?.name === 'AbortError' || error?.code === 'WEB_ABORTED') return failure(new SearchError('aborted'));
  if (/^WEB_PROVIDER_(?:UNAVAILABLE|CONFIGURED|AMBIGUOUS)/.test(error?.code || '')) return failure(new SearchError('dsh'));
  // Never return raw upstream bodies, exception messages, paths, queries or keys.
  return failure(new SearchError('network'));
}
