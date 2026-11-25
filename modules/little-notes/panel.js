// 小本本面板：一本真的手账——手写字、左右翻页、划掉留痕；下面还能替她补一笔
const { useState, useEffect } = React

const KIND_LABEL = { said: '他说过', promise: '答应过', fact: '他的事', note: '随手记' }
const KINDS = ['said', 'promise', 'fact', 'note']
const PAGE_URL = '/aurabot/api/ext/little-notes/page'

return function Panel({ settings, save, toast }) {
  const [notes, setNotes] = useState(null)
  const [text, setText] = useState('')
  const [about, setAbout] = useState('')
  const [newKind, setNewKind] = useState('note')
  const [busy, setBusy] = useState(false)

  const reload = () => { call('/notes').then((r) => setNotes(r?.notes || [])).catch(() => setNotes([])) }
  useEffect(() => { reload() }, [])

  const add = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      // 面板里补的笔记入到最新一条所在的那本，一般就是和主人的私聊
      const first = (notes || [])[0]?.chatId || (await call('/notes'))?.notes?.[0]?.chatId || 'private:0'
      const r = await call('/add', {
        chatId: first,
        text: text.trim(),
        about: about.trim() || '主人',
        kind: newKind,
        tags: [],
        important: false,
      })
      if (r?.ok) { toast('记好了，翻到最后一页看看'); setText(''); reload() }
      else toast(r?.message || '没记上')
    } catch { toast('出错了') }
    setBusy(false)
  }

  const inputStyle = {
    border: '1px solid rgba(128,128,128,.35)', borderRadius: 8, padding: '6px 10px',
    fontSize: 13, flex: '1 1 120px', minWidth: 0, background: 'transparent', color: 'inherit',
  }

  return h(ui.Card, { title: '小本本' },
    h('p', { className: 'ab-note' }, '她想到就记一笔的本子。点一条可以划掉（会留着划掉的痕迹，也能恢复）或标个星；翻页点右下角/左下角，或下面的按钮。'),

    h('div', { style: { marginTop: 8 } },
      h('iframe', {
        src: PAGE_URL,
        style: { width: '100%', height: '72vh', minHeight: 480, border: '1px solid rgba(128,128,128,.25)', borderRadius: 12 },
      }),
    ),

    h('div', { style: { borderTop: '1px solid rgba(128,128,128,.18)', paddingTop: 10, marginTop: 10 } },
      h('p', { className: 'ab-note' }, '替她记一笔'),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        h('input', { style: { ...inputStyle, flex: '2 1 200px' }, placeholder: '内容：谁、什么时候、什么事', value: text, onChange: (e) => setText(e.target.value) }),
        h('input', { style: inputStyle, placeholder: '关于谁（可空）', value: about, onChange: (e) => setAbout(e.target.value) }),
        h('select', { value: newKind, onChange: (e) => setNewKind(e.target.value), style: inputStyle, flex: '0 0 auto' },
          KINDS.map((k) => h('option', { key: k, value: k }, KIND_LABEL[k]))),
        h(ui.Btn, { onClick: add, disabled: busy || !text.trim() }, busy ? '记着…' : '记一笔'),
      ),
      h('p', { className: 'ab-small ab-muted', style: { marginTop: 8 } }, '记到她聊天的那本上（通常是和主人的私聊）。想管理她脑子里的长期印象请用记忆面板。'),
    ),
  )
}
