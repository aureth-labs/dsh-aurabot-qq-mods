// 衣柜面板：加衣服、衣柜（左图右描述）、今天穿搭、生成预览、历史预览、基础描述。
const { useState, useEffect, useRef } = React

return function WardrobePage({ toast }) {
  const api = '/aurabot/api/ext/wardrobe'
  const [data, setData] = useState(null)
  const [history, setHistory] = useState([])
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [pose, setPose] = useState('stand')
  const [shot, setShot] = useState(null)
  const [thumbW, setThumbW] = useState(120)
  const [baseDraft, setBaseDraft] = useState('')
  const [makeupDraft, setMakeupDraft] = useState('')
  const [hairdoDraft, setHairdoDraft] = useState('')
  const [newHairName, setNewHairName] = useState('')
  const [newHairDesc, setNewHairDesc] = useState('')
  const [newMakeupName, setNewMakeupName] = useState('')
  const [newMakeupDesc, setNewMakeupDesc] = useState('')
  const [styleDraft, setStyleDraft] = useState('')
  const [draft, setDraft] = useState({})
  const [lookPreview, setLookPreview] = useState('')
  const [replaceId, setReplaceId] = useState('')
  const replaceRef = useRef(null)
  const fileRef = useRef(null)

  const imgUrl = (it) => api + '/image/file?id=' + encodeURIComponent(it.id) + '&t=' + (it.updatedAt || it.createdAt || 0)
  const prevUrl = (id) => api + '/preview/file?id=' + encodeURIComponent(id)

  const load = async () => {
    try {
      setErr('')
      const r = await fetch(api + '/list', { cache: 'no-store' }).then((x) => x.json())
      setData(r)
      setBaseDraft(r.base || '')
      setStyleDraft(r.style || '')
      const hd = (r.hairdos || []).find((h) => h.id === r.hairdoId)
      setHairdoDraft(hd ? hd.desc : '')
      const mk = (r.makeups || []).find((m) => m.id === r.makeupId)
      setMakeupDraft(mk ? mk.desc : '')
      const hs = await fetch(api + '/history', { cache: 'no-store' }).then((x) => x.json())
      setHistory(hs.list || [])
    } catch (e) { setErr(String((e && e.message) || e)) }
  }
  useEffect(() => { load() }, [])

  const post = async (path, body) => {
    const r = await fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
    return r.json()
  }

  const saveText = async () => {
    if (!desc.trim()) { toast && toast('先写一段描述'); return }
    setBusy(true)
    try {
      const r = await post('/add', { name, desc })
      if (r.ok === false) { toast && toast(r.message || '没存上'); return }
      setName(''); setDesc('')
      await load()
      toast && toast('已保存')
    } finally { setBusy(false) }
  }

  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!f) return
    setBusy(true)
    try {
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.onerror = reject
        fr.readAsDataURL(f)
      })
      const r = await post('/add', { name, desc, image: b64 })
      if (r.ok === false) { toast && toast(r.message || '没加上'); return }
      setName(''); setDesc('')
      await load()
      toast && toast(r.captioned ? '加好了，描述已自动生成' : '加好了')
    } finally { setBusy(false) }
  }

  const change = async (id) => {
    const r = await post('/today', { set: id })
    if (r.ok) setData({ ...data, today: r.today, outfit: r.outfit })
  }

  const applyLook = async () => {
    const r = await post('/look/apply', {})
    if (r && r.ok === false) { toast && toast(r.message || '没保存上'); return }
    setLookPreview(r.block || '')
    toast && toast('已保存，下一轮生效')
  }

  const setHairdo = async (id) => {
    const r = await post('/hair/set', { id })
    if (r && r.ok === false) { toast && toast(r.message || '切不过去'); return }
    await load()
  }
  const saveHairdo = async () => {
    const cur = (data.hairdos || []).find((h) => h.id === data.hairdoId)
    if (cur && hairdoDraft === cur.desc) return
    const r = await post('/hair/save', { id: data.hairdoId, desc: hairdoDraft })
    if (r && r.ok === false) { toast && toast(r.message || '没存上'); return }
    await load()
    toast && toast('发型已保存')
  }
  const addHairdo = async () => {
    if (!newHairName.trim() || !newHairDesc.trim()) { toast && toast('名字和描述都要写'); return }
    setBusy(true)
    try {
      const r = await post('/hair/add', { name: newHairName, desc: newHairDesc })
      if (r && r.ok === false) { toast && toast(r.message || '没加上'); return }
      setNewHairName(''); setNewHairDesc('')
      await load()
      toast && toast('发型已添加')
    } finally { setBusy(false) }
  }
  const delHairdo = async () => {
    if (!window.confirm('删掉当前这个发型？')) return
    const r = await post('/hair/del', { id: data.hairdoId })
    if (r && r.ok === false) { toast && toast(r.message || '删不了'); return }
    await load()
    toast && toast('已删除')
  }

  const setMakeup = async (id) => {
    const r = await post('/makeup/set', { id })
    if (r && r.ok === false) { toast && toast(r.message || '切不过去'); return }
    await load()
  }

  const addMakeup = async () => {
    if (!newMakeupName.trim() || !newMakeupDesc.trim()) { toast && toast('名字和描述都要写'); return }
    setBusy(true)
    try {
      const r = await post('/makeup/add', { name: newMakeupName, desc: newMakeupDesc })
      if (r && r.ok === false) { toast && toast(r.message || '没加上'); return }
      setNewMakeupName(''); setNewMakeupDesc('')
      await load()
      toast && toast('妆容已添加')
    } finally { setBusy(false) }
  }

  const delMakeup = async () => {
    if (!window.confirm('删掉当前这个妆容？')) return
    const r = await post('/makeup/del', { id: data.makeupId })
    if (r && r.ok === false) { toast && toast(r.message || '删不了'); return }
    await load()
    toast && toast('已删除')
  }

  const saveMakeup = async () => {
    const cur = (data.makeups || []).find((m) => m.id === data.makeupId)
    if (cur && makeupDraft === cur.desc) return
    const r = await post('/makeup/save', { id: data.makeupId, desc: makeupDraft })
    if (r && r.ok === false) { toast && toast(r.message || '没存上'); return }
    await load()
    toast && toast('妆容已保存')
  }

  const saveAppearance = async () => {
    if (baseDraft === (data.base || '') && styleDraft === (data.style || '')) return
    const r = await post('/appearance/save', { base: baseDraft, style: styleDraft })
    if (r && r.ok === false) { toast && toast(r.message || '没存上'); return }
    toast && toast('外观已保存')
  }

  const pickReplace = (id) => { setReplaceId(id); setTimeout(() => replaceRef.current && replaceRef.current.click(), 0) }
  const onReplaceFile = async (e) => {
    const f = e.target.files && e.target.files[0]
    e.target.value = ''
    const id = replaceId
    if (!f || !id) return
    setBusy(true)
    try {
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.onerror = reject
        fr.readAsDataURL(f)
      })
      const r = await post('/image/replace', { id, image: b64 })
      if (r && r.ok === false) { toast && toast(r.message || '没换上'); return }
      await load()
      toast && toast('已换图')
    } finally { setBusy(false) }
  }

  const startEdit = (it) => setDraft({ ...draft, [it.id]: { name: it.name, desc: it.desc || '' } })
  const cancelEdit = (id) => { const d = { ...draft }; delete d[id]; setDraft(d) }
  const saveEdit = async (id) => {
    const d = draft[id]
    if (!d) return
    const r = await post('/update', { id, name: d.name, desc: d.desc })
    if (r && r.ok === false) { toast && toast(r.message || '没存上'); return }
    cancelEdit(id)
    await load()
    toast && toast('已更新')
  }
  const delItem = async (id) => { await post('/del', { id }); await load() }
  const clearAll = async () => {
    if (!window.confirm('删掉衣柜里的所有衣服？图片也会一起删。')) return
    await post('/clear', {})
    await load()
    toast && toast('衣柜已清空')
  }

  const copyPrompt = async () => {
    try {
      const r = await fetch(api + '/prompt?pose=' + encodeURIComponent(pose)).then((x) => x.json())
      if (!r || !r.prompt) { toast && toast('拿不到提示词'); return }
      await navigator.clipboard.writeText(r.prompt)
      toast && toast('提示词已复制')
    } catch (e) { toast && toast('复制失败：' + ((e && e.message) || e)) }
  }

  const gen = async () => {
    setBusy(true)
    try {
      const r = await post('/preview', { pose })
      if (r.ok === false) { toast && toast(r.message || '生图失败'); return }
      setShot(r)
      await load()
      toast && toast(r.usedReference ? '画好了（用了参考图）' : '画好了（纯文字）')
    } finally { setBusy(false) }
  }
  const delPreview = async (id) => {
    await post('/preview/del', { id })
    if (shot && shot.id === id) setShot(null)
    await load()
  }


  if (!data) return h('div', { className: 'ab-muted' }, err || '加载中…')

  const cardGap = { display: 'flex', flexDirection: 'column', gap: 14 }

  const editorOf = (it) => {
    const d = draft[it.id]
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h('input', {
        className: 'ab-input', style: { width: '100%', boxSizing: 'border-box' }, value: d.name, placeholder: '名字',
        onChange: (e) => setDraft({ ...draft, [it.id]: { ...d, name: e.target.value } }),
      }),
      h('textarea', {
        className: 'ab-input', rows: 4, maxLength: 500,
        style: { width: '100%', boxSizing: 'border-box', fontSize: 12, resize: 'vertical', lineHeight: 1.6 },
        value: d.desc,
        onChange: (e) => setDraft({ ...draft, [it.id]: { ...d, desc: e.target.value } }),
      }),
      h('div', {
        className: 'ab-muted',
        style: { fontSize: 11, textAlign: 'right', color: String(d.desc || '').length >= 500 ? '#c0392b' : undefined },
      }, String(d.desc || '').length + ' / 500'))
  }

  const viewerOf = (it) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
      h('div', { style: { fontSize: 13, fontWeight: 600 } }, it.name),
      h('div', { className: 'ab-muted', style: { fontSize: 11 } }, '整套')),
    h('div', { style: { fontSize: 12, lineHeight: 1.7, color: 'inherit', opacity: 0.9 } }, it.desc || '（没有描述）'))

  const actionBtns = (it) => {
    const editing = Boolean(draft[it.id])
    if (editing) {
      return [
        h(ui.Btn, { small: true, kind: 'ghost', key: 'r', onClick: () => pickReplace(it.id) }, '换图'),
        h(ui.Btn, { small: true, key: 's', onClick: () => saveEdit(it.id) }, '保存'),
        h(ui.Btn, { small: true, kind: 'ghost', key: 'c', onClick: () => cancelEdit(it.id) }, '取消'),
      ]
    }
    return [
      h(ui.Btn, { small: true, kind: 'ghost', key: 'r', onClick: () => pickReplace(it.id) }, '换图'),
      h(ui.Btn, { small: true, kind: 'ghost', key: 'w', onClick: () => change(it.id) }, '穿上'),
      h(ui.Btn, { small: true, kind: 'ghost', key: 'e', onClick: () => startEdit(it) }, '改'),
      h(ui.Btn, { small: true, kind: 'ghost', key: 'd', onClick: () => delItem(it.id) }, '删'),
    ]
  }

  const rowOf = (it) => h('div', {
    key: it.id,
    style: {
      display: 'flex', gap: 14, alignItems: 'center',
      padding: '12px 0', borderBottom: '1px solid rgba(128,128,128,.12)',
    },
  },
  h('div', { style: { flex: '0 0 ' + thumbW + 'px' } },
    it.image
      ? h('img', {
        src: imgUrl(it),
        title: '点开看大图',
        onClick: () => window.open(imgUrl(it), '_blank'),
        style: {
          width: thumbW, height: Math.round(thumbW * 1.55), objectFit: 'contain',
          borderRadius: 8, background: '#fafafa', border: '1px solid rgba(0,0,0,.04)', cursor: 'zoom-in', display: 'block',
        },
      })
      : h('div', {
        style: {
          width: thumbW, height: Math.round(thumbW * 1.55), borderRadius: 8, background: '#f6f6f6',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#9a9a9a',
        },
      }, '无参考图')),
  h('div', { style: { flex: 1, minWidth: 0 } }, draft[it.id] ? editorOf(it) : viewerOf(it)),
  h('div', { style: { flex: '0 0 auto', display: 'flex', gap: 12, alignItems: 'center' } }, actionBtns(it)))

  return h('div', { style: { ...cardGap, width: '100%' } },
    err ? h('div', { style: { color: '#c0392b', fontSize: 12 } }, err) : null,

    h('input', { ref: replaceRef, type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: onReplaceFile }),

    h(ui.Card, { title: '加一件衣服', desc: '上传参考图，自动写描述；或者自己写穿搭描述。' },
      h('div', { style: { display: 'flex', gap: 10, alignItems: 'flex-start' } },
        h('input', {
          className: 'ab-input', style: { width: 160, flex: '0 0 160px' }, placeholder: '名字（可不填）',
          value: name, onChange: (e) => setName(e.target.value),
        }),
        h('textarea', {
          className: 'ab-input', rows: 2,
          placeholder: '描述：比如 深藏青高领毛衣 + 深灰阔腿裤 + 帆布鞋',
          style: { flex: 1, fontSize: 12, resize: 'vertical', lineHeight: 1.6, boxSizing: 'border-box' },
          value: desc, onChange: (e) => setDesc(e.target.value),
        }),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto', paddingTop: 2 } },
          h(ui.Btn, { small: true, disabled: busy, onClick: saveText }, '保存'),
          h('input', { ref: fileRef, type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: onFile }),
          h(ui.Btn, { small: true, kind: 'ghost', disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, busy ? '处理中…' : '选图上传')))),

    h(ui.Card, {
      title: '衣柜（' + data.items.length + ' 件）',
      right: h('div', { style: { display: 'flex', gap: 14, alignItems: 'center' } },
        h('span', { className: 'ab-muted', style: { fontSize: 11 } }, '图大小'),
        h('input', { type: 'range', min: 80, max: 220, step: 10, value: thumbW, onChange: (e) => setThumbW(Number(e.target.value)) }),
        h(ui.Btn, { small: true, kind: 'ghost', onClick: clearAll }, '清空衣柜')),
    },
    data.items.length
      ? data.items.map(rowOf)
      : h('div', { className: 'ab-muted ab-small' }, '衣柜是空的，先上传一张参考图。')),

    h(ui.Card, { title: '当前装扮' },
      h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 } },
        h('select', {
          className: 'ab-input', style: { width: 220 },
          value: (data.today && data.today.set) || '',
          onChange: (e) => change(e.target.value),
        },
          h('option', { value: '' }, '— 不穿 —'),
          data.items.map((x) => h('option', { key: x.id, value: x.id }, x.name))),
        h(ui.Btn, { small: true, onClick: applyLook }, '保存并更新上下文')),
      h('div', { className: 'ab-muted', style: { fontSize: 12, lineHeight: 1.7 } }, data.outfit || '还没选'),
      lookPreview
        ? h('div', { style: { marginTop: 10, padding: 10, borderRadius: 8, background: '#f7f7f7', fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap' } }, lookPreview)
        : null),

    h(ui.Card, { title: '发型', desc: '换发型可以换颜色，描述会进生图。' },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', paddingBottom: 10, borderBottom: '1px solid rgba(128,128,128,.14)' } },
        h('input', {
          className: 'ab-input', style: { width: 140 }, placeholder: '新发型名字',
          value: newHairName, onChange: (e) => setNewHairName(e.target.value),
        }),
        h('input', {
          className: 'ab-input', style: { flex: 1 }, placeholder: '描述：比如 蓝黑色长发到腰，发尾浅海蓝，碎刘海',
          value: newHairDesc, onChange: (e) => setNewHairDesc(e.target.value),
        }),
        h(ui.Btn, { small: true, disabled: busy, onClick: addHairdo }, '添加')),
      h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', margin: '10px 0 8px' } },
        h('select', {
          className: 'ab-input', style: { width: 180 },
          value: data.hairdoId || '',
          onChange: (e) => setHairdo(e.target.value),
        },
        (data.hairdos || []).map((it) => h('option', { key: it.id, value: it.id }, it.name))),
        h(ui.Btn, { small: true, kind: 'ghost', onClick: delHairdo }, '删掉这个')),
      h('textarea', {
        className: 'ab-input', rows: 2,
        style: { width: '100%', boxSizing: 'border-box', fontSize: 12, resize: 'vertical', lineHeight: 1.6 },
        value: hairdoDraft, onChange: (e) => setHairdoDraft(e.target.value), onBlur: saveHairdo,
      })),
    h(ui.Card, { title: '妆容', desc: '按场景选，描述会进生图和上下文。可以自己加。' },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', paddingBottom: 10, borderBottom: '1px solid rgba(128,128,128,.14)' } },
        h('input', {
          className: 'ab-input', style: { width: 140 }, placeholder: '新妆容名字',
          value: newMakeupName, onChange: (e) => setNewMakeupName(e.target.value),
        }),
        h('input', {
          className: 'ab-input', style: { flex: 1 }, placeholder: '描述：比如 淡妆，淡粉腮红，唇色淡粉微润',
          value: newMakeupDesc, onChange: (e) => setNewMakeupDesc(e.target.value),
        }),
        h(ui.Btn, { small: true, disabled: busy, onClick: addMakeup }, '添加')),
      h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', margin: '10px 0 8px' } },
        h('select', {
          className: 'ab-input', style: { width: 180 },
          value: data.makeupId || '',
          onChange: (e) => setMakeup(e.target.value),
        },
        (data.makeups || []).map((m) => h('option', { key: m.id, value: m.id }, m.name))),
        h(ui.Btn, { small: true, kind: 'ghost', onClick: delMakeup }, '删掉这个')),
      h('textarea', {
        className: 'ab-input', rows: 2,
        style: { width: '100%', boxSizing: 'border-box', fontSize: 12, resize: 'vertical', lineHeight: 1.6 },
        value: makeupDraft, onChange: (e) => setMakeupDraft(e.target.value), onBlur: saveMakeup,
      })),
    h(ui.Card, { title: '生成预览', desc: '选姿势，按今天的穿搭出图。' },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 } },
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
          h('div', { className: 'ab-muted', style: { width: 90, flex: '0 0 90px', fontSize: 12 } }, '基础外观描述'),
          h('input', {
            className: 'ab-input', style: { flex: 1 },
            value: baseDraft, onChange: (e) => setBaseDraft(e.target.value), onBlur: saveAppearance,
          })),
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
          h('div', { className: 'ab-muted', style: { width: 90, flex: '0 0 90px', fontSize: 12 } }, '画风'),
          h('input', {
            className: 'ab-input', style: { flex: 1 },
            value: styleDraft, onChange: (e) => setStyleDraft(e.target.value), onBlur: saveAppearance,
          }))),      h('div', { style: { display: 'flex', gap: 16, alignItems: 'flex-start' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, flex: '0 0 220px' } },
          h('select', { className: 'ab-input', value: pose, onChange: (e) => setPose(e.target.value) },
            (data.poses || []).map((p) => h('option', { key: p.key, value: p.key }, p.name))),
          h(ui.Btn, { small: true, disabled: busy, onClick: gen }, busy ? '画着…' : '生成'),
          h(ui.Btn, { small: true, kind: 'ghost', onClick: copyPrompt }, '复制提示词'),
          shot ? h('div', { className: 'ab-muted', style: { fontSize: 11, lineHeight: 1.6 } },
            (shot.usedReference ? '用了参考图' : '纯文字') + ' · ' + String(shot.prompt || '').slice(0, 80)) : null),
        h('div', { style: { flex: 1, minWidth: 0 } },
          shot
            ? h('img', {
              src: prevUrl(shot.id), title: '点开看大图',
              onClick: () => window.open(prevUrl(shot.id), '_blank'),
              style: { maxHeight: 360, maxWidth: '100%', borderRadius: 10, cursor: 'zoom-in', display: 'block' },
            })
            : h('div', {
              style: {
                height: 200, borderRadius: 10, background: '#fafafa', border: '1px dashed rgba(0,0,0,.1)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#9a9a9a',
              },
            }, '还没有生成')))),

    h(ui.Card, {
      title: '历史预览（' + history.length + '）',
      right: h(ui.Btn, { small: true, kind: 'ghost', onClick: () => post('/open-folder', {}) }, '打开文件夹'),
    },
      history.length
        ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 } },
          history.map((h2) => h('div', {
            key: h2.id,
            style: { border: '1px solid rgba(128,128,128,.16)', borderRadius: 10, padding: 8, background: '#fff' },
          },
          h('img', {
            src: prevUrl(h2.id), title: '点开看大图',
            onClick: () => window.open(prevUrl(h2.id), '_blank'),
            style: { width: '100%', height: 210, objectFit: 'contain', borderRadius: 8, cursor: 'zoom-in', background: '#fafafa', display: 'block' },
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 } },
            h('div', { className: 'ab-muted', style: { fontSize: 11 } }, h2.poses + ' · ' + new Date(h2.at).toLocaleString().slice(-8)),
            h(ui.Btn, { small: true, kind: 'ghost', onClick: () => delPreview(h2.id) }, '删')))))
        : h('div', { className: 'ab-muted ab-small' }, '还没有生成过。')))
}
