// 人机反面教材 + 真人金句 · 面板
const { useState, useEffect, useCallback } = React

return function AntiBotPanel({ settings, save, toast }) {
  const [st, setSt] = useState(null)
  const [err, setErr] = useState('')
  const [text, setText] = useState('')
  const [test, setTest] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setSt(await call('/state')); setErr('') } catch (e) { setErr(String(e && e.message ? e.message : e)) }
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  const doTest = async () => {
    if (!text.trim()) return
    setBusy(true)
    try { setTest(await call('/test', { text })) } catch (e) { toast('出错：' + (e && e.message ? e.message : e)) } finally { setBusy(false) }
  }

  const doAdd = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      const r = await call('/add', { text })
      toast(r && r.ok ? '记成反例了' : '没记（重复或不够像人机）')
      setText(''); setTest(null); await load()
    } catch (e) { toast('出错：' + (e && e.message ? e.message : e)) } finally { setBusy(false) }
  }

  const doAddGood = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      const r = await call('/add-good', { text })
      toast(r && r.ok ? '收成金句了' : '没收（重复或不太够格）')
      setText(''); setTest(null); await load()
    } catch (e) { toast('出错：' + (e && e.message ? e.message : e)) } finally { setBusy(false) }
  }

  const doRemove = async (t) => {
    try { await call('/remove', { text: t }); await load() } catch (e) { toast('删不掉：' + (e && e.message ? e.message : e)) }
  }
  const doRemoveGood = async (t) => {
    try { await call('/remove-good', { text: t }); await load() } catch (e) { toast('删不掉：' + (e && e.message ? e.message : e)) }
  }

  const fmt = (t) => {
    if (!t) return ''
    const d = new Date(t)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  const bad = (st && st.items) || []
  const good = (st && st.goods) || []

  const line = (x, onDel) => h('div', { key: x.text, style: { marginBottom: '10px', paddingBottom: '8px', borderBottom: '1px solid rgba(255,255,255,.06)' } },
    h('div', { className: 'ab-small', style: { opacity: .95 } }, '「' + String(x.text).slice(0, 120) + '」'),
    h('div', { className: 'ab-muted ab-small' }, `${x.why || ''} · ${x.score} 分 · ${fmt(x.at)}${x.source ? ' · ' + x.source : ''}`),
    h(ui.Btn, { small: true, onClick: onDel }, '删'),
  )

  return h('div', null,
    h(ui.Card, { title: '人机反面教材 · 真人金句' },
      h('p', { className: 'ab-note' },
        '两头学：一眼就是 AI 的发言记成反面教材（别学），真人说得有意思的句子收成金句（学那个劲儿）。'
        + '每轮聊天都会把最近几条塞给她看。'),
      st
        ? h('div', null,
          h('div', { className: 'ab-small' }, `反例：${st.total} 条（今天 +${st.today}）· 门槛 ${st.threshold} 分`),
          h('div', { className: 'ab-small' }, `金句：${st.goodTotal} 条（今天 +${st.goodToday}）· 门槛 ${st.goodThreshold} 分`),
          h('div', { className: 'ab-small' }, `每轮塞：反例 ${st.injectCount} 条 + 金句 ${st.injectGood} 条（${st.injectWhere}）`),
        )
        : h('p', { className: 'ab-muted' }, err ? '读不到状态：' + err : '读取中…'),
    ),

    h(ui.Card, { title: '测一句 / 手动收' },
      h('textarea', {
        className: 'ab-input',
        style: { width: '100%', minHeight: '72px', fontFamily: 'inherit' },
        placeholder: '粘一句评论进来，看看是人机还是金句',
        value: text,
        onChange: (e) => { setText(e.target.value); setTest(null) },
      }),
      h(ui.Row, null,
        h(ui.Btn, { onClick: doTest, disabled: busy || !text.trim() }, '测一下'),
        h(ui.Btn, { onClick: doAdd, disabled: busy || !text.trim() }, '当反例记下'),
        h(ui.Btn, { onClick: doAddGood, disabled: busy || !text.trim() }, '当金句收下'),
      ),
      test
        ? h('div', { className: 'ab-note' },
          h('div', null, `人机 ${test.score} 分 ${test.botlike ? '✓ 像人机' : '· 不像'}`),
          h('div', null, `金句 ${test.wit} 分 ${test.good ? '✓ 有那味儿' : '· 一般'}`),
          (test.hits && test.hits.length) || (test.witHits && test.witHits.length)
            ? h('div', { className: 'ab-small' }, '命中：' + [...(test.hits || []), ...(test.witHits || [])].join('、'))
            : null,
        )
        : null,
    ),

    h(ui.Card, { title: '反例（最近 20 条）' },
      bad.length === 0
        ? h(ui.Empty, null, '还没有。看 B 站时会自动学，也可以粘一句进来手动加。')
        : bad.map((x) => line(x, () => doRemove(x.text))),
    ),

    h(ui.Card, { title: '金句（最近 20 条）' },
      good.length === 0
        ? h(ui.Empty, null, '还没有。有反转/比喻/自嘲/具体细节的真人话会自动收进来。')
        : good.map((x) => line(x, () => doRemoveGood(x.text))),
    ),
  )
}
