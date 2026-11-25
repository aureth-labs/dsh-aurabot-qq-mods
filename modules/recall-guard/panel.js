const { useState, useEffect } = React
return function Panel({ settings, save, toast }) {
  const [text, setText] = useState('今天在干麻，我以经到家了')
  const [res, setRes] = useState(null)
  const [stats, setStats] = useState(null)
  const [busy, setBusy] = useState(false)
  const on = settings.homophoneOn !== false
  const mode = settings.homophoneMode === 'always' ? 'always' : 'suspicious'

  const loadStats = async () => {
    try { setStats(await call('/stats')) } catch (e) { setStats({ ok: false, hits: 0, last: [] }) }
  }
  useEffect(() => { loadStats() }, [])

  const test = async () => {
    setBusy(true)
    try { setRes(await call('/try?text=' + encodeURIComponent(text))) } catch (e) { setRes({ ok: false, note: '接口调不通：' + e.message, typos: [] }) } finally { setBusy(false) }
  }

  return h('div', null,
    h(ui.Card, {
      title: '错字按同音理解',
      right: h(ui.Switch, { on, onChange: (v) => { save({ homophoneOn: v }); toast(v ? '已打开：错字按同音理解' : '已关闭：不再提示同音') } }),
    },
      h(ui.Row, { label: '状态与命中', hint: '对方打错字时，在她收到这句话之前补一句同音提示，让她按发音猜本意' },
        h('span', { style: { fontSize: 13 } }, (on ? '已打开' : '已关闭') + ' · 累计触发 ' + (stats && stats.hits ? stats.hits : 0) + ' 次')),
      h(ui.Row, { label: '提示方式', hint: '「只在可疑时」只在拼不出词、同音能拼出常用词时才加提示，最省 token' },
        h(ui.Select, {
          value: mode,
          width: 240,
          options: [
            { value: 'suspicious', label: '只在可疑时提示' },
            { value: 'always', label: '每条都提醒' },
          ],
          onChange: (v) => save({ homophoneMode: v }),
        })),
      h(ui.Row, { label: '候选个数', hint: '每个疑似错字给几个同音候选；给太多会干扰她判断' },
        h(ui.Select, {
          value: String(settings.homophoneMax || 3),
          width: 120,
          options: ['1', '2', '3', '4', '5'].map((n) => ({ value: n, label: n + ' 个' })),
          onChange: (v) => save({ homophoneMax: Number(v) }),
        })),
      h(ui.Row, { label: '试一句', hint: '这句话只在这里测算提示，不会发到 QQ' },
        h('textarea', {
          className: 'ab-textarea',
          rows: 3,
          style: { width: '100%' },
          value: text,
          onChange: (e) => setText(e.target.value),
        })),
      h('div', { style: { marginTop: 6 } },
        h(ui.Btn, { small: true, disabled: busy, onClick: test }, busy ? '测算中…' : '算一下会提示什么')),

      res ? h('div', { style: { marginTop: 10, padding: 10, borderRadius: 6, background: '#f6f7f9', fontSize: 13, lineHeight: 1.6 } },
        h('div', { style: { color: '#888' } },
          res.typos && res.typos.length ? ('识别到 ' + res.typos.length + ' 处疑似错字') : '没识别到错字'),
        h('div', { style: { marginTop: 6, whiteSpace: 'pre-wrap' } },
          res.note ? res.note : '（这条不会加提示，她照原文读）')
      ) : null,

      stats && stats.last && stats.last.length
        ? h('div', { style: { marginTop: 14 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '最近触发'),
          stats.last.map((it, i) => h('div', { key: i, style: { fontSize: 12, color: '#555', marginBottom: 4 } },
            (it.text || '') + '  →  ' + (it.note || '')))
        )
        : null
    )
  )
}
