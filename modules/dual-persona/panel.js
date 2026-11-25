// 双重人格面板：一屏平铺展开，不折叠、不翻页；互斥的两种模式 + 五种规则。
// 开没开由设置里的「启用双重人格」开关管（在面板上方），这里只管模式和规则。
// 写法参照 history-vault / little-notes：ui.Card 分节、ab-note 做说明、ui.Switch 做开关。
const { useState } = React

const inputStyle = {
  border: '1px solid rgba(128,128,128,.35)', borderRadius: 8, padding: '5px 9px',
  fontSize: 13, background: 'transparent', color: 'inherit', minWidth: 0,
}
const rowStyle = { display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', margin: '8px 0' }
const labelStyle = { minWidth: 120, fontSize: 13, lineHeight: '26px' }
const hintStyle = { fontSize: 12, opacity: 0.62, lineHeight: 1.55 }
const ctlStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: '1 1 320px' }
const headStyle = { fontSize: 13.5, fontWeight: 600, margin: '14px 0 2px' }
const secStyle = { borderTop: '1px solid rgba(128,128,128,.16)', paddingTop: 10, marginTop: 12 }
const warnStyle = { color: '#c2410c', fontSize: 12, lineHeight: 1.6, margin: '6px 0' }

const BtnSmall = (props, label) => h(ui.Btn, { ...props, style: { fontSize: 12, padding: '3px 10px' } },
  label !== undefined ? label : props && props.children)

const Row = ({ label, hint, children }) => h('div', { style: rowStyle },
  h('div', { style: labelStyle }, label),
  h('div', { style: ctlStyle },
    children,
    hint ? h('div', { style: { ...hintStyle, flex: '1 1 100%' } }, hint) : null),
)

const Section = ({ title, hint, children }) => h('div', { style: secStyle },
  h('div', { style: headStyle }, title),
  hint ? h('div', { style: hintStyle }, hint) : null,
  children,
)

// 互斥选择：用两个按钮拼一个分段控件，比原生 radio 更像开关
const Seg = ({ value, options, onChange }) => h('div', {
  style: {
    display: 'inline-flex', border: '1px solid rgba(128,128,128,.35)', borderRadius: 8,
    overflow: 'hidden', fontSize: 12.5,
  },
},
  options.map((o) => h('button', {
    key: o.value,
    onClick: () => onChange(o.value),
    style: {
      border: 'none', cursor: 'pointer', padding: '5px 14px',
      background: value === o.value ? 'rgba(120,120,255,.25)' : 'transparent',
      color: 'inherit', fontWeight: value === o.value ? 600 : 400,
    },
  }, o.label)))

const NumBox = ({ value, onChange, min = 0, max = 100, step = 1, suffix = '' }) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
  h('input', {
    type: 'range', min, max, step, value: Number(value) || 0,
    style: { width: 130 },
    onChange: (e) => onChange(Number(e.target.value)),
  }),
  h('input', {
    type: 'number', min, max, step, value: Number(value) || 0, style: { ...inputStyle, width: 68 },
    onChange: (e) => onChange(Number(e.target.value) || 0),
  }),
  suffix ? h('span', { style: hintStyle }, suffix) : null,
)

const PersonaSel = ({ value, onChange, personas, empty = '（不选）', width = 150 }) => h('select', {
  value: value || '', style: { ...inputStyle, width },
  onChange: (e) => onChange(e.target.value),
},
  h('option', { value: '' }, empty),
  (personas || []).map((p) => h('option', { key: p.id, value: p.id }, p.name || p.id)),
)

