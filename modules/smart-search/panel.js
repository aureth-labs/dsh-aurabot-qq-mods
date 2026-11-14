const { useState, useEffect } = React;
const names = { dsh: 'DSH 搜索', zhipu: '智谱', tavily: 'Tavily', exa: 'Exa', firecrawl: 'Firecrawl', searxng: 'SearXNG', context7: 'Context7' };
const descriptions = { dsh: '沿用 DSH 的搜索设置，不用再填密钥。', zhipu: '适合中文资讯、公告和国内资料。', tavily: '适合日常资料和新闻检索。', exa: '适合官方网站、技术文档和论文。', firecrawl: '搜索网页，也能提取网页正文。', searxng: '连接你选择的聚合搜索实例，支持自建服务。', context7: '专门查编程库和框架文档，不参与通用搜索。' };
const keyLinks = { zhipu: 'https://open.bigmodel.cn/', tavily: 'https://app.tavily.com/', exa: 'https://dashboard.exa.ai/', firecrawl: 'https://www.firecrawl.dev/', context7: 'https://context7.com/dashboard' };
const inputStyle = { width: '100%', boxSizing: 'border-box' };
return function Panel({ settings, draftSettings, setSettings, toast }) {
  const s = draftSettings || settings;
  const [status, setStatus] = useState(null), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [result, setResult] = useState(null), [busy, setBusy] = useState(false);
  const [testSource, setTestSource] = useState('auto'), [library, setLibrary] = useState('react');
  const [advanced, setAdvanced] = useState(false);
  const sources = Array.isArray(s.sources) ? s.sources : ['dsh'];
  const load = async () => {
    try { const value = await call('/status'); if (!value.ok) throw Error(value.message); setStatus(value); setError(''); }
    catch { setError('状态读取失败，请点击刷新重试。'); }
  };
  useEffect(() => { load(); }, [settings]);
  const set = patch => { setSettings(patch); setResult(null); };
  const changed = JSON.stringify(s) !== JSON.stringify(settings);
  const field = (label, control, hint) => h('div', { style: { marginBottom: 16 } },
    h('label', { style: { display: 'block', fontWeight: 600, marginBottom: 7 } }, label, control),
    hint ? h('div', { className: 'ss-hint', style: { marginTop: 5 } }, hint) : null);
  const checkbox = (label, checked, onChange) => h('label', { style: { display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' } },
    h('input', { type: 'checkbox', checked: !!checked, onChange: e => onChange(e.target.checked) }), label);
  const select = (label, key, choices) => field(label, h('select', {
    className: 'ab-input', style: { ...inputStyle, display: 'block', marginTop: 7 }, value: s[key], onChange: e => set({ [key]: e.target.value }),
  }, choices.map(([value, title]) => h('option', { key: value, value }, title))));
  const number = (label, key, min, max) => field(label, h('input', { className: 'ab-input', style: { display: 'block', marginTop: 7, width: 110 },
    type: 'number', value: s[key], min, max, onChange: e => set({ [key]: Number(e.target.value) }) }));
  const test = async () => {
    if (!query.trim() || busy || changed) return;
    setBusy(true); setResult(null);
    try { const value = await call('/test', { query: query.trim(), ...(testSource === 'context7' ? { source: 'context7', library } : testSource !== 'auto' ? { sources: [testSource] } : {}) }); setResult(value); }
    catch { setResult({ ok: false, message: '试搜失败，请检查连接后重试。' }); }
    finally { setBusy(false); load(); }
  };
  const ready = status?.providers?.filter(x => x.enabled && x.ready) || [];
  return h('div', { className: 'ss-panel', style: { display: 'grid', gap: 16, minWidth: 0, gridColumn: '1 / -1', fontSize: 15 } },
    h('style', null, '.ss-panel .ss-hint{font-size:14px;line-height:1.65;color:var(--ab-sub,#667085)}.ss-panel .ab-desc{font-size:14px}.ss-panel .ab-input,.ss-panel .ab-btn{font-size:14px}.ss-sources{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));column-gap:28px}.ss-source{padding:14px 0;border-bottom:1px solid var(--ab-line,#e5e7eb);min-width:0}.ss-source>label{font-weight:600}.ss-source summary{font-size:14px;color:var(--ab-deep,#245a94)}'),
    h(ui.Card, { title: '需要时，自己查一查', desc: '照常聊天。遇到拿不准、需要核实或有时效性的问题，模型会按需搜索，回答附上来源。' },
      checkbox('启用联网搜索', s.enabled, value => set({ enabled: value })),
      h('div', { role: 'status', className: 'ss-hint', style: { marginTop: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
        h('span', null, error || (!status ? '正在检查…' : !status.enabled ? '已关闭' : ready.length ? '已配置 · ' + ready.map(x => x.name).join('、') : '还没有可用的搜索源，请先完成下面的配置。')),
        h(ui.Btn, { onClick: load, disabled: busy }, '刷新'))),
    h(ui.Card, { title: '搜索源', desc: '可以同时启用多个；只有勾选的服务才会收到搜索请求。' },
      h('div', { className: 'ss-sources' }, Object.keys(names).map(id => {
        const enabled = sources.includes(id), saved = status?.providers?.find(x => x.id === id);
        return h('div', { key: id, className: 'ss-source' },
          checkbox(names[id], enabled, value => set({ sources: value ? [...sources, id] : sources.filter(x => x !== id) })),
          h('p', { className: 'ss-hint', style: { margin: '6px 0 0 24px' } }, descriptions[id]),
          enabled && id === 'dsh' && saved && !saved.ready ? h('p', { className: 'ss-hint', style: { marginLeft: 24 } }, 'DSH 搜索暂不可用。请检查 DSH 的搜索设置，或启用下面的服务。') : null,
          enabled && id === 'searxng' ? h('div', { style: { margin: '12px 0 0 24px' } },
            field('实例地址', h('input', { className: 'ab-input', style: { ...inputStyle, display: 'block', marginTop: 7 }, value: s.searxngUrl || '', placeholder: 'https://search.example.com', onChange: e => set({ searxngUrl: e.target.value }) }), '实例需开放 JSON 搜索。只连接你信任的服务。'),
            field('指定引擎（选填）', h('input', { className: 'ab-input', style: { ...inputStyle, display: 'block', marginTop: 7 }, value: s.searxngEngines || '', placeholder: '留空使用实例默认值', onChange: e => set({ searxngEngines: e.target.value }) }), '多个引擎用英文逗号分隔。'),
            field('访问令牌（选填）', h('input', { className: 'ab-input', style: { ...inputStyle, display: 'block', marginTop: 7 }, type: 'password', autoComplete: 'new-password', value: s.searxngApiKey || '', placeholder: s.searxngApiKeySet ? '已保存；不修改请留空' : '通常不需要填写', onChange: e => set({ searxngApiKey: e.target.value }) })),
            s.searxngApiKeySet ? h(ui.Btn, { onClick: () => set({ searxngApiKey: null }) }, s.searxngApiKey === null ? '保存后清除令牌' : '清除令牌') : null) : null,
          enabled && !['dsh', 'searxng'].includes(id) ? h('details', { open: !settings[id + 'ApiKeySet'], style: { margin: '10px 0 0 24px' } },
            h('summary', { style: { cursor: 'pointer', marginBottom: 12 } }, settings[id + 'ApiKeySet'] ? '已保存密钥 · 修改配置' : '填写配置'),
            field(names[id] + ' API Key', h('input', { className: 'ab-input', style: { ...inputStyle, display: 'block', marginTop: 7 }, type: 'password',
              value: s[id + 'ApiKey'] || '', autoComplete: 'new-password', spellCheck: false,
              placeholder: s[id + 'ApiKeySet'] ? '已保存；不修改请留空' : '粘贴 API Key', onChange: e => set({ [id + 'ApiKey']: e.target.value }) }),
              h('span', null, '按服务商规则计费。', h('a', { href: keyLinks[id], target: '_blank', rel: 'noreferrer' }, '获取密钥'))),
            s[id + 'ApiKeySet'] ? h(ui.Btn, { onClick: () => set({ [id + 'ApiKey']: null }) }, s[id + 'ApiKey'] === null ? '保存后清除密钥' : '清除密钥') : null,
            h('details', { style: { marginTop: 12 } }, h('summary', { style: { cursor: 'pointer' } }, '服务地址与高级选项'),
              h('div', { style: { marginTop: 12 } }, field('服务地址', h('input', { className: 'ab-input', style: { ...inputStyle, display: 'block', marginTop: 7 }, value: s[id + 'Url'] || '', onChange: e => set({ [id + 'Url']: e.target.value }) }), '默认官方地址；密钥与请求会发到此处。仅填写你信任的 HTTPS 服务。'),
                id === 'zhipu' ? field('搜索引擎', h('input', { className: 'ab-input', style: inputStyle, value: s.zhipuEngine || 'search_std', onChange: e => set({ zhipuEngine: e.target.value }) })) : null))) : null);
      })),
      !sources.length ? h('p', { className: 'ss-hint', role: 'alert' }, '至少启用一个搜索源才能搜索。') : null),
    h(ui.Card, { title: '怎么搜、谁能用' },
      select('搜索策略', 'strategy', [['adaptive', '按需搜索（推荐）'], ['economy', '省额度 · 每次只用一个源'], ['verify', '多源核对 · 并行搜索']]),
      h('p', { className: 'ss-hint' }, s.strategy === 'economy' ? '每次工具调用最多一个源，不自动换源。模型仍可在必要时再次调用。' : s.strategy === 'verify' ? '多个已启用的源一起查；结果会合并去重。请求数也会增加。' : '一般先查一个源；需要核对时，模型可选择多源搜索或继续读原文。'),
      checkbox('仅主人可发起搜索', s.ownerOnly, value => set({ ownerOnly: value })),
      h('p', { className: 'ss-hint' }, '开启时，群里也可以由主人提问。关闭后，机器人原本允许的聊天成员都能使用。'),
      h(ui.Btn, { onClick: () => setAdvanced(!advanced), 'aria-expanded': advanced }, advanced ? '收起更多设置' : '更多设置'),
      advanced ? h('div', { style: { marginTop: 18 } },
        checkbox('允许私聊使用', s.private, value => set({ private: value })),
        h('div', { style: { height: 16 } }),
        field('限定群号', h('textarea', { className: 'ab-input', style: { ...inputStyle, display: 'block', marginTop: 7 }, rows: 2, value: s.groups || '',
          placeholder: '留空沿用机器人已允许的群', onChange: e => set({ groups: e.target.value }) }), '一行一个群号。不会开放机器人原本不允许的群。'),
        checkbox('搜索失败或没有结果时换源', s.fallback, value => set({ fallback: value })),
        h('p', { className: 'ss-hint' }, '只在已启用的源中切换，受单次源数上限限制；省额度模式不换源。'),
        number('每次最多使用几个源', 'maxSources', 1, 6), number('最多返回几条结果', 'maxResults', 1, 10),
        number('每个聊天每小时最多请求次数', 'hourlyLimit', 1, 200),
        h('p', { className: 'ss-hint' }, '搜索每个源、每次读网页各计一次；试搜单独计数。缓存命中不计，重载模块后重新计数。'),
        number('最长等待（秒）', 'timeoutSeconds', 5, 60)) : null,
      h('p', { className: 'ss-hint', style: { marginTop: 16 } }, '改完点击页面底部的「保存设置」。')),
    h(ui.Card, { title: '试搜一下', desc: '使用已保存的设置发起真实搜索，可能消耗服务额度；不会向 QQ 发消息。' },
      field('试搜渠道', h('select', { className: 'ab-input', style: { ...inputStyle, display: 'block', marginTop: 7 }, value: testSource, onChange: e => { setTestSource(e.target.value); setResult(null); } },
        h('option', { value: 'auto' }, '按当前策略选源'), ready.map(x => h('option', { key: x.id, value: x.id }, x.name)))),
      testSource === 'context7' ? field('文档库名称', h('input', { className: 'ab-input', style: inputStyle, value: library, onChange: e => setLibrary(e.target.value) })) : null,
      h('form', { onSubmit: e => { e.preventDefault(); test(); }, style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h('input', { className: 'ab-input', 'aria-label': '试搜问题', placeholder: '例如：Node.js 官方文档', maxLength: 500,
          style: { flex: '1 1 220px', minWidth: 0 }, value: query, onChange: e => setQuery(e.target.value) }),
        h(ui.Btn, { onClick: test, disabled: busy || changed || !query.trim() || !settings.enabled || !ready.length }, busy ? '正在搜索…' : '试搜')),
      changed ? h('p', { className: 'ss-hint' }, '请先保存设置，再试搜。') : null,
      result ? h('div', { 'aria-live': 'polite', style: { marginTop: 16 } },
        !result.ok ? h('p', { className: 'ss-hint', role: 'alert' }, result.message) : result.kind === 'libraries' ? h('div', null,
          h('p', { className: 'ss-hint' }, '找到文档库，点击读取相关片段。'),
          result.libraries.map(item => h('div', { key: item.id, style: { marginBottom: 12 } }, h(ui.Btn, { disabled: busy, onClick: async () => {
            setBusy(true); try { setResult(await call('/test', { source: 'context7', query: query.trim(), libraryId: item.id })); } catch { setResult({ ok: false, message: '文档读取失败，请重试。' }); } finally { setBusy(false); }
          } }, item.title || item.id), h('p', { className: 'ss-hint' }, item.description)))) : result.kind === 'docs' ? h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 400, overflow: 'auto' } }, result.content) : h('div', null,
          h('p', { className: 'ss-hint' }, result.cached ? '使用了最近一分钟的结果。' : '找到了 ' + result.sources.length + ' 条来源。'),
          (result.attempts || []).map((a, i) => h('p', { key: i, className: 'ss-hint' }, names[a.provider] + '：' + (a.ok ? a.count + ' 条' : a.message) + (a.warning ? ' · ' + a.warning : ''))),
          result.sources.length ? h('ol', { style: { paddingLeft: 22 } }, result.sources.map(item => h('li', { key: item.url, style: { marginBottom: 16 } },
            h('a', { href: item.url, target: '_blank', rel: 'noreferrer', style: { overflowWrap: 'anywhere' } }, item.title || item.url),
            h('div', { className: 'ss-hint', style: { overflowWrap: 'anywhere', marginTop: 4 } }, item.snippet),
            h('small', { className: 'ab-muted' }, (item.providers || []).map(x => names[x]).join(' · '))))) : h('p', null, '没有找到结果，换个关键词试试。'))) : null));
};
