// 人格运行时面板：从内置版 client.js 的「人格运行时（persona-runtime）页」移植。
// 拿到 React / h / ui(Card,Btn,Switch,Row,Empty) / call / settings / save / toast。
// 与内置版的差异：
//   · 数据源从内置 get/post 换成模块的 call('/persona-runtime/...')（index.mjs 里 api.route 注册，
//     全部 { access: 'panel' }）；
//   · 开关与预算不再走宿主配置草稿（ext.persona-runtime.*），改走本模块的 settings/save
//     （api.settings() 即模块设置，index.mjs 的 defaults/settings 声明已含全部键）；
//   · ui 组件用面板自带的 ui.Card / ui.Btn / ui.Row / ui.Empty，不发明新样式。
const { useState, useEffect, useCallback } = React

// 九开关分组（口径与内置面板一致：留四个、收编两个、自留两个、改造一个）
const RT_SWITCH_GROUPS = [
  {
    title: '体验开关（她是谁）',
    desc: '关掉哪一段，她这轮就少那一层。全关等于「安静日的她」——人格卡基线 + 心情旧口径，不是陌生人。',
    keys: [
      ['selfAware', '自我意识', '「我是谁、在跟谁说话」的稳定指向。关了她只靠人格卡正文，长对话可能自称漂移'],
      ['affectThought', '情感思想', '判断带好恶、有温度。关了就是中性助手腔，有问必答没态度'],
      ['affectPerceive', '情感感知', '撒娇接得住、抱怨先共情、玩笑不较真。关了是字面理解（「我自己来」她就真不管）'],
      ['emotionMemory', '情绪记忆', '聊天气氛有连续性。关了每条消息情绪从零开始'],
      ['agentIdentity', '独立智能体身份', '群聊/被 @ 时以自己的名字与身份应答'],
    ],
  },
  {
    title: '安全开关（她的权限边界）',
    desc: '这两个不是语气开关——它们管的是「她在对话里能申报多重的本机动作」。分级与硬禁区永远优先于开关：开了也不会突破硬禁区，只留开关没有审计回滚就是伪安全。',
    keys: [
      ['adminMode', '超级管理员', '开：主机级动作（写数据/碰主人侧）可以在对话里申报；关：主机级一律软拒「这个我做不了主」'],
      ['hostTakeover', '宿主接管', '开：她的所有主机动作一律排队等你亲自放行——永不进「免确认」豁免'],
    ],
  },
]

// 行内数字编辑器（预算键用；保存即生效，不用重载模块）
function numField(label, hint, key, settings, save, min, max, step) {
  return h(ui.Row, { label, hint },
    h('input', {
      className: 'ab-input', type: 'number', min, max, step, style: { width: '90px' },
      value: Number(settings && settings[key]) || 0,
      onChange: (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) save({ [key]: v }) },
    }))
}

// 开关行（switch 类设置；保存即生效）
function switchRow(key, label, hint, settings, save) {
  const on = !!(settings && settings[key])
  return h(ui.Row, { label, hint }, h(ui.Switch, { on, onChange: () => save({ [key]: !on }) }))
}

