// 作息面板：今天什么处境、压力条、班表编辑、自记日程和扰动
const { useState, useEffect } = React

const DOWS = [['mon', '一'], ['tue', '二'], ['wed', '三'], ['thu', '四'], ['fri', '五'], ['sat', '六'], ['sun', '日']]
const STATE_COLOR = {
  work: 'var(--color-danger, #c62828)',
  commute: 'var(--color-warning, #b26a00)',
  home: 'var(--color-success, #2e7d32)',
  sleep: 'var(--color-text-tertiary, #9e9e9e)',
}
const fmt = (t) => t ? new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''

return function Panel({ toast }) {
  const [state, setState] = useState(null)
  const [week, setWeek] = useState(null)
  const [draft, setDraft] = useState(null)
  const [events, setEvents] = useState(null)
  const [history, setHistory] = useState([])
  const [profs, setProfs] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = () => {
    call('/state').then((s) => { if (s?.ok) setState(s); else setErr('state 接口不对') }).catch((e) => setErr(String(e.message || e)))
    call('/professions').then((r) => { if (r?.ok) setProfs(r) }).catch(() => {})
    call('/schedule').then((r) => {
      if (!r?.ok) return
      setWeek(r.week)
      setDraft(Object.fromEntries(DOWS.map(([d]) => [d, (r.week[d] || []).map((s) => s.join('-')).join(', ')])))
    }).catch(() => {})
    call('/events').then((r) => setEvents(r?.ok ? { self: r.self || [], disturb: r.disturb || [] } : null)).catch(() => {})
    call('/history').then((r) => setHistory(r?.ok ? r.history || [] : [])).catch(() => {})
  }
  useEffect(() => { reload(); const t = setInterval(reload, 30000); return () => clearInterval(t) }, [])

  const setEnabled = async (on) => {
    setBusy(true)
    try {
      const r = await call('/enabled', { on })
      if (r?.ok) { toast(on ? '作息托管开了' : '托管关了，livin 不再被自动拨动'); reload() } else toast(r?.message || '没切成功')
    } catch (e) { toast('出错了：' + (e.message || e)) }
    setBusy(false)
  }

  const saveWeek = async () => {
    setBusy(true)
    try {
      const parsed = {}
      for (const [d] of DOWS) {
        const txt = String(draft?.[d] || '').trim()
        parsed[d] = txt ? txt.split(/[,，;；]/).map((s) => {
          const m = s.trim().match(/^(\d{1,2}:\d{2})\s*[-~到]\s*(\d{1,2}:\d{2})$/)
          return m ? [m[1], m[2]] : null
        }).filter(Boolean) : []
      }
      const r = await call('/schedule', { week: parsed })
      if (r?.ok) { toast('班表存好了'); reload() } else toast(r?.message || '没存上')
    } catch (e) { toast('出错了：' + (e.message || e)) }
    setBusy(false)
  }

  const bump = async (delta) => {
    try { const r = await call('/pressure', { delta }); if (r?.ok) reload() } catch (e) { toast('出错了：' + (e.message || e)) }
  }

  const cancelEvent = async (id) => {
    try { const r = await call('/events', { id }); if (r?.ok) { toast('取消了'); reload() } else toast(r?.message || '没取消掉') } catch (e) { toast('出错了：' + (e.message || e)) }
  }

  const setProf = async (id) => {
    setBusy(true)
    try {
      const r = await call('/professions', { id })
      if (r?.ok) { toast(`换工作了：${r.name}，班表已按职业重排（手动改过的班表被覆盖）`); reload() } else toast(r?.message || '没换成')
    } catch (e) { toast('出错了：' + (e.message || e)) }
    setBusy(false)
  }

  const infoStyle = { fontSize: 13, color: 'var(--color-text-secondary, inherit)' }
  const small = { className: 'ab-small ab-muted' }
  const barColor = state && state.pressure >= state.threshold ? 'var(--color-danger, #c62828)' : state && state.pressure >= 60 ? 'var(--color-warning, #b26a00)' : 'var(--color-success, #2e7d32)'

  return h(ui.Card, { title: '作息' },
    err && h('p', small, '加载失败：' + err),
    state && h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' } },
      h('button', {
        onClick: () => setEnabled(!state.enabled),
        disabled: busy,
        style: {
          fontSize: 14, padding: '6px 16px', borderRadius: 999, cursor: 'pointer',
          border: '1px solid ' + (state.enabled ? 'rgba(46,125,50,.5)' : 'rgba(128,128,128,.4)'),
          background: state.enabled ? 'rgba(46,125,50,.12)' : 'transparent',
          color: 'inherit', whiteSpace: 'nowrap',
        },
      }, busy ? '切换中…' : state.enabled ? '⏸ 关闭托管' : '▶ 启用托管'),
      h('span', { style: { fontSize: 15, fontWeight: 500, color: STATE_COLOR[state.state] || 'inherit' } }, state.label),
      h('span', small, state.enabled
        ? `托管中 · 过日子现在是${state.livinManaged.on ? '开' : '关'}${state.livinManaged.lastWrite ? '（' + fmt(state.livinManaged.lastWrite) + '拨的）' : ''}`
        : '托管没开——开了才会注入「此刻处境」并按作息控制过日子开关。'),
    ),

    profs && h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
      h('span', small, '职业'),
      h('select', {
        value: profs.current,
        onChange: (e) => setProf(e.target.value),
        disabled: busy,
        style: { fontSize: 13, padding: '4px 8px', borderRadius: 8, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit' },
      }, profs.list.map((p) => h('option', { key: p.id, value: p.id }, p.name + (p.rotating ? '（轮班）' : '')))),
      (() => { const p = profs.list.find((x) => x.id === profs.current); return p ? h('span', small, p.desc + (p.goods ? ` · 卖：${p.goods.join('/')}` : '')) : null })(),
      state?.profession?.weekSource === 'custom' ? h('span', { style: { ...small, color: 'var(--color-warning, #b26a00)' } }, '手动班表生效中（职业模板暂停，换职业可恢复）') : null,
    ),

    state && h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 } },
      h('div', { style: { flex: '1 1 200px', background: 'rgba(128,128,128,.08)', borderRadius: 10, padding: '8px 12px' } },
        h('div', small, '压力值' + (state.pressureOn ? '' : '（关）')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('div', { style: { flex: 1, height: 8, background: 'rgba(128,128,128,.2)', borderRadius: 4, overflow: 'hidden' } },
            h('div', { style: { width: Math.min(100, state.pressure) + '%', height: '100%', background: barColor } })),
          h('span', { style: { fontSize: 13 } }, `${state.pressure}${state.pressureOn ? '/' + state.threshold : ''}`)),
        h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
          h('button', { onClick: () => bump(-5), style: { fontSize: 11, padding: '1px 8px', borderRadius: 999, border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: 'inherit', cursor: 'pointer' } }, '-5'),
          h('button', { onClick: () => bump(5), style: { fontSize: 11, padding: '1px 8px', borderRadius: 999, border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: 'inherit', cursor: 'pointer' } }, '+5'),
          h('span', small, '攒满自动请假' + (state.mood ? ' · 心情：' + state.mood : '')))),
      h('div', { style: { flex: '1 1 200px', background: 'rgba(128,128,128,.08)', borderRadius: 10, padding: '8px 12px' } },
        h('div', small, '今天 · ' + ({ work: '上班日', rest: '休息日', leave: '请假' }[state.today.type] || '—') + (state.today.note ? '（' + state.today.note + '）' : '') + ` [${state.today.src}]`),
        state.today.segments.length
          ? state.today.segments.map((s, i) => h('div', { key: i, style: infoStyle }, `${s[0]} – ${s[1]} 上班`))
          : h('div', { style: infoStyle }, '全天休息，时间都是自己的'))),

    events && (events.self.length || events.disturb.length) ? h('div', { style: { marginBottom: 10 } },
      h('div', { style: { ...infoStyle, fontWeight: 500, marginBottom: 4 } }, '接下来的安排'),
      [...events.disturb.map((e) => ({ ...e, kind: '扰动' })), ...events.self.map((e) => ({ ...e, kind: '自记' }))].slice(0, 10).map((e) =>
        h('div', { key: e.id, style: { display: 'flex', alignItems: 'baseline', gap: 8, borderBottom: '1px dashed rgba(128,128,128,.25)', padding: '3px 0' } },
          h('span', { style: { ...infoStyle, minWidth: 92 } }, e.day + (e.start ? ' ' + e.start : '')),
          h('span', { style: { flex: 1, ...infoStyle } }, `${e.what || e.note}（${e.kind}）`),
          h('button', { onClick: () => cancelEvent(e.id), style: { fontSize: 11, padding: '1px 8px', borderRadius: 999, border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: 'inherit', cursor: 'pointer' } }, '取消')))) : null,

    h('div', { style: { marginBottom: 10 } },
      h('div', { style: { ...infoStyle, fontWeight: 500, marginBottom: 4 } }, '每周固定班表（空=休息，格式 09:00-18:00，多段用逗号隔开）'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 } },
        DOWS.map(([d, name]) => h('label', { key: d, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
          h('span', { style: { width: 16 } }, name),
          h('input', {
            value: draft?.[d] ?? '', onChange: (e) => setDraft({ ...draft, [d]: e.target.value }),
            placeholder: d === 'sat' || d === 'sun' ? '休息' : '09:00-18:00',
            style: { flex: 1, minWidth: 0, fontSize: 12, padding: '3px 6px', borderRadius: 6, border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: 'inherit' },
          }))),
      ),
      h('button', { onClick: saveWeek, disabled: busy, style: { marginTop: 6, fontSize: 12, padding: '4px 14px', borderRadius: 999, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', cursor: 'pointer' } }, '保存班表')),

    h('div', null,
      h('div', { style: { ...infoStyle, fontWeight: 500, marginBottom: 4 } }, '最近的判定痕迹'),
      history.slice(0, 14).map((it, i) => h('div', { key: i, style: { display: 'flex', gap: 8, alignItems: 'baseline', borderBottom: '1px dashed rgba(128,128,128,.25)', padding: '3px 0' } },
        h('span', small, fmt(it.at)),
        h('span', { style: infoStyle }, ({
          day: () => `翻日，压力 ${it.pressure}`,
          state: () => `${it.label}`,
          livin: () => `过日子${it.to}（${it.why}）`,
          leave: () => `压力到顶，${it.day}请假（压力降到 ${it.pressure}）`,
          'self-add': () => `记了日程：${it.day} ${it.what}`,
          'self-cancel': () => `取消日程：${it.what}`,
          schedule: () => '改了班表',
        }[it.event] || (() => it.event))())))),
  )
}