// 号码串解析：跟模块 lib/split.mjs 同一套规则，只用于面板上即时预览
const PREFIX_RE = /^(group|群|g|private|私聊|p|user|qq)\s*[:：]?\s*(\d{3,})$/i
const parseIds = (text, groupNums) => {
  const ids = []
  const unknown = []
  for (const tok of String(text || '').split(/[\s,，;；、|/]+/).filter(Boolean)) {
    const m = PREFIX_RE.exec(tok)
    if (m) {
      const kind = /^(group|群|g)$/i.test(m[1]) ? 'group' : 'private'
      ids.push(`${kind}:${m[2]}`)
    } else if (/^\d{3,}$/.test(tok)) {
      ids.push(groupNums.has(tok) ? `group:${tok}` : `private:${tok}`)
    } else {
      unknown.push(tok)
    }
  }
  return { ids: [...new Set(ids)], unknown }
}

// 存的时候把「没选」补成当前人格，读的时候也把空值显示成当前人格
const fillPersona = (id, cur) => (id === '' ? cur : id)
const withDefaults = (p, cur) => {
  const out = JSON.parse(JSON.stringify(p))
  out.split.default = fillPersona(out.split.default, cur)
  for (const r of out.split.rows) r.persona = fillPersona(r.persona, cur)
  for (const s of out.timed.slots) s.persona = fillPersona(s.persona, cur)
  for (const d of Object.keys(out.monthly.days)) out.monthly.days[d] = fillPersona(out.monthly.days[d], cur)
  for (const b of out.mood.bands) b.persona = fillPersona(b.persona, cur)
  for (const key of ['randomFixed', 'randomTemp']) for (const x of out[key].pool) x.persona = fillPersona(x.persona, cur)
  return out
}

let saveTimer = null

