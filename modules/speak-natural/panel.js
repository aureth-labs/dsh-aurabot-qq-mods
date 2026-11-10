// 说话自然度 · 面板
const { useState, useEffect, useCallback } = React

return function SpeakNaturalPanel({ settings, save, toast }) {
  const [st, setSt] = useState(null)
  const [err, setErr] = useState('')
  const [input, setInput] = useState('好呀～那我给你讲讲这张图吧♡ 首先呢，画面里是一位蓝发少女（啪嗒啪嗒拍水花），她端着白米饭♡♡ 总之希望你喜欢(´･ω･`)(´･ω･`)')
  const [out, setOut] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setSt(await call('/state')); setErr('') } catch (e) { setErr(String(e && e.message ? e.message : e)) }
  }, [])

  useEffect(() => { load() }, [load])

  const tryIt = async () => {
    setBusy(true)
    try {
      const r = await call('/try', { text: input, where: 'group:0' })
      setOut((r && r.after) || '')
    } catch (e) {
      toast('出错：' + (e && e.message ? e.message : e))
    } finally { setBusy(false) }
  }

  const row = (k, v) => h('div', { className: 'ab-small', key: k }, `${k}：${v}`)

  return h('div', null,
    h(ui.Card, { title: '说话自然度' },
      h('p', { className: 'ab-note' },
        '让说话的调子像正常人打字：短、不解释、不总结、不堆颜文字。'
        + '上面「规则」负责让她本来就想这么说，「兜底」负责发出去前剪掉明显累赘。'),
      st
        ? h('div', null,
          row('开关', st.enabled ? '开' : '关'),
          row('群里的正常度', st.modeGroup),
          row('私聊的正常度', st.modePrivate),
          row('颜文字上限', st.maxKaomoji + ' 个/条'),
          row('符号上限', st.maxSymbols + ' 个/条'),
          row('去括号动作', st.stripActions ? '是' : '否'),
          row('去书面语开头', st.stripFiller ? '是' : '否'),
        )
        : h('p', { className: 'ab-muted' }, err ? '读不到状态：' + err : '读取中…'),

      h('p', { className: 'ab-muted ab-small' },
        '档位说明：不改 / 轻（只剪明显累赘）/ 正常（短句少表情，去动作）/ 严格（几乎不用颜文字）。'
        + '私聊建议「轻」，留着她自己的味道；群里建议「正常」。'),
    ),

    h(ui.Card, { title: '试剪一段' },
      h('textarea', {
        className: 'ab-input',
        style: { width: '100%', minHeight: '88px', fontFamily: 'inherit' },
        value: input,
        onChange: (e) => setInput(e.target.value),
      }),
      h(ui.Row, null,
        h(ui.Btn, { onClick: tryIt, disabled: busy }, busy ? '处理中…' : '按群里的档位剪一下'),
      ),
      out
        ? h('div', null,
          h('p', { className: 'ab-small' }, '剪完：'),
          h('pre', { className: 'ab-note', style: { whiteSpace: 'pre-wrap', margin: 0 } }, out),
        )
        : null,
      h('p', { className: 'ab-muted ab-small' }, '只是看效果，不会真的发出去。'),
    ),
  )
}
