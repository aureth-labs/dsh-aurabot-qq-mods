// 时间线面板：查看/编辑日程 JSON、看某天生效日程、AI 拟稿、应用草稿、看动作日志。
// 契约（见插件 client.js ExtPanel）：源码交给面板受限作用域执行（React/h/ui/call），最后 return 一个组件函数。
// 模块 settings 的开关/话题/自动拟稿等走自动生成的表单；这里只负责「日程本体」。

/** 北京时间（UTC+8）的今天，YYYY-MM-DD */
function bjToday() {
  return Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}
function fmtB(b) {
  return `${b.start}-${b.end} ${b.title}` + (b.source && b.source !== 'week' ? ` · ${b.source}` : '')
}

/** 北京时间的小时分钟 → 分钟数 */
function bjNowMin() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}
/** 年月日 → 周几（1=周一..7=周日） */
function wdIndex(dateKey) {
  const r = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!r) return 1
  const d = new Date(Date.UTC(+r[1], +r[2] - 1, +r[3]))
  const w = d.getUTCDay()
  return w === 0 ? 7 : w
}
function toMin(s) {
  const p = String(s || '').match(/(\d{1,2}):(\d{2})/)
  return p ? +p[1] * 60 + +p[2] : 0
}
function bjNowTxt() {
  const m = bjNowMin()
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 从整份 JSON 里算出某天的块（面板自己的小计，与模块一致）。d 可能还是 null（还没加载完），所以要判空。 */
function blocksOf(d, dateKey, limitFromNow) {
  const out = []
  const pick = (arr, source) => (arr || []).forEach((it) => {
    const b = Array.isArray(it) ? { start: it[0], end: it[1], title: it[2] } : it
    if (!b || !b.start || !b.end || b.start === b.end || toMin(b.start) >= toMin(b.end)) return
    out.push({ ...b, source })
  })
  const ev = (d?.events || {})[dateKey]
  if (ev) { out.length = 0; out.push({ start: '00:00', end: '24:00', title: '【' + (ev.title || '有事的日子') + '】' + (ev.note || ''), source: 'event' }) }
  if ((d?.holidays || {})[dateKey]) out.push({ start: '00:00', end: '24:00', title: '节假日·' + d.holidays[dateKey], source: 'holiday' })
  pick(d?.week && d?.week[wdIndex(dateKey)], 'week')
  pick(d?.overrides && d?.overrides[dateKey], 'override')
  out.sort((a, b) => toMin(a.start) - toMin(b.start))
  if (limitFromNow) return out.filter((b) => toMin(b.start) >= bjNowMin())
  return out
}

return function TimelinePanel({ toast }) {
  const [data, setData] = React.useState(null)
  const [persona, setPersona] = React.useState(null)
  const [status, setStatus] = React.useState(null)
  const [json, setJson] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [day, setDay] = React.useState(bjToday())
  const todayKey = bjToday()

  const refresh = () => call('/timeline').then((r) => {
    const d = r.data || {}
    setData(d)
    setPersona(r.persona || null)
    setStatus(r.status || null)
    setJson(JSON.stringify(d, null, 2))
  }).catch((e) => toast('加载失败：' + (e.message || e), 'err'))
  React.useEffect(() => { refresh() }, [])

  const blocks = data ? blocksOf(data, day, false) : []
  const rest = (day === todayKey && data) ? blocksOf(data, day, true) : []
  const cur = rest.length ? rest[0] : null

  const doSave = async () => {
    try { JSON.parse(json) } catch (e) { toast('JSON 有问题：' + e.message, 'err'); return }
    setBusy('save')
    try {
      const r = await call('/timeline/save', { json })
      if (!r.ok) toast('保存失败：' + (r.error || ''), 'err')
      else { toast('已保存，几秒内生效', 'ok'); refresh() }
    } catch (e) { toast(e.message, 'err') }
    setBusy('')
  }

  const aiPlan = async () => {
    setBusy('ai')
    try {
      const r = await call('/timeline/ai', { date: day })
      if (!r.ok) toast('拟稿失败：' + (r.error || ''), 'err')
      else { toast(`${day} 拟好了，${(r.blocks || []).length} 块（草稿，未生效）`, 'ok'); refresh() }
    } catch (e) { toast(e.message, 'err') }
    setBusy('')
  }

  const doRebuild = async () => {
    setBusy('rebuild')
    try {
      const r = await call('/timeline/rebuild', {})
      if (!r.ok) toast('重建失败：' + (r.error || ''), 'err')
      else { toast(`已按「${(r.meta && r.meta.weekPersonaId) || '当前人格'}」重建周表（${r.source}）`, 'ok'); refresh() }
    } catch (e) { toast(e.message, 'err') }
    setBusy('')
  }

  const applyDraft = async (tday) => {
    const dr = (data?.drafts || {})[tday]
    if (!dr) { toast(tday + ' 没有草稿', 'err'); return }
    setBusy('apply')
    try {
      const r = await call('/timeline/apply', { date: tday, blocks: dr.blocks })
      if (!r.ok) toast('应用失败：' + (r.error || ''), 'err')
      else { toast(`${tday} 已生效（进 overrides）`, 'ok'); refresh() }
    } catch (e) { toast(e.message, 'err') }
    setBusy('')
  }

  return h('div', { className: 'ab-grid' },
    h(ui.Card, { title: '时间线是什么', desc: '她的日程表：回复涉及「你在做什么 / 几点 / 今天安排 / 考试放假」时，先把当前块注入她的上下文，避免她即兴编时间。普通闲聊不注入。数据全在模块 JSON 里，可改、可追溯。' },
      h('div', { className: 'ab-small ab-muted', style: { lineHeight: 1.8 } },
        '· 命中「注入话题」才注入；模式可设为每轮注入关。',
        h('br'), '· 她回答时间问题前会先调 my_schedule 查自己的日程。',
        h('br'), '· 人工改 JSON、AI 拟稿、到点自动拟稿都能用，操作记在日志里。')),

    h(ui.Card, { title: '人格与周表', desc: '周表按当前人格正文的作息拟；换了人格会自动重排。' },
      h('div', { className: 'ab-small', style: { lineHeight: 1.9 } },
        '当前人格：', h('b', null, (persona && persona.name) || '（读不到）')),
      (persona && persona.rhythm) ? h('div', { className: 'ab-small ab-muted' }, '身份倾向：' + persona.rhythm) : null,
      (status && status.needsWeek) ? h('div', { className: 'ab-small ab-note' }, '⚠ 还没给当前人格建过周表，建议先点下面的「按人格重建周表」。') : null,
      (status && status.stalePersona) ? h('div', { className: 'ab-small ab-note' }, '⚠ 这套周表是别的人格建的，已过时。') : null,
      h('div', { className: 'ab-flex', style: { marginTop: 8 } },
        h(ui.Btn, { onClick: doRebuild, disabled: busy === 'rebuild' }, busy === 'rebuild' ? '重建中…' : '按人格重建周表'))),

    h(ui.Card, { title: '看某一天', desc: '选日期看这一天的生效日程（周模板 + 当日覆盖 + 节假日/事件）。' },
      h('div', { className: 'ab-flex' },
        h('input', { type: 'date', value: day, onChange: (e) => setDay(e.target.value), style: { minWidth: 180 } }),
        h(ui.Btn, { small: true, onClick: () => setDay(todayKey) }, '回今天')),
      (day === todayKey) ? h('div', { className: 'ab-small ab-muted' }, `北京时间现在 ${bjNowTxt()}`) : null,
      h('div', { className: 'ab-small', style: { marginTop: 8, lineHeight: 1.9 } },
        blocks.length
          ? blocks.map((b, i) => h('div', { key: i },
            fmtB(b),
            (day === todayKey && i === 0 && cur) ? '　（当前）' : ''))
          : '这天还没有安排（在下面编辑 JSON）'),
      (day === todayKey && cur) ? h('div', { className: 'ab-muted' }, '现在在：' + fmtB(cur)) : null),

    h(ui.Card, { title: '日程 JSON 编辑器', desc: '直接改整份 JSON。week 是「1=周一…7=周日 → [[开始, 结束, 内容]]」；overrides[日期] 覆盖当天的块；holidays[日期] 节日名；events[日期] 整天事件。改完点保存。' },
      h('textarea', {
        value: json,
        onChange: (e) => setJson(e.target.value),
        rows: 18,
        style: { width: '100%', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 },
      }),
      h('div', { className: 'ab-flex', style: { marginTop: 8 } },
        h(ui.Btn, { onClick: doSave, disabled: busy === 'save' }, busy === 'save' ? '保存中…' : '保存 JSON'))),

    h(ui.Card, { title: 'AI 拟稿', desc: '让飞鱼拟某天草稿（参考天气、节假日、心情、记忆）。草稿不直接生效，确认后用「应用」。' },
      h('div', { className: 'ab-flex' },
        h('input', { type: 'date', value: day, onChange: (e) => setDay(e.target.value) }),
        h(ui.Btn, { small: true, onClick: aiPlan, disabled: busy === 'ai' }, busy === 'ai' ? '拟稿中…' : '拟这天草稿')),
      h('div', { className: 'ab-small', style: { marginTop: 8 } },
        Object.entries(data?.drafts || {}).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 4).map(([k, v]) => h('div', { key: k, style: { padding: '4px 0', borderBottom: '1px solid var(--ab-border, rgba(128,128,128,.2))' } },
          h('div', null, k, ' · ', (v.blocks || []).length, ' 块 · ', (v.source || ''), v.status === 'active' ? ' · 已生效' : ''),
          h('div', { className: 'ab-muted', style: { marginTop: 4 } }, (v.blocks || []).map(fmtB).join('；')),
          h(ui.Btn, { small: true, onClick: () => applyDraft(k), disabled: busy === 'apply' }, '应用到这一天'))))),

    h(ui.Card, { title: '动作日志', desc: '最近几条操作，用来追溯谁改了什么。' },
      h('div', { className: 'ab-small ab-muted' },
        ((data && data.log && data.log.length) ? data.log.slice(-8).reverse() : []).map((x, i) =>
          h('div', { key: i }, `${new Date(x.at).toLocaleString('zh-CN')} · ${x.action} · ${x.detail}`)))),
  )
}