return function Panel({ settings, save, toast }) {
  const [view, setView] = useState(null)
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState('')
  const [problem, setProblem] = useState('')

  const load = async () => {
    try {
      const r = await call('/state')
      if (r && r.ok) { setView(r); setPlan(r.plan); setProblem('') }
      else setProblem((r && r.message) || '读不到模块状态')
    } catch (e) {
      setProblem('读不到模块状态，看看「已安装」页有没有报错')
    }
  }
  if (!view && !problem && !busy) load()

  const personas = (view && view.personas) || []
  const curId = (view && view.current && view.current.id) || ''
  const curName = (view && view.current && view.current.name) || curId
  const pname = (id) => (personas.find((p) => p.id === id) || {}).name || id || ''
  const clone = (p) => JSON.parse(JSON.stringify(p || {}))

  // 跟面板其它设置一样：改了就存，不用再点「保存」。拖动滑块时合并成一次保存。
  // 配置那边是深合并：像「每月排班」这种按天存的字典，删掉某天不能只靠让它消失，
  // 得显式发一个空串把它盖掉（模块读的时候空人格会被丢掉）。
  const savePatch = (next) => {
    const out = withDefaults(next, curId)
    const stored = (view && view.plan && view.plan.monthly && view.plan.monthly.days) || {}
    out.monthly.days = out.monthly.days || {}
    for (const k of Object.keys(stored)) {
      if (!out.monthly.days[k]) out.monthly.days[k] = ''
    }
    return out
  }
  const scheduleSave = (next) => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      try { save({ plan: next }) } catch (e) { toast && toast('保存失败：' + e.message) }
    }, 500)
  }
  const edit = (fn) => {
    const next = clone(plan)
    fn(next)
    setPlan(next)
    scheduleSave(savePatch(next))
  }
  const setMode = (m) => edit((p) => { p.mode = m })

  const applyNow = async (id) => {
    setBusy('apply')
    try {
      const r = await call('/apply', { persona: id })
      toast && toast((r && r.message) || '已换卡')
      if (r && r.ok) { setView(r); setPlan(r.plan) }
    } catch (e) { toast && toast('换卡失败：' + e.message) }
    setBusy('')
  }

  const resetSession = async (chatId) => {
    setBusy('reset')
    try {
      const r = await call('/reset', { chatId })
      toast && toast((r && r.message) || '已清掉')
      if (r && r.ok) { setView(r); setPlan(r.plan) }
    } catch (e) { toast && toast('清掉失败：' + e.message) }
    setBusy('')
  }

  if (!view || !plan) {
    return h(ui.Card, { title: '双重人格' },
      h('p', { className: 'ab-note' }, problem || '读取中……'),
      problem ? h(ui.Btn, { onClick: () => { setProblem(''); load() } }, '重试') : null,
    )
  }

  const groupNums = new Set((view.chats || []).filter((c) => c.kind === 'group').map((c) => c.chatId.slice(6)))
  const chatLabel = new Map((view.chats || []).map((c) => [c.chatId, c.label]))
  const labelOf = (chatId) => chatLabel.get(chatId) || (chatId.startsWith('group:') ? '群 ' + chatId.slice(6) : '私聊 ' + chatId.slice(8))
  const on = !settings || settings.enabled !== false
  const mode = plan.mode === 'global' ? 'global' : 'split'

  const ruleSwitch = (key, hint) => h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' } },
    h(ui.Switch, { on: plan[key].enabled === true, onChange: (v) => edit((p) => { p[key].enabled = v }) }),
    h('span', { style: hintStyle }, plan[key].enabled ? '这一条规则开着' : hint || '这一条规则关着'))

  // 生效范围（QQ 号 / 群号）：分裂模式下必须填，不填这条规则就不生效；全局模式下不用填。
  const ScopeField = (key, label = '生效范围') => {
    const r = plan[key] || {}
    const pv = (view.scopePreview && view.scopePreview[key]) || { resolved: [], unknown: [] }
    const resolved = pv.resolved || []
    const unknown = pv.unknown || []
    const split = mode === 'split'
    return h(Row, {
      label,
      hint: split ? '填群号或私聊 QQ 号，一行可以多个；只对这些聊天生效，不填就不生效。' : '全局模式下这一条对所有聊天生效，不用填范围。',
    },
      h('input', {
        type: 'text', value: r.scope || '', placeholder: split ? '例如 170625223, 1773199891' : '（全局模式不用填）',
        style: { ...inputStyle, flex: '1 1 240px' },
        onChange: (e) => edit((p) => { p[key].scope = e.target.value }),
      }),
      h('div', { style: { flex: '1 1 100%', ...hintStyle } },
        split ? (resolved.length ? '→ ' + resolved.map((x) => x.label).join('、') : '→ 还没填号码')
          : '→ 全局生效',
        unknown.length ? '；认不出：' + unknown.join('、') : ''),
      split && r.enabled && !resolved.length
        ? h('div', { style: { flex: '1 1 100%', ...warnStyle } }, '分裂模式下没填生效范围，这一条不会生效。')
        : null,
    )
  }

  // ---------- 模式（开关在上面的设置里）----------
  const master = h(Section, { title: '模式' },
    h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', margin: '8px 0', flexWrap: 'wrap' } },
      h(Seg, {
        value: mode,
        onChange: setMode,
        options: [{ value: 'split', label: '人格分裂' }, { value: 'global', label: '全局人格切换' }],
      }),
      h('span', { style: hintStyle }, mode === 'split'
        ? '不同聊天用不同的人格卡，不碰全局卡。'
        : '定时 / 每月 / 心情 到点换全局人格卡，所有聊天一起变。')),
    !on ? h('p', { className: 'ab-note' }, '上面「启用双重人格」现在是关的，这里配好的规则要等它打开才生效。') : null,
  )

  // ---------- 人格分裂（紧挨着总开关）----------
  const splitSection = on && mode === 'split' ? h(Section, {
    title: '人格分裂',
    hint: '左边填群号 / 私聊 QQ 号（一行可以填多个，逗号空格都行），右边选这个聊天用哪张人格卡。随机切换关着也照样生效。',
  },
    h(Row, { label: '公共默认人格', hint: '没单独设置的聊天都用这张；默认是当前人格卡。' },
      h(PersonaSel, {
        value: plan.split.default || curId,
        onChange: (v) => edit((p) => { p.split.default = v }),
        personas, empty: '（跟全局卡）',
      })),
    (plan.split.rows || []).map((row, i) => {
      const parsed = parseIds(row.ids, groupNums)
      const resolved = parsed.ids.map(labelOf)
      return h('div', { key: 'r' + i, style: { borderTop: '1px dashed rgba(128,128,128,.2)', paddingTop: 8, marginTop: 8 } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { ...hintStyle, width: 26 } }, String(i + 1)),
          h('input', {
            type: 'text', value: row.ids, placeholder: '例如 170625223, 1773199891',
            style: { ...inputStyle, flex: '1 1 240px' },
            onChange: (e) => edit((p) => { p.split.rows[i].ids = e.target.value }),
          }),
          h(PersonaSel, {
            value: row.persona || curId,
            onChange: (v) => edit((p) => { p.split.rows[i].persona = v }),
            personas, empty: '（跟公共默认）',
          }),
          BtnSmall({ onClick: () => edit((p) => { p.split.rows.splice(i, 1) }) }, '删'),
        ),
        h('div', { style: { ...hintStyle, marginTop: 4, paddingLeft: 34 } },
          resolved.length ? '→ ' + resolved.join('、') : '→ 还没填号码',
          parsed.unknown.length ? '；认不出：' + parsed.unknown.join('、') : ''),
      )
    }),
    (plan.split.rows || []).length < 60
      ? h('div', { style: { marginTop: 10 } }, BtnSmall({
        onClick: () => edit((p) => { p.split.rows.push({ ids: '', persona: curId }) }),
      }, '+ 新增一组'))
      : h('span', { style: hintStyle }, '最多 60 组'),
    h('p', { style: hintStyle }, '同一个聊天被好几组命中时，下面那一组算数。号码不带前缀时：是已知群号就算群，否则算私聊；想指定就写 group:群号 / 私聊:QQ 号。'),
  ) : null

  // ---------- 定时 / 每月 / 心情（两种模式都显示）----------
  const ruleSections = on ? h('div', null,
    h(Section, {
      title: '定时切换（每天）',
      hint: mode === 'global'
        ? '到点就把全局人格卡换成选的那张；可以加多个时刻。'
        : '到点只把「生效范围」里那几个聊天换成选的那张，不动全局卡。',
    },
      ruleSwitch('timed'),
      ScopeField('timed'),
      (plan.timed.slots || []).map((s, i) => h('div', { key: 't' + i, style: { display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' } },
        h('input', {
          type: 'time', value: s.at || '08:00', style: { ...inputStyle, width: 110 },
          onChange: (e) => edit((p) => { p.timed.slots[i].at = e.target.value }),
        }),
        h(PersonaSel, {
          value: s.persona || curId,
          onChange: (v) => edit((p) => { p.timed.slots[i].persona = v }),
          personas, empty: '（跟当前人格）',
        }),
        BtnSmall({ onClick: () => edit((p) => { p.timed.slots.splice(i, 1) }) }, '删'),
      )),
      (plan.timed.slots || []).length < 24
        ? BtnSmall({ onClick: () => edit((p) => { p.timed.slots.push({ at: '08:00', persona: curId }) }) }, '+ 添加一个时刻')
        : h('span', { style: hintStyle }, '最多 24 个时刻'),
    ),

    h(Section, {
      title: '每月排班',
      hint: mode === 'global'
        ? '给某几天定一张人格卡，从那天 0 点起生效；没选的天不动。'
        : '到那天只把「生效范围」里那几个聊天换成这张卡，不动全局卡。',
    },
      ruleSwitch('monthly'),
      ScopeField('monthly'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(11, 1fr)', gap: 4, maxWidth: 460, margin: '8px 0' } },
        Array.from({ length: 31 }, (_, k) => k + 1).map((d) => {
          const set = Boolean(plan.monthly.days && plan.monthly.days[String(d)])
          return h('button', {
            key: 'd' + d,
            onClick: () => edit((p) => {
              p.monthly.days = p.monthly.days || {}
              if (set) delete p.monthly.days[String(d)]
              else p.monthly.days[String(d)] = curId
            }),
            style: {
              cursor: 'pointer', fontSize: 12, padding: '4px 0', borderRadius: 6, color: 'inherit',
              border: '1px solid rgba(128,128,128,.3)',
              background: set ? 'rgba(120,120,255,.22)' : 'transparent',
            },
          }, d)
        })),
      Object.keys(plan.monthly.days || {}).sort((a, b) => a - b).map((d) => h('div', { key: 'm' + d, style: { display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' } },
        h('span', { style: { ...hintStyle, width: 48 } }, d + ' 号'),
        h(PersonaSel, { value: plan.monthly.days[d] || curId, onChange: (v) => edit((p) => { p.monthly.days[d] = v }), personas }),
        BtnSmall({ onClick: () => edit((p) => { delete p.monthly.days[d] }) }, '删'),
      )),
    ),

    h(Section, {
      title: '按心情切换',
      hint: mode === 'global'
        ? '她的心情值落进哪个区间，就换成那个区间的人格卡。'
        : '心情落进区间时，只把「生效范围」里那几个聊天换成对应的卡。',
    },
      ruleSwitch('mood'),
      ScopeField('mood'),
      h(Row, { label: '心情值从哪来', hint: '「插件心情」读她自己的心情模块；「手动」就用下面填的固定值。' },
        h('select', {
          value: plan.mood.source || 'auto', style: { ...inputStyle, width: 120 },
          onChange: (e) => edit((p) => { p.mood.source = e.target.value }),
        },
          h('option', { value: 'auto' }, '插件心情'),
          h('option', { value: 'manual' }, '手动固定值')),
        NumBox({ value: plan.mood.manual, onChange: (v) => edit((p) => { p.mood.manual = v }) })),
      (plan.mood.bands || []).map((b, i) => h('div', { key: 'b' + i, style: { display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0', flexWrap: 'wrap' } },
        h('span', { style: hintStyle }, '心情'),
        h('input', {
          type: 'number', value: b.min, min: 0, max: 100, style: { ...inputStyle, width: 64 },
          onChange: (e) => edit((p) => { p.mood.bands[i].min = Number(e.target.value) || 0 }),
        }),
        h('span', { style: hintStyle }, '到'),
        h('input', {
          type: 'number', value: b.max, min: 0, max: 100, style: { ...inputStyle, width: 64 },
          onChange: (e) => edit((p) => { p.mood.bands[i].max = Number(e.target.value) || 0 }),
        }),
        h('span', { style: hintStyle }, '时用'),
        h(PersonaSel, { value: b.persona || curId, onChange: (v) => edit((p) => { p.mood.bands[i].persona = v }), personas }),
        BtnSmall({ onClick: () => edit((p) => { p.mood.bands.splice(i, 1) }) }, '删'),
      )),
      (plan.mood.bands || []).length < 12
        ? BtnSmall({ onClick: () => edit((p) => { p.mood.bands.push({ min: 0, max: 40, persona: curId }) }) }, '+ 添加一个区间')
        : h('span', { style: hintStyle }, '最多 12 个区间'),
    ),
  ) : null

  // ---------- 随机（两种模式都能用）----------
  const randomBlock = (key, title, hint) => {
    const r = plan[key]
    return h(Section, { title, hint },
      ruleSwitch(key),
      ScopeField(key),
      h(Row, { label: '总概率', hint: '这个会话一开始时，有这么大概率会换；没中就不换。' },
        NumBox({ value: r.totalPercent, onChange: (v) => edit((p) => { p[key].totalPercent = v }), suffix: '%' })),
      key === 'randomFixed' && mode === 'global' ? h(Row, { label: '作用范围', hint: '「只当前会话」不动全局卡；「全局」会真的换掉所有人格。' },
        h('select', {
          value: r.target || 'chat', style: { ...inputStyle, width: 130 },
          onChange: (e) => edit((p) => { p[key].target = e.target.value }),
        },
          h('option', { value: 'chat' }, '只当前会话'),
          h('option', { value: 'global' }, '全局'))) : null,
      h('div', { style: { ...hintStyle, margin: '10px 0 4px' } }, '人格池（权重是相对比例，默认 1）'),
      (r.pool || []).map((x, i) => h('div', { key: key + i, style: { display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' } },
        h(PersonaSel, { value: x.persona || curId, onChange: (v) => edit((p) => { p[key].pool[i].persona = v }), personas }),
        h('span', { style: hintStyle }, '权重'),
        h('input', {
          type: 'number', value: x.weight, min: 0, step: 1, style: { ...inputStyle, width: 64 },
          onChange: (e) => edit((p) => { p[key].pool[i].weight = Math.max(0, Number(e.target.value) || 0) }),
        }),
        BtnSmall({ onClick: () => edit((p) => { p[key].pool.splice(i, 1) }) }, '删'),
      )),
      (r.pool || []).length < 30
        ? BtnSmall({ onClick: () => edit((p) => { p[key].pool.push({ persona: curId, weight: 1 }) }) }, '+ 添加一个人格')
        : h('span', { style: hintStyle }, '最多 30 个'),
      h('p', { style: warnStyle }, '频繁切换人格会导致缓存命中率降低，可能导致额外的开销，请勿设置过高的触发概率。'),
    )
  }
  const randomSections = on ? h('div', null,
    randomBlock('randomFixed', '随机·固定', '每个会话开始时掷一次；中了这个会话就一直用它。'),
    randomBlock('randomTemp', '随机·临时', '每个会话开始时掷一次；只在那一轮生效，下一轮自动失效。'),
  ) : null

  // ---------- 状态 ----------
  const state = h(Section, { title: '现在的状态' },
    h('p', { className: 'ab-note' }, '当前全局人格卡：' + (curName || '（没读到）') + (on ? '；双重人格已开启（' + (mode === 'split' ? '人格分裂' : '全局人格切换') + '）' : '；双重人格关着')),
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0', flexWrap: 'wrap' } },
      h(PersonaSel, { value: '', onChange: (v) => v && applyNow(v), personas, empty: '立刻换成……' }),
      h('span', { style: hintStyle }, '换的是全局人格卡，下一轮生效')),
    (view.sessions || []).length
      ? h('div', { style: { margin: '8px 0' } },
        h('div', { style: hintStyle }, '本会话单独开着的人格：'),
        view.sessions.map((s) => h('div', { key: s.chatId, style: { display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0' } },
          h('span', { style: { fontSize: 12.5 } }, labelOf(s.chatId) + ' · ' + (s.name || s.persona) + '（' + s.mode + '）'),
          BtnSmall({ onClick: () => resetSession(s.chatId) }, '清掉'),
        )))
      : h('p', { className: 'ab-note' }, '现在没有哪个会话单独开着人格。'),
    (view.history || []).length
      ? h('div', { style: { marginTop: 10 } },
        h('div', { style: hintStyle }, '最近 ' + view.history.length + ' 次切换：'),
        h('div', { className: 'ab-note', style: { maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', lineHeight: 1.7 } },
          view.history.map((x) => new Date(x.at).toLocaleString() + '  ' + (x.from || '—') + ' → ' + (x.name || x.to) + (x.note ? '（' + x.note + '）' : '')).join('\n')))
      : null,
  )

  return h(ui.Card, { title: '双重人格' },
    h('p', { className: 'ab-note' }, '改了会自动存，不用点保存。打开设置里的「启用双重人格」后默认按「人格分裂」：每条规则都要填生效范围（QQ 号 / 群号），只对范围里的聊天生效；切成「全局人格切换」时不用填范围，规则直接换全局人格卡。'),
    master,
    splitSection,
    ruleSections,
    randomSections,
    state,
  )
}
