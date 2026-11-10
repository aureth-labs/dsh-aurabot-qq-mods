// 话题时效 · 面板
const { useState, useEffect, useCallback } = React

return function TopicFreshnessPanel({ settings, save, toast }) {
  const [st, setSt] = useState(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try { setSt(await call('/state')); setErr('') } catch (e) { setErr(String(e && e.message ? e.message : e)) }
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t) }, [load])

  const apply = async () => {
    try {
      const r = await call('/apply', {})
      toast(r && r.ok ? '已按当前分钟数调整窗口' : '没调成')
      await load()
    } catch (e) { toast('出错：' + (e && e.message ? e.message : e)) }
  }

  const groups = (st && st.groups) || []

  return h('div', null,
    h(ui.Card, { title: '话题时效' },
      h('p', { className: 'ab-note' },
        st
          ? `只在最近 ${st.minutes} 分钟还在聊的话题上接话；判定窗口 ${st.activeWindowSec} 秒 · 力度 ${st.strictness === 'hard' ? '严格' : '正常'}`
          : (err ? '读不到状态：' + err : '读取中…')),
      h(ui.Row, null,
        h(ui.Btn, { onClick: apply }, '按当前分钟数重设窗口'),
        h(ui.Btn, { onClick: load }, '刷新'),
      ),
      h('p', { className: 'ab-muted ab-small' },
        '「分钟数」在下面的设置里改；改完点上面的按钮让它立刻生效（否则要等下一轮）。'),
    ),
    h(ui.Card, { title: '各群现在在聊什么' },
      groups.length === 0
        ? h(ui.Empty, null, '最近还没收到群消息（或窗口内没有新消息）')
        : groups.map((g) => h('div', { key: g.groupId, style: { marginBottom: '10px' } },
          h('div', { className: 'ab-small' }, `群 ${g.groupId}｜最近 ${g.fresh} 条`),
          h('div', { className: 'ab-muted ab-small' }, (g.topics || []).join('、') || '（提不出话题词）'),
        )),
    ),
  )
}
