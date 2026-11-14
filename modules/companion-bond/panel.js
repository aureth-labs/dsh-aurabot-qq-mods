const { useEffect, useState } = React
return function CompanionBondPanel({ toast }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const r = await call('/status')
        if (!r.ok) throw new Error(r.message || '状态读取失败')
        if (active) { setData(r); setError('') }
      } catch (e) { if (active) setError(e.message) }
    }
    load()
    const timer = setInterval(load, 15000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  async function act(action) {
    setBusy(true)
    try {
      const r = await call('/interact', { action })
      toast(r.message || '已完成')
      const next = await call('/status')
      if (next.ok) { setData(next); setError('') }
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  const meter = (label, value, max) => h('div', { style: { margin: '12px 0' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '5px' } },
      h('span', null, label), h('span', { className: 'ab-muted' }, `${value} / ${max}`)),
    h('progress', { value, max, 'aria-label': label, style: { width: '100%', accentColor: '#9b7ad6', height: '8px' } }))
  if (!data) return h(ui.Card, { title: '相伴养成' }, h('p', null, error || '正在读取相处状态…'))
  const names = { chat: '聊天', feed: '喂饭', play: '玩耍', touch: '摸摸', sleep: '休息', wake: '醒来' }
  return h(ui.Card, { title: '相伴养成' },
    error ? h('p', { role: 'alert' }, error) : null,
    h('div', { style: { fontSize: '22px', fontWeight: 600 } }, `${data.stage} · Lv.${data.level}`),
    h('p', { className: 'ab-note' }, '养成的是和你聊天的她。每次相处，都慢慢积累成你们的默契。'),
    meter('亲密度', data.bond, 1000),
    meter('本级经验', data.xp - data.levelBase, data.nextXp - data.levelBase),
    meter('精神', data.energy, 100), meter('愉悦', data.joy, 100),
    h('p', null, data.sleeping ? '正在休息，精神随时间恢复。' : '醒着，可以聊聊天，或一起玩一会儿。'),
    data.nextStage ? h('p', { className: 'ab-muted' }, `再积累 ${data.nextBond - data.bond} 点亲密度，就到「${data.nextStage}」。`) : null,
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '16px 0' } },
      ...[['play', '陪她玩'], ['touch', '摸摸'], [data.sleeping ? 'wake' : 'sleep', data.sleeping ? '叫醒她' : '让她休息']].map(([action, label]) =>
        h(ui.Btn, { key: action, disabled: busy, onClick: () => act(action) }, label))),
    h('p', { className: 'ab-small ab-muted' }, `今日成长次数：聊天 ${data.daily.chat} · 喂饭 ${data.daily.feed} · 玩耍 ${data.daily.play} · 摸摸 ${data.daily.touch}`),
    h('p', { className: 'ab-note' }, data.feedAvailable ? '喂饭继续用原来的「喂食」模块；实际吃到后约 15 秒同步成长。' : '喂食模块未启用，暂时无法同步投喂；其他互动可正常使用。'),
    h('p', { className: 'ab-note' }, '在 QQ 私聊发送「养成状态」查看，发送「养成帮助」了解玩法。面板互动只更新状态，回复会在后续 QQ 聊天中体现。'),
    data.events.length ? h('div', { style: { marginTop: '16px' } },
      h('strong', null, '最近相处'),
      ...data.events.slice(-5).reverse().map((e, i) => h('p', { key: i, className: 'ab-small ab-muted' },
        `${new Date(e.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${names[e.kind]}${e.bond ? ` · 亲密度 +${e.bond}` : ''}`))) : null)
}
