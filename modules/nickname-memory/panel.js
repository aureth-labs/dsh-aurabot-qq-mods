// 昵称记忆面板：手动改、加、删她记着的称呼
const { useState, useEffect } = React

const inputStyle = {
  border: '1px solid rgba(128,128,128,.35)', borderRadius: 8, padding: '6px 10px',
  fontSize: 13, background: 'transparent', color: 'inherit', minWidth: 0,
}

const chipStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  border: '1px solid rgba(128,128,128,.28)', borderRadius: 999,
  padding: '1px 8px', fontSize: 12,
}

return function Panel({ toast }) {
  const [people, setPeople] = useState(null)
  const [query, setQuery] = useState('')
  const [newQQ, setNewQQ] = useState('')
  const [newName, setNewName] = useState('')
  const [draft, setDraft] = useState({})
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  const reload = () => call('/list')
    .then((r) => {
      if (r?.ok) { setPeople(r.people || []); setProblem('') }
      else { setPeople([]); setProblem(r?.message || '读不到称呼本') }
    })
    .catch(() => { setPeople([]); setProblem('读不到称呼本') })
  useEffect(() => { reload() }, [])

  const apply = (r) => {
    if (r?.people) setPeople(r.people)
    toast(r?.message || (r?.ok ? '好了' : '没成功'))
    return r
  }

  const add = async () => {
    if (busy) return
    const qq = newQQ.trim()
    const name = newName.trim()
    if (!/^\d{5,12}$/.test(qq)) { toast('QQ 号要写 5~12 位数字'); return }
    if (!name) { toast('叫法是空的'); return }
    setBusy(true)
    try {
      const r = apply(await call('/set', { qq, name }))
      if (r?.ok) { setNewQQ(''); setNewName('') }
    } catch { toast('出错了') }
    setBusy(false)
  }

  const saveName = async (qq) => {
    const name = String(draft[qq] ?? '').trim()
    if (!name) { toast('叫法是空的'); return }
    setBusy(true)
    try {
      const r = apply(await call('/set', { qq, name }))
      if (r?.ok) setDraft((prev) => { const next = { ...prev }; delete next[qq]; return next })
    } catch { toast('出错了') }
    setBusy(false)
  }

  const dropAlias = async (qq, name) => {
    setBusy(true)
    try { apply(await call('/remove', { qq, name })) } catch { toast('出错了') }
    setBusy(false)
  }

  const forget = async (qq) => {
    if (!window.confirm(`把 ${qq} 的叫法全忘掉？`)) return
    setBusy(true)
    try { apply(await call('/forget', { qq })) } catch { toast('出错了') }
    setBusy(false)
  }

  const list = (people || []).filter((p) => {
    const needle = query.trim().toLowerCase()
    if (!needle) return true
    return p.qq.includes(needle) || p.names.some((n) => n.name.toLowerCase().includes(needle))
  })

  const rowTitle = (text) => h('span', { className: 'ab-note', style: { flex: '0 0 auto' } }, text)

  return h(ui.Card, { title: '称呼本' },
    h('p', { className: 'ab-note' },
      '她记着谁该怎么称呼。改这里的叫法，她下一轮就会用新的；旧的叫法还能认人，点 × 可以删掉。'),

    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '10px 0' } },
      h('input', {
        style: { ...inputStyle, flex: '0 0 150px' },
        placeholder: 'QQ 号',
        value: newQQ,
        onChange: (e) => setNewQQ(e.target.value),
      }),
      h('input', {
        style: { ...inputStyle, flex: '1 1 140px' },
        placeholder: '怎么称呼他，比如 老张',
        value: newName,
        onChange: (e) => setNewName(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') add() },
      }),
      h(ui.Btn, { onClick: add, disabled: busy }, '加一个'),
      h('input', {
        style: { ...inputStyle, flex: '1 1 140px' },
        placeholder: '在这本子里找…',
        value: query,
        onChange: (e) => setQuery(e.target.value),
      }),
    ),

    people === null
      ? h('p', { className: 'ab-note' }, '读着…')
      : !people.length
        ? h(ui.Empty, { text: problem || '称呼本还是空的。她在群里听到别人怎么叫人，会自己记；你也可以在上面加一条。' })
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          list.map((p) => {
            const current = p.current
            const others = p.names.map((n) => n.name).filter((n) => n !== current)
            const editing = draft[p.qq] !== undefined && draft[p.qq] !== current
            return h('div', {
              key: p.qq,
              style: {
                display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
                padding: '6px 8px', border: '1px solid rgba(128,128,128,.18)', borderRadius: 10,
              },
            },
              h('input', {
                style: { ...inputStyle, flex: '0 0 150px' },
                value: draft[p.qq] ?? current,
                onChange: (e) => setDraft((prev) => ({ ...prev, [p.qq]: e.target.value })),
                onKeyDown: (e) => { if (e.key === 'Enter') saveName(p.qq) },
              }),
              rowTitle(p.qq),
              editing ? h(ui.Btn, { onClick: () => saveName(p.qq), disabled: busy }, '保存') : null,
              h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', flex: '1 1 120px' } },
                others.map((name) => h('span', { key: name, style: chipStyle },
                  name,
                  h('span', {
                    style: { cursor: 'pointer', opacity: .6 },
                    title: '删掉这个叫法',
                    onClick: () => dropAlias(p.qq, name),
                  }, '×'),
                )),
              ),
              h(ui.Btn, { onClick: () => forget(p.qq), disabled: busy }, '忘掉'),
            )
          }),
        ),

    h('p', { className: 'ab-note', style: { marginTop: 10 } },
      list.length && people ? `共 ${people.length} 个人，显示 ${list.length} 个。` : ''),
  )
}
