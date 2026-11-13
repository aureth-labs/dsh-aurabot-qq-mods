// Shared by #表情列表 and #表情搜索; keep the filter in every navigation command.
export function formatTemplateList(items, input = '') {
  const arg = input.trim();
  const match = arg.match(/^(.*?)\s+(\d+)$/u);
  const query = /^\d+$/u.test(arg) ? '' : match ? match[1].trim() : arg;
  const requested = Number(match ? match[2] : /^\d+$/u.test(arg) ? arg : 1);
  const q = query.toLowerCase();
  const found = items.filter(m => [m.key, ...m.keywords, ...m.tags].some(s => s.toLowerCase().includes(q)));
  const pages = Math.max(1, Math.ceil(found.length / 20));
  const page = Math.max(1, Math.min(requested, pages));
  const command = query ? `#表情搜索 ${query}` : '#表情列表';
  const navigation = [];
  if (page > 1) navigation.push(`上一页：${command} ${page - 1}`);
  if (page < pages) navigation.push(`下一页：${command} ${page + 1}`);
  const rows = found.slice((page - 1) * 20, page * 20).map(m => m.keywords.join(' / '));
  return [`表情列表 · ${found.length} 个 · ${page}/${pages} 页`, ...rows,
    ...navigation, '#表情详情 名称；#模板名'].join('\n');
}
