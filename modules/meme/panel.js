const { useState, useEffect, useRef } = React;
return function MemePanel({ settings, save, toast }) {
  const [data, setData] = useState(null), [query, setQuery] = useState(''), [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null), [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [alias, setAlias] = useState(''), [favoritesOnly, setFavoritesOnly] = useState(false);
  const [changing, setChanging] = useState(false);
  const previewRequest = useRef(0);
  useEffect(() => () => { previewRequest.current++; }, []);
  useEffect(() => { call('/library').then(setData).catch(e => toast(e.message)); }, []);
  useEffect(() => {
    if (!data?.extension?.busy) return;
    let stopped = false, timer;
    const poll = async () => {
      try {
        const result = await call('/extension');
        if (stopped) return;
        if (result.extension.busy) {
          setData(old => ({ ...old, extension: result.extension }));
          timer = setTimeout(poll, 1000);
        }
        else {
          const next = await call('/library');
          if (!stopped) { setData(next); setPage(1); if (next.extension.error) toast(next.extension.error); }
        }
      } catch { if (!stopped) timer = setTimeout(poll, 2000); }
    };
    timer = setTimeout(poll, 400);
    return () => { stopped = true; clearTimeout(timer); };
  }, [data?.extension?.busy]);
  useEffect(() => {
    if (!data?.installation?.busy) return;
    let stopped = false, timer;
    const poll = async () => {
      try {
        const next = await call('/installation');
        if (stopped) return;
        if (next.installation.busy) {
          setData(old=>({...old,installation:next.installation}));
          timer=setTimeout(poll,1000);
        } else {
          const library=await call('/library');
          if (!stopped) setData(library);
        }
      } catch {if(!stopped)timer=setTimeout(poll,2000);}
    };
    timer=setTimeout(poll,300);
    return ()=>{stopped=true;clearTimeout(timer);};
  },[data?.installation?.busy]);
  const retryInstallation = async () => {
    setChanging(true);
    try {
      const result=await call('/installation',{});
      if(result.ok===false)throw new Error(result.message);
      if(result.installation.busy)setData(old=>({...old,installation:result.installation}));
      else setData(await call('/library'));
    } catch(e){toast(e.message);} finally{setChanging(false);}
  };
  const extension = data?.extension;
  const changeExtension = async () => {
    setChanging(true);
    try {
      const result = await call('/extension', { action: extension.installed ? 'uninstall' : 'install' });
      if (result.ok === false) throw new Error(result.message);
      setData(old => ({ ...old, extension: result.extension }));
      previewRequest.current++; setSelected(null); setPreview(null); setBusy(false); setPage(1);
      if (!result.extension.busy) setData(await call('/library'));
    } catch (e) { toast(e.message); } finally { setChanging(false); }
  };
  const disabled = settings.disabled || [], favorites = settings.favorites || [], aliases = settings.aliases || {};
  const saveSetting = async patch => { try { await save(patch); return true; } catch(e) { toast(e.message); return false; } };
  const toggle = async (field, key) => { const current = settings[field] || []; await saveSetting({ [field]: current.includes(key) ? current.filter(x => x !== key) : [...current, key] }); };
  const filtered = (data?.items || []).filter(m => (!favoritesOnly || favorites.includes(m.key)) && [m.key, ...m.keywords, ...m.tags, ...(m.shortcuts || []).map(s => s.humanized || s.pattern), ...Object.keys(aliases).filter(a => aliases[a] === m.key)].some(s => s.toLowerCase().includes(query.toLowerCase())));
  const range = (min, max) => min === max ? String(min) : `${min}–${max}`;
  const shortcutLabels = m => (m.shortcuts || []).map(s => s.humanized || (/^[^()[\]{}?*+|\\^$]+$/u.test(s.pattern) ? s.pattern : '')).filter(Boolean);
  const pages = Math.max(1, Math.ceil(filtered.length / 24));
  const currentPage = Math.min(page, pages);
  useEffect(() => { setPage(p => Math.min(p, pages)); }, [pages]);
  const show = async m => {
    const request = ++previewRequest.current;
    setSelected(m); setPreview(null); setAlias(''); setBusy(true);
    try { const r = await call('/preview', { key: m.key }); if (!r.base64) throw new Error(r.message || '预览生成失败'); if(request === previewRequest.current) setPreview(`data:${r.mime};base64,${r.base64}`); }
    catch (e) { if(request === previewRequest.current) toast(e.message); } finally { if(request === previewRequest.current) setBusy(false); }
  };
  return h('div', null,
    h(ui.Card, { title: '表情库' },
      h('p', { className: 'ab-note', 'aria-live': 'polite' }, data ? (data.installation?.busy ? data.installation.message : data.error ? '表情库暂时不可用' : `${data.total} 个模板`) : '正在加载…'),
      data?.installation?.busy && h('div', { style:{marginBottom:16} },
        h('progress', { 'aria-label':'表情库准备进度', style:{width:'100%',height:12}, ...(data.installation.total>0 ? {value:data.installation.completed,max:data.installation.total} : {}) }),
        h('p', {className:'ab-muted ab-small'},data.installation.total>0 ? `${data.installation.completed} / ${data.installation.total}` : data.installation.received ? `已下载 ${(data.installation.received/1048576).toFixed(1)} MiB，完成后自动继续。` : '首次准备需要一些时间，完成后即可使用。')),
      data?.installation?.error && h('div', {style:{display:'flex',alignItems:'center',flexWrap:'wrap',gap:12,marginBottom:16}},
        h('span',null,data.installation.error),data.installation.help && h('a',{href:data.installation.help,target:'_blank',rel:'noopener noreferrer'},'安装说明'),h(ui.Btn,{disabled:changing,onClick:retryInstallation},'重试准备')),
      h('p', null, '聊天中发送“#表情列表”查看全部表情，发送“#表情详情 摸摸”查看用法。'),
      h('div', { style: { display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 16 } },
        h('label', { style: { display: 'flex', gap: 10, alignItems: 'center' } }, '目录列数',
          h('select', { className: 'ab-input', 'aria-label': '目录列数', value: settings.indexColumns || 5, onChange: e => saveSetting({ indexColumns: Number(e.target.value) }) },
            ...[4, 5, 6, 7].map(n => h('option', { key: n, value: n }, `${n} 列`)))),
        extension && h('div', null,
          h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', null, extension.installed ? `扩展库 · ${extension.count} 个模板` : '扩展库 · 未安装'),
            h(ui.Btn, { disabled: changing || busy || extension.busy || !data?.ready, onClick: changeExtension },
              extension.busy ? (extension.operation==='uninstall'?'正在卸载…':'正在安装…') : extension.installed ? '卸载扩展库' : '安装扩展库')),
          h('div', { className: 'ab-muted ab-small', style: { marginTop: 5 } },
            extension.error || (extension.busy ? (extension.message || '正在处理…') + (extension.received ? ` · 已下载 ${(extension.received/1048576).toFixed(1)} MiB` : '') : extension.installed ? '卸载只停用，保留资源。' : extension.cached ? '资源已保留，可直接安装。' : '首次安装需下载资源。'),extension.error && extension.help && h('a',{href:extension.help,target:'_blank',rel:'noopener noreferrer',style:{marginLeft:8}},'安装说明')))),
      data?.ready && h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 } },
        h('input', { className: 'ab-input', placeholder: '搜索模板、触发词或标签', 'aria-label': '搜索模板', value: query, onChange: e => { setQuery(e.target.value); setPage(1); }, style: { flex: '1 1 240px' } }),
        h(ui.Btn, { onClick: () => { setFavoritesOnly(!favoritesOnly); setPage(1); } }, favoritesOnly ? '显示全部' : '只看收藏')),
      data?.ready && h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))', gap: 12 } },
        ...filtered.slice((currentPage - 1) * 24, currentPage * 24).map(m => h('div', { key: m.key, style: { border: '1px solid var(--ab-border, #ddd)', borderRadius: 10, padding: 12 } },
          h('strong', null, m.keywords[0]),
          h('div', { className: 'ab-muted ab-small', style: { margin: '6px 0', overflowWrap: 'anywhere' } }, m.keywords.join(' · ')),
          h('div', { className: 'ab-note' }, [m.params.maxImages ? `${range(m.params.minImages, m.params.maxImages)} 张图片` : '', m.params.maxTexts ? `${range(m.params.minTexts, m.params.maxTexts)} 段文字` : '', disabled.includes(m.key) ? '已禁用' : ''].filter(Boolean).join(' · ')),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' } },
            h(ui.Btn, { disabled: busy || disabled.includes(m.key), onClick: () => show(m) }, '预览 / 用法'),
            h(ui.Btn, { onClick: () => toggle('disabled', m.key) }, disabled.includes(m.key) ? '启用' : '禁用'),
            h(ui.Btn, { onClick: () => toggle('favorites', m.key) }, favorites.includes(m.key) ? '★' : '☆'))))),
      data?.ready && !filtered.length && h('p', {className:'ab-muted'}, favoritesOnly ? '还没有匹配的收藏模板' : '未找到匹配的模板'),
      data?.ready && h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 16 } },
        h(ui.Btn, { disabled: currentPage <= 1, onClick: () => setPage(currentPage - 1) }, '上一页'),
        h('span', null, `${filtered.length} 个 · ${currentPage}/${pages}`),
        h(ui.Btn, { disabled: currentPage >= pages, onClick: () => setPage(currentPage + 1) }, '下一页'))),
    selected && h(ui.Card, { title: selected.keywords[0] },
      h('p', null, '触发词：' + selected.keywords.join(' / ')),
      shortcutLabels(selected).length > 0 && h('p', { className: 'ab-note', style: { overflowWrap: 'anywhere' } }, '快捷用法：' + shortcutLabels(selected).join(' / ')),
      h('p', null, `用法：#${selected.keywords[0]}${selected.params.maxImages ? ' @某人 或附图' : ''}${selected.params.maxTexts ? ' ' + (selected.params.defaultTexts.join(' / ') || '文字') : ''}`),
      h('p', { className: 'ab-note' }, selected.params.options.map(o => `--${o.field0.name}：${o.field0.description || ({ Boolean: 'true 或 false', String: '文字', Integer: '整数', Float: '数字' }[o.type])}`).join('；') || '无额外参数'),
      busy ? h('p', null, '正在生成预览…') : preview && h('img', { src: preview, alt: selected.keywords[0] + '预览', style: { maxWidth: '100%', maxHeight: 360, display: 'block', marginBottom: 16 } }),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('input', { className: 'ab-input', placeholder: '添加自定义触发词', value: alias, onChange: e => setAlias(e.target.value) }),
        h(ui.Btn, { onClick: async () => { if (!alias.trim() || /\s/.test(alias.trim()) || alias.length > 40) return toast('触发词须为 1–40 字且不含空格'); if(await saveSetting({ aliases: { ...aliases, [alias.trim()]: selected.key } })) setAlias(''); } }, '添加')),
      ...Object.entries(aliases).filter(([, k]) => k === selected.key).map(([a]) => h('p', { key: a }, a, ' ', h(ui.Btn, { onClick: async () => { const next = { ...aliases }; delete next[a]; await saveSetting({ aliases: next }); } }, '移除')))),
    h(ui.Card, { title: '常用指令' }, h('p', { style: { whiteSpace: 'pre-line' } }, '#表情帮助\n#表情列表图片（完整目录图）\n#表情列表 [页码] / #表情搜索 关键词 [页码]\n#表情详情 名称 / #表情预览 名称\n#表情 随机 / #表情排行 / #表情状态\n主人：#表情禁用 名称 / #表情启用 名称 / #表情别名 新词=模板 / #表情开 / #表情关')));
};