return function Panel({ settings, save, toast }) {
  const [s, setS] = useState(null)
  const [pv, setPv] = useState(null) // 零副作用试拼预览
  const [busy, setBusy] = useState('')
  const [probeText, setProbeText] = useState('')

  const load = useCallback(() => {
    call('/persona-runtime/status').then((r) => { if (r && r.ok) setS(r); else setS(null) }).catch(() => setS(null))
  }, [])
  useEffect(() => {
    load()
    const t = setInterval(load, 15000) // 与内置版同节奏
    return () => { clearInterval(t) }
  }, [load])

  const act = async (key, path, body) => {
    setBusy(key)
    try {
      const r = await call(path, body || {})
      toast(r.message || (r.ok === false ? '没成' : '好了'), r && r.ok === false ? 'err' : 'ok')
    } catch (e) { toast(e.message, 'err') } finally { setBusy(''); load() }
  }
  const doPreview = async () => {
    setBusy('preview')
    try {
      const r = await call('/persona-runtime/preview', { text: probeText, chatKind: 'private' })
      if (r && r.ok) setPv(r); else toast((r && r.message) || '试拼失败', 'err')
    } catch (e) { toast(e.message, 'err') } finally { setBusy('') }
  }
  const doClear = () => act('clear', '/persona-runtime/emotions/clear')
  const doIgnite = () => act('ignite', '/persona-runtime/ignite', { reason: '面板手动点火' })

  const fmtAt = (ts) => (Number(ts) ? new Date(Number(ts)).toLocaleString() : '—')
  const pfx = (s && s.prefix) || {}
  const res = (s && s.residuals) || { items: [] }
  const emo = s && s.emotion
  const brg = (s && s.bridge) || {}
  const ign = (s && s.ignite) || {}
  const duty = (s && s.duty) || {}

  // ---------- 卡片 1：运行状态 ----------
  const cardStatus = h(ui.Card, {
    title: '运行状态',
    desc: '她每轮回复前会读一遍这几段。这里显示的是「这一层此刻是什么样」——不是另一个引擎，是同一个她在对话里的样子。',
  },
    !s ? h('div', { className: 'ab-muted ab-small' }, '加载中…（或模块没在跑）') : null,
    s && s.configError ? h('div', { className: 'ab-note err' }, '配置读不出来，安全开关（超级管理员/宿主接管）已按「关」处理——这是 fail-closed，不是故障。查一下面板设置能不能正常保存。') : null,
    h(ui.Row, { label: '管线触点', hint: '她只在回复管线的这一处被注入，不碰发送、不立项' },
      h('span', { className: 'ab-small' }, (s && s.pipeline && s.pipeline.touchpoint) || "api.on('prompt')")),
    h(ui.Row, { label: '注入顺序', hint: '离生成最近的排最后：自我指向权重最高，情绪记忆最先被裁' },
      h('span', { className: 'ab-small' }, ((s && s.pipeline && s.pipeline.order) || ['perceive', 'affect', 'memory', 'identity']).join(' → '))),
    h(ui.Row, { label: '落盘文件', hint: '刻意保持薄：只存开关快照，情绪真相在心情模块、前缀在 prefix.js、审计在自驱引擎' },
      h('span', { className: 'ab-muted ab-small' }, ((s && s.pipeline && s.pipeline.dataDirFiles) || ['runtime.json']).join('、'))),
    h(ui.Row, { label: '情绪来源', hint: 'Runtime 只读心情模块，不设第二个写入口——她的情绪只有一个真相' },
      emo && emo.top
        ? h('span', { className: 'ab-small' }, (emo.top.label || emo.top.key) + ' · 强度 ' + (Number(emo.value) || 0) + ' · 更新于 ' + fmtAt(emo.at))
        : h('span', { className: 'ab-muted ab-small' }, '心情模块没跑或没有数据')),
  )

  // ---------- 卡片 2：九开关（两组） ----------
  const switchRows = RT_SWITCH_GROUPS.map((g) => h('div', { key: g.title },
    h('div', { className: 'ab-small ab-muted', style: { margin: '10px 0 4px 2px' } }, g.title),
    h('div', { className: 'ab-small ab-muted', style: { margin: '0 0 8px 2px', opacity: 0.85 } }, g.desc),
    g.keys.map(([key, label, hint]) => switchRow(key, label, hint, settings, save)),
  ))
  const cardSwitches = h(ui.Card, {
    title: '总开关与九个开关',
    desc: '总开关关掉整层（= 安静日的她，不是陌生人）；九个开关各管一段，保存即生效、不用重载模块。',
  },
    switchRow('enabled', '启用人格运行时', '总开关。关掉整个 Runtime 层（≠插件总开关）：回复管线精确退回「人格卡 + mood 旧口径」', settings, save),
    switchRows,
    h('div', { className: 'ab-note' },
      '主动思考不在这里单独列——它被改造为「点火入口」：开「activeThinking」后，重要对话结束会向自驱引擎转发一次点火。', '引擎没开时这条通道如实报 not-wired。'),
  )

  // ---------- 卡片 3：前缀同源（防漂移） ----------
  const cardPrefix = h(ui.Card, {
    title: '前缀同源',
    desc: '人格锚只有一份实现（prefix.js）、一个输入源。两个 hash 不一致就说明接线漂移了——那是必须查的信号。自驱引擎没跑 / 插件内部文件拿不到时这里会如实标注。',
  },
    pfx.drift ? h('div', { className: 'ab-note err' }, '⚠ 前缀不一致：' + (pfx.why || '两边的输入源不同步')) : null,
    !pfx.drift && pfx.why ? h('div', { className: 'ab-note' }, pfx.why) : null,
    h(ui.Row, { label: '人格运行时 hash' }, h('span', { className: 'ab-small', style: { fontFamily: 'monospace' } }, pfx.runtimeHash || '—')),
    h(ui.Row, { label: '同源输入重算 hash' }, h('span', { className: 'ab-small', style: { fontFamily: 'monospace' } }, pfx.autotelicHash || '—')),
    h(ui.Row, { label: '对照结果', hint: '同源 = 两侧读的是同一份人格锚，不会各持副本' },
      pfx.drift
        ? h('span', { className: 'ab-small', style: { color: 'var(--ab-err, #c62828)' } }, '漂移')
        : h('span', { className: 'ab-small', style: { color: 'var(--ab-ok, #2e9e44)' } }, '一致 ✓')),
    h(ui.Row, { label: '人格摘要长度', hint: '本能附加段也在里面（本能晋升后长度会变）' },
      h('span', { className: 'ab-small' }, (pfx.personaChars || 0) + ' / ' + (pfx.personaMax || 1200) + ' 字符' + (pfx.instinctAddonInPersona ? ' · 含本能附加段' : ''))),
    h(ui.Row, { label: '稳定半段进 system', hint: '变化频率 ≤ 本能晋升级的才允许进 system；每轮变化的绝不进' },
      h('span', { className: 'ab-small' }, pfx.stableGetsSystem ? '允许（自我意识稳定半段）' : '不注入')),
  )

  // ---------- 卡片 4：注入预算 + 试拼 ----------
  const segRows = pv && Array.isArray(pv.segments)
    ? pv.segments.map((seg) => h(ui.Row, { key: seg.key, label: (seg.label || seg.key) },
      h('span', { className: 'ab-small' }, (seg.tokens == null ? '—' : seg.tokens + ' token') + (seg.cut ? ' · 已裁' : ''))))
    : null
  const cardBudget = h(ui.Card, {
    title: '注入预算与试拼',
    desc: '对话注入不是模型调用，是 prompt 拼装——预算管的是「别把每轮撑长」。超预算先裁情绪记忆、再裁感知、再裁思想；人格锚与约束永不裁。',
  },
    numField('每轮注入总预算（token）', '超了按钉死顺序降级，永不裁自我意识与人格锚', 'rtMaxInjectTokens', settings, save, 100, 4000, 50),
    numField('自我意识段', '永不裁；预算只做标注', 'rtIdentityTokens', settings, save, 40, 800, 10),
    numField('情感思想段', '', 'rtAffectTokens', settings, save, 40, 800, 10),
    numField('情感感知段', '', 'rtPerceiveTokens', settings, save, 40, 800, 10),
    numField('情绪记忆段', '含最近 N 条残余小史', 'rtMemoryTokens', settings, save, 40, 800, 10),
    h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 10, alignItems: 'center' } },
      h('input', {
        className: 'ab-input', style: { flex: 1 }, placeholder: '打一句想试的话，看她这轮会看到什么（零副作用，不写盘不动情绪）',
        value: probeText, onChange: (e) => setProbeText(e.target.value),
      }),
      h(ui.Btn, { small: true, disabled: busy === 'preview', onClick: doPreview }, busy === 'preview' ? '试拼中…' : '试拼')),
    pv ? h('div', { style: { marginTop: 10 } },
      pv.overflow ? h('div', { className: 'ab-note err' }, '⚠ 超出预算且裁无可裁：' + (pv.overflowReason || '') + (pv.uncutSegments && pv.uncutSegments.length ? '（永不裁：' + pv.uncutSegments.join('、') + '）' : '')) : null,
      h('div', { className: 'ab-small ab-muted' }, '语气：' + ((pv.tone && (pv.tone.label || pv.tone.tone)) || '—') + ' · 任务性：' + ((pv.taskness && pv.taskness.level) || '—') + ' · 合计 ' + (pv.totalTokens || 0) + ' / ' + (pv.budget || 0) + ' token'),
      segRows ? h('div', { className: 'ab-list', style: { marginTop: 6 } }, segRows) : null,
      pv.text ? h('div', { className: 'ab-note', style: { marginTop: 8, whiteSpace: 'pre-wrap' } }, pv.text) : h('div', { className: 'ab-muted ab-small' }, '这一段她什么都不用看到（开关可能关着）'),
      pv.degradation && pv.degradation.length ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '降级记录：' + pv.degradation.join('；')) : null,
    ) : h('div', { className: 'ab-muted ab-small', style: { marginTop: 8 } }, '点「试拼」看她这一轮会读到什么——不会真的发出去，也不动任何状态。'),
  )

  // ---------- 卡片 5：情绪残余 ----------
  const residualRows = (res.items || []).length
    ? res.items.map((r, i) => h('div', { key: i, className: 'ab-flex', style: { gap: 8, padding: '3px 0', alignItems: 'center' } },
      h('span', { className: 'ab-badge' }, r.label || '?'),
      h('span', { className: 'ab-small', style: { flex: 1 } }, r.direction === 'up' ? '↑ 心情往上走' : (r.direction === 'down' ? '↓ 心情往下沉' : '· 平稳')),
      h('span', { className: 'ab-muted ab-small' }, fmtAt(r.at))))
    : h(ui.Empty, { icon: '🫧', text: '最近 24 小时没有值得记住的情绪波动' })
  const cardResidual = h(ui.Card, {
    title: '情绪残余',
    desc: '她回味的不只是「发生了什么」，还有「我当时什么感受」。这些小史是从心情现状现场派生的，不落盘、不复制真相。',
  },
    h(ui.Row, { label: '摘要' }, h('span', { className: 'ab-small' }, res.summary || '—')),
    h(ui.Row, { label: '窗口', hint: '超过 24 小时的自动不再注入；最多 5 条' },
      h('span', { className: 'ab-muted ab-small' }, '近 ' + (res.windowHours || 24) + ' 小时 · 上限 ' + (res.max || 5) + ' 条')),
    h('div', { className: 'ab-list', style: { margin: '8px 0' } }, residualRows),
    h('div', { className: 'ab-flex', style: { gap: 8 } },
      h(ui.Btn, { small: true, disabled: busy === 'clear', onClick: doClear }, busy === 'clear' ? '清着…' : '清掉这些展示')),
    h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, res.note || '清它不动情绪向量——那部分归心情模块半衰，一会儿自己就淡了。'),
    s && s.lastInjection ? h('div', { className: 'ab-note', style: { marginTop: 10 } },
      '最近一次真实注入：' + (s.lastInjection.totalTokens || 0) + ' token · 各段 ' +
      (Array.isArray(s.lastInjection.segments) ? s.lastInjection.segments.map((x) => (x.label || x.key) + ':' + (x.tokens || 0)).join(' / ') : '—')
    ) : null,
  )

  // ---------- 卡片 6：两条单向出口 + 接线自检 ----------
  const cardOut = h(ui.Card, {
    title: '两条单向出口与自驱引擎协同',
    desc: '她只能往外送两样东西：情绪波动（当作经历喂给自驱引擎）和一次「有件事刚发生」的点火。判断权全在引擎那边——她不决定值不值得想。引擎没开时这两个出口不接线，人格运行时照常独立运行。',
  },
    h(ui.Row, { label: '观察桥', hint: '显著情绪波动 → 观察层：情绪也是经历' },
      h('span', { className: 'ab-small' },
        brg.wired
          ? '已接线 ✓ · 推送 ' + ((brg.stats && (brg.stats.emotion + brg.stats.note)) || 0) + ' 条（失败 ' + ((brg.stats && brg.stats.failed) || 0) + '）' + (brg.last && brg.last.at ? ' · 最近 ' + fmtAt(brg.last.at) : '')
          : '未接线（自驱引擎没在跑；情绪波动只进上下文，不写观察层）')),
    brg.last && brg.last.reason ? h(ui.Row, { label: '最近一次推送结果' }, h('span', { className: 'ab-muted ab-small' }, brg.last.reason)) : null,
    h(ui.Row, { label: '点火入口', hint: '重要对话结束后转发一次；冷却由自驱引擎统一管，防止事件风暴' },
      h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'center' } },
        h('span', { className: 'ab-small' }, ign.outcome === 'never' ? '还没点过' : ('最近：' + (ign.outcome || '—') + (ign.at ? ' · ' + fmtAt(ign.at) : ''))),
        h(ui.Btn, { small: true, disabled: busy === 'ignite', onClick: doIgnite }, busy === 'ignite' ? '点着…' : '现在点火试试'))),
    h(ui.Row, { label: 'duty 行动申报', hint: '主人在对话里委托她动手时，Runtime 只负责编译成票并标注 kind:duty，执行永远走自驱引擎那一条通道' },
      h('span', { className: 'ab-small' }, duty.last
        ? ((duty.last.status || '—') + '：' + (duty.last.why || duty.last.message || '') + ' · ' + fmtAt(duty.last.at))
        : '最近没有申报')),
    h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } },
      '审计接线：' + (duty.auditWired ? '已接线 ✓' : '未接线（宿主没挂自驱审计通道；她的动作不会留痕，属预期降级）')),
  )

  return h('div', { className: 'ab-page' },
    cardStatus, cardSwitches, cardPrefix, cardBudget, cardResidual, cardOut,
    h('div', { className: 'ab-small ab-muted', style: { marginTop: 10 } },
      '这一层管「她在每条消息里是谁」；对话外的生活（心念、行动、沉淀）在自驱引擎页。与自驱引擎协同，非必需依赖。'),
  )
}
