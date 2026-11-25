// 补回错过的@ · 面板
const { useState, useEffect, useCallback } = React

return function MentionsCatchupPanel({ settings, save, toast }) {
  const [st, setSt] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [scan, setScan] = useState(null)

  const load = useCallback(async () => {
    try { setSt(await call('/state')); setErr('') } catch (e) { setErr(String(e && e.message ? e.message : e)) }
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  const doScan = async () => {
    setBusy(true)
    try {
      const r = await call('/scan', {})
      setScan(r)
      toast(r && r.count ? `找到 ${r.count} 处漏掉的 @` : '没有漏掉的 @')
    } catch (e) { toast('出错：' + (e && e.message ? e.message : e)) } finally { setBusy(false) }
  }

  const doNow = async () => {
    setBusy(true)
    try {
      const r = await call('/now', {})
      toast((r && r.message) || '补完了')
      await load()
    } catch (e) { toast('出错：' + (e && e.message ? e.message : e)) } finally { setBusy(false) }
  }

  const fmt = (t) => {
    if (!t) return '还没跑过'
    const d = new Date(t)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const ago = (min) => (min >= 60 ? `${Math.round(min / 60)} 小时前` : `${min} 分钟前`)

  const items = (scan && scan.items) || []

  return h('div', null,
    h(ui.Card, { title: '补回错过的 @' },
      h('p', { className: 'ab-note' },
        '电脑不会 24 小时开机。这个会在开机、网关重连、以及每 30 分钟，'
        + '回去看一眼有没有「@ 了我、但我没回」的消息，攒够时间就补一句。'),
      st
        ? h('div', null,
          h('div', { className: 'ab-small' }, `${st.enabled ? '开着' : '关着'} · 盯着 ${st.groups.length} 个群：${st.groups.join('、') || '（无）'}`),
          h('div', { className: 'ab-small' }, `只补 ${st.maxAgeMinutes} 分钟以内 · 至少错过 ${st.minGapMinutes} 分钟才算 · 一次最多补 ${st.maxPerRun} 处`),
          h('div', { className: 'ab-small' }, `上次检查：${fmt(st.lastRunAt)} · 已记 ${st.handled} 条`),
        )
        : h('p', { className: 'ab-muted' }, err ? '读不到状态：' + err : '读取中…'),
      h(ui.Row, null,
        h(ui.Btn, { onClick: doScan, disabled: busy }, busy ? '检查中…' : '只检查不发'),
        h(ui.Btn, { onClick: doNow, disabled: busy }, '检查并补上'),
        h(ui.Btn, { onClick: load }, '刷新'),
      ),
      h('p', { className: 'ab-muted ab-small' },
        '「只检查不发」很安全：只列出来给你看，一个字都不发。'),
    ),

    scan
      ? h(ui.Card, { title: `漏掉的 @（${items.length}）` },
        items.length === 0
          ? h(ui.Empty, null, '没有漏掉的 @')
          : items.map((x) => h('div', { key: x.messageId, style: { marginBottom: '10px', paddingBottom: '8px', borderBottom: '1px solid rgba(255,255,255,.06)' } },
            h('div', { className: 'ab-small' }, `群 ${x.groupId} · ${x.name || x.userId} · ${ago(x.ageMinutes)}`),
            h('div', { className: 'ab-muted ab-small' }, '「' + String(x.text || '').slice(0, 100) + '」'),
          )))
      : null,
  )
}
