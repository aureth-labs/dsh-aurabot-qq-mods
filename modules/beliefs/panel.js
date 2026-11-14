// 观点面板：列表、加一条、删一条、从记忆归纳、重建向量、试匹配、参数说明。
const { useState, useEffect } = React

return function BeliefPage({ toast }) {
  const [items, setItems] = useState([])
  const [meta, setMeta] = useState({ model: '', dims: 0, caps: {}, archived: 0 })
  const [text, setText] = useState('')
  const [topic, setTopic] = useState('')
  const [core, setCore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState(null)
  const [err, setErr] = useState('')
  const api = '/aurabot/api/ext/beliefs'

  const load = async () => {
    try {
      setErr('')
      const r = await fetch(api + '/list', { cache: 'no-store' }).then((x) => x.json())
      setItems(r.items || [])
      setMeta({ model: r.model || '', dims: r.dims || 0, caps: r.caps || {}, archived: r.archived || 0 })
    } catch (e) { setErr(String((e && e.message) || e)) }
  }
  useEffect(() => { load() }, [])

  const call = async (path, body) => {
    const r = await fetch(api + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
    return r.json()
  }

  const submit = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      const r = await call('/add', { text, topic, core })
      if (r && r.ok === false) { toast && toast(r.message || '没加上'); return }
      setText(''); setTopic(''); setCore(false)
      await load()
      toast && toast(r.merged ? '和已有的合并了' : '记下了')
    } finally { setBusy(false) }
  }

  const del = async (id) => {
    await call('/del', { id })
    await load()
  }

  const derive = async () => {
    setBusy(true)
    try {
      const r = await call('/derive', {})
      toast && toast(r.ok ? '新形成 ' + (r.added || 0) + ' 条，合并 ' + (r.merged || 0) + ' 条' : (r.message || '没成形'))
      await load()
    } finally { setBusy(false) }
  }

  const reindex = async () => {
    setBusy(true)
    try {
      const r = await call('/reindex', {})
      toast && toast('已索引 ' + (r.indexed || 0) + ' 条（新增 ' + (r.added || 0) + '）')
      await load()
    } finally { setBusy(false) }
  }

  const test = async () => {
    if (!q.trim()) return
    const r = await fetch(api + '/match?q=' + encodeURIComponent(q), { cache: 'no-store' }).then((x) => x.json())
    setHits(r.items || [])
  }

  const pct = (v) => Math.round((Number(v) || 0) * 100)
  const indexed = items.filter((x) => x.indexed).length
  const row = (k, v, def) => h('div', {
    key: k,
    style: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid rgba(128,128,128,.1)', fontSize: 12 },
  },
  h('div', { className: 'ab-muted' }, k),
  h('div', null, String(v) + (def !== undefined ? '（默认 ' + def + '）' : '')))

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    err ? h('div', { style: { color: '#c0392b', fontSize: 12 } }, err) : null,

    h(ui.Card, { title: '加一条看法', desc: '核心是三观层面，普通观点会被经历修正。' },
      h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
        h('input', {
          className: 'ab-input', style: { flex: 1 }, placeholder: '比如：奶茶还是三分糖的好喝',
          value: text, onChange: (e) => setText(e.target.value),
        }),
        h('input', {
          className: 'ab-input', style: { width: 90 }, placeholder: '主题',
          value: topic, onChange: (e) => setTopic(e.target.value),
        }),
        h(ui.Btn, { small: true, disabled: busy, onClick: submit }, '记下')),
      h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 } },
        h('input', { type: 'checkbox', checked: core, onChange: (e) => setCore(e.target.checked) }),
        '这是核心观点（不该被随口说服）')),

    h(ui.Card, {
      title: '她现在的看法',
      desc: '核心 ' + items.filter((x) => x.core).length + '/' + (meta.caps.core || 12)
        + ' · 普通 ' + items.filter((x) => !x.core).length + '/' + (meta.caps.normal || 80)
        + ' · 已归档 ' + (meta.archived || 0)
        + ' · 向量 ' + indexed + '/' + items.length
        + (meta.vector ? '（' + meta.vector.model + ' · ' + String(meta.vector.baseUrl).replace(/^https?:\/\//, '') + (meta.vector.shared ? '，跟随记忆模块' : '') + '）' : ''),
      right: h('div', { style: { display: 'flex', gap: 8 } },
        h(ui.Btn, { small: true, kind: 'ghost', disabled: busy, onClick: reindex }, busy ? '处理中…' : '重建向量'),
        h(ui.Btn, { small: true, kind: 'ghost', disabled: busy, onClick: derive }, '从记忆归纳')),
    },
    items.length
      ? items.map((b) => h('div', {
        key: b.id,
        style: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 0', borderBottom: '1px solid rgba(128,128,128,.12)' },
      },
      h('div', { style: { width: 34, fontSize: 11, color: b.core ? '#c0392b' : 'inherit' } }, b.core ? '核心' : ''),
      h('div', { style: { flex: 1, minWidth: 0, fontSize: 13 } }, b.text + (b.topic ? '（' + b.topic + '）' : '')),
      h('div', { className: 'ab-muted', style: { fontSize: 11, width: 46 } }, pct(b.confidence) + '%' + (b.indexed ? '' : ' · 未索引')),
      h(ui.Btn, { small: true, kind: 'ghost', onClick: () => del(b.id) }, '删')))
      : h('div', { className: 'ab-muted ab-small' }, '还没有观点。点「从记忆归纳」，或者手动加一条。')),

    h(ui.Card, { title: '试匹配', desc: '输入一句话，看她会想起哪些看法（按语义，不按关键词）。' },
      h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
        h('input', {
          className: 'ab-input', style: { flex: 1 }, placeholder: '比如：他答应我的事又忘了',
          value: q, onChange: (e) => setQ(e.target.value),
        }),
        h(ui.Btn, { small: true, onClick: test }, '试一下')),
      hits
        ? (hits.length
          ? hits.map((b) => h('div', { key: b.id, style: { fontSize: 12, padding: '3px 0' } },
            (b.core ? '[核心] ' : '') + b.text + '  · 相似度 ' + b.sim))
          : h('div', { className: 'ab-muted ab-small' }, '没有达到门槛的观点。'))
        : null))
}
