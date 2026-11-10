// 自主学习 · 面板
const { useState, useEffect, useCallback } = React

return function SelfLearnPanel({ settings, save, toast }) {
  const [st, setSt] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState('')

  const load = useCallback(async () => {
    try { setSt(await call('/state')); setErr('') } catch (e) { setErr(String(e && e.message ? e.message : e)) }
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t) }, [load])

  const runNow = async () => {
    setBusy(true)
    try {
      const r = await call('/now', {})
      toast((r && r.message) || '跑完了')
      await load()
    } catch (e) { toast('出错：' + (e && e.message ? e.message : e)) } finally { setBusy(false) }
  }

  const makeReport = async () => {
    setBusy(true)
    try {
      const r = await call('/make-report', {})
      setReport((r && r.text) || '')
      toast('小结写好了')
      await load()
    } catch (e) { toast('出错：' + (e && e.message ? e.message : e)) } finally { setBusy(false) }
  }

  const fmt = (t) => {
    if (!t) return '还没跑过'
    const d = new Date(t)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  const today = (st && st.today) || {}
  const hist = (st && st.history) || []

  return h('div', null,
    h(ui.Card, { title: '自主学习' },
      h('p', { className: 'ab-note' },
        '没人叫它也会自己跑：定时去 B 站抓真人评论，挑出「人机反例」和「真人金句」收进库；'
        + '再从聊天流水里学真人怎么说话。跑完写一份小结。'),
      st
        ? h('div', null,
          h('div', { className: 'ab-small' }, `${st.enabled ? '开着' : '关着'} · ${st.intervalHours} 小时一轮 · 一天最多 ${st.maxRunsPerDay} 轮`),
          h('div', { className: 'ab-small' }, `今天：${today.runs || 0} 轮｜反例 ${today.bots || 0}｜金句 ${today.goods || 0}｜真人发言 ${today.ownerLines || 0}`),
          h('div', { className: 'ab-small' }, `上次：${fmt(today.lastAt)}${st.nextInMinutes ? `（再等 ${st.nextInMinutes} 分钟）` : ''}`),
          today.lastError ? h('div', { className: 'ab-small', style: { color: '#e57373' } }, '最近出错：' + today.lastError) : null,
        )
        : h('p', { className: 'ab-muted' }, err ? '读不到状态：' + err : '读取中…'),
      h(ui.Row, null,
        h(ui.Btn, { onClick: runNow, disabled: busy || (st && st.busy) }, busy || (st && st.busy) ? '正在学…' : '现在学一轮'),
        h(ui.Btn, { onClick: makeReport, disabled: busy }, '写今天的小结'),
        h(ui.Btn, { onClick: load }, '刷新'),
      ),
    ),

    h(ui.Card, { title: '最近几轮' },
      hist.length === 0
        ? h(ui.Empty, null, '还没跑过')
        : hist.map((h2, i) => h('div', { key: i, style: { marginBottom: '8px' } },
          h('div', { className: 'ab-small' }, `${fmt(h2.at)} · ${h2.reason || ''}`),
          h('div', { className: 'ab-muted ab-small' }, `反例 ${h2.bots}｜金句 ${h2.goods}｜真人发言 ${h2.ownerLines}${h2.detail ? '｜' + h2.detail : ''}`),
        )),
    ),

    report
      ? h(ui.Card, { title: '今天的小结' },
        h('pre', { className: 'ab-note', style: { whiteSpace: 'pre-wrap', margin: 0, fontSize: '12px' } }, report),
      )
      : null,
  )
}
