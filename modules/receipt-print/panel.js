// 小票打印面板：模板（提示词/定时）、打印机、预览、最近记录。
const { useState, useEffect } = React

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const TRANSPORTS = [
  ['windows', 'Windows 打印队列（USB）'],
  ['tcp', '网口 / WiFi（9100）'],
  ['cups', 'macOS / Linux CUPS'],
  ['preview', '只预览'],
]

const field = {
  border: '1px solid rgba(128,128,128,.35)',
  borderRadius: 8,
  padding: '6px 10px',
  fontSize: 13,
  background: 'transparent',
  color: 'inherit',
  minWidth: 0,
}

const emptyTemplate = () => ({
  name: '',
  prompt: '',
  system: '',
  engine: 'ask',
  enabled: true,
  schedule: { enabled: false, time: '08:30', days: [] },
  printer: '',
  widthMm: 0,
  footer: '',
  qr: '',
})

return function Panel({ settings, toast }) {
  const [templates, setTemplates] = useState([])
  const [printers, setPrinters] = useState([])
  const [history, setHistory] = useState([])
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState('')
  const [text, setText] = useState('')
  const [form, setForm] = useState({ name: '', transport: 'windows', target: '', paperWidthMm: 58 })
  const [rawPrinters, setRawPrinters] = useState([])
  const [live, setLive] = useState(null)

  const reload = async () => {
    const r = await call('/templates').catch(() => null)
    if (r?.ok) {
      setTemplates(r.templates || [])
      setPrinters(r.printers || [])
      setRawPrinters(r.settings?.printers || [])
      setLive(r.settings || null)
    }
    const h = await call('/history').catch(() => null)
    if (h?.ok) setHistory(h.history || [])
  }

  useEffect(() => { reload() }, [])

  const saveTemplate = async () => {
    if (!draft || !String(draft.name || '').trim()) return toast('先给模板起个名字')
    if (!String(draft.prompt || '').trim()) return toast('提示词不能为空')
    setBusy('save')
    const r = await call('/save', { template: draft }).catch(() => null)
    setBusy('')
    if (r?.ok) { toast('已保存'); setDraft(null); reload() } else toast(r?.message || '保存失败')
  }

  const removeTemplate = async (t) => {
    if (!window.confirm(`删除模板「${t.name}」？`)) return
    const r = await call('/delete', { id: t.id }).catch(() => null)
    if (r?.ok) { toast('已删除'); reload() } else toast(r?.message || '删除失败')
  }

  const runTemplate = async (t, previewMode) => {
    setBusy(t.id)
    const r = await call('/run', { id: t.id, preview: previewMode }).catch(() => null)
    setBusy('')
    if (!r) return toast('请求失败')
    if (previewMode) {
      setPreview(r.preview || r.message || '没有内容')
      return
    }
    toast(r.message || (r.ok ? '已打印' : '打印失败'))
    reload()
  }

  const testPrinter = async (name) => {
    setBusy('test-' + name)
    const r = await call('/test', { name }).catch(() => null)
    setBusy('')
    toast(r?.message || '测试失败')
    reload()
  }

  const addPrinter = async () => {
    if (!form.name.trim()) return toast('给打印机起个名字')
    if (form.transport !== 'preview' && !form.target.trim()) return toast('填 IP 或系统打印队列名')
    const next = [...rawPrinters, { ...form, name: form.name.trim(), target: form.target.trim(), paperWidthMm: Number(form.paperWidthMm) }]
    const r = await call('/settings', { patch: { printers: next } }).catch(() => null)
    if (!r?.ok) return toast('添加失败')
    setRawPrinters(next)
    setForm({ name: '', transport: 'windows', target: '', paperWidthMm: 58 })
    toast('已添加')
    reload()
  }

  const removePrinter = async (name) => {
    if (!window.confirm(`移除打印机「${name}」？`)) return
    const next = rawPrinters.filter((p) => p.name !== name)
    const r = await call('/settings', { patch: { printers: next } }).catch(() => null)
    if (!r?.ok) return toast('移除失败')
    setRawPrinters(next)
    toast('已移除')
  }

  const setSchedule = (patch) => setDraft((d) => ({ ...d, schedule: { ...(d.schedule || {}), ...patch } }))
  const toggleDay = (day) => {
    const days = Array.isArray(draft.schedule?.days) ? draft.schedule.days : []
    setSchedule({ days: days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort() })
  }

  return h('div', null,
    h(ui.Card, { title: '模板' },
      h('p', { className: 'ab-note' }, '模板 = 名称 + 提示词。可以手动触发，也可以按时间自动生成打印；提示词支持 {date} {weekday} {time} {width} 占位符。'),
      h('div', { style: { display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
        h(ui.Btn, { onClick: () => setDraft(emptyTemplate()) }, '新建模板'),
        h(ui.Btn, { onClick: reload }, '刷新'),
      ),
      !templates.length && h('p', { className: 'ab-muted' }, '还没有模板。'),
      templates.map((t) => h('div', {
        key: t.id,
        style: { borderTop: '1px solid rgba(128,128,128,.18)', padding: '8px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      },
        h('div', { style: { flex: '1 1 220px' } },
          h('div', null, t.name, t.enabled === false ? h('span', { className: 'ab-muted' }, '（已停用）') : null),
          h('div', { className: 'ab-small ab-muted' },
            [
              t.schedule?.enabled ? `定时 ${t.schedule.time}${t.schedule.days?.length ? ' · 周' + t.schedule.days.map((d) => WEEK[d]).join('') : ' · 每天'}` : '手动触发',
              t.printer || '默认打印机',
              t.engine === 'think' ? '人格生成' : '单问模型',
            ].join(' · ')),
        ),
        h(ui.Btn, { disabled: busy === t.id, onClick: () => runTemplate(t, false) }, busy === t.id ? '生成中…' : '生成打印'),
        h(ui.Btn, { onClick: () => runTemplate(t, true) }, '预览'),
        h(ui.Btn, { onClick: () => setDraft({ ...t, schedule: { ...(t.schedule || {}) } }) }, '编辑'),
        h(ui.Btn, { onClick: () => removeTemplate(t) }, '删除'),
      )),
    ),

    draft && h(ui.Card, { title: draft.id ? `编辑：${draft.name || '未命名'}` : '新建模板' },
      h('div', { style: { display: 'grid', gap: 8 } },
        h('label', null, '名称',
          h('input', { style: { ...field, width: '100%' }, value: draft.name, onChange: (e) => setDraft({ ...draft, name: e.target.value }) })),
        h('label', null, '提示词',
          h('textarea', { style: { ...field, width: '100%', minHeight: 110 }, value: draft.prompt, onChange: (e) => setDraft({ ...draft, prompt: e.target.value }) })),
        h('label', null, '系统提示词（可空）',
          h('textarea', { style: { ...field, width: '100%', minHeight: 60 }, value: draft.system || '', onChange: (e) => setDraft({ ...draft, system: e.target.value }) })),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('label', null, '生成方式',
            h('select', { style: field, value: draft.engine, onChange: (e) => setDraft({ ...draft, engine: e.target.value }) },
              h('option', { value: 'ask' }, '单问模型（快，不带人格）'),
              h('option', { value: 'think' }, '让她想（带人格和记忆，慢）'))),
          h('label', null, '指定打印机',
            h('select', { style: field, value: draft.printer || '', onChange: (e) => setDraft({ ...draft, printer: e.target.value }) },
              h('option', { value: '' }, '默认打印机'),
              printers.map((p) => h('option', { key: p.name, value: p.name }, p.name)))),
          h('label', null, '纸张',
            h('select', { style: field, value: draft.widthMm || 0, onChange: (e) => setDraft({ ...draft, widthMm: Number(e.target.value) }) },
              h('option', { value: 0 }, '跟随打印机'),
              h('option', { value: 58 }, '58mm'),
              h('option', { value: 80 }, '80mm'))),
        ),
        h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
          h('label', null, h('input', { type: 'checkbox', checked: draft.schedule?.enabled === true, onChange: (e) => setSchedule({ enabled: e.target.checked }) }), ' 定时生成'),
          h('label', null, '时间 ',
            h('input', { type: 'time', style: field, value: draft.schedule?.time || '08:30', onChange: (e) => setSchedule({ time: e.target.value }) })),
          h('span', { className: 'ab-small' }, '星期（不选=每天）'),
          WEEK.map((w, i) => h('label', { key: i, className: 'ab-small' },
            h('input', { type: 'checkbox', checked: (draft.schedule?.days || []).includes(i), onChange: () => toggleDay(i) }), ' ' + w)),
        ),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('label', { style: { flex: '1 1 200px' } }, '页脚（可空）',
            h('input', { style: { ...field, width: '100%' }, value: draft.footer || '', onChange: (e) => setDraft({ ...draft, footer: e.target.value }) })),
          h('label', { style: { flex: '1 1 200px' } }, '二维码内容（可空）',
            h('input', { style: { ...field, width: '100%' }, value: draft.qr || '', onChange: (e) => setDraft({ ...draft, qr: e.target.value }) })),
        ),
      ),
      h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
        h(ui.Btn, { onClick: saveTemplate, disabled: busy === 'save' }, busy === 'save' ? '保存中…' : '保存'),
        h(ui.Btn, { onClick: () => setDraft(null) }, '取消'),
      ),
    ),

    h(ui.Card, { title: '打印机' },
      h('p', { className: 'ab-note' }, `全局纸宽 ${live?.paperWidthMm ?? settings.paperWidthMm ?? 58} mm，有效宽度 ${live?.effectiveWidthMm > 0 ? live.effectiveWidthMm + ' mm' : '自动'}；改纸宽、有效宽度和自检指令请到「设置」页。USB 打印机填 Windows「设备和打印机」里的队列名，网口填 IP（可带 :9100）。`),
      h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
        h(ui.Btn, { onClick: () => testPrinter('') }, '一键自检默认打印机')),
      !rawPrinters.length && h('p', { className: 'ab-muted' }, '还没有打印机，可以先加一台「只预览」。'),
      rawPrinters.map((p) => {
        const meta = printers.find((x) => x.name === p.name)
        return h('div', { key: p.name, style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid rgba(128,128,128,.18)' } },
          h('div', { style: { flex: '1 1 220px' } },
            h('div', null, p.name),
            h('div', { className: 'ab-small ab-muted' }, `${(TRANSPORTS.find((t) => t[0] === p.transport) || [])[1] || p.transport} · ${p.target || '未填目标'} · ${meta?.paperMm || p.paperWidthMm || settings.paperWidthMm || 58}mm / ${meta?.columns || '—'} 列`)),
          h(ui.Btn, { disabled: busy === 'test-' + p.name, onClick: () => testPrinter(p.name) }, busy === 'test-' + p.name ? '发送中…' : '自检'),
          h(ui.Btn, { onClick: () => removePrinter(p.name) }, '移除'),
        )
      }),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 } },
        h('input', { style: { ...field, flex: '1 1 120px' }, placeholder: '名字', value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }) }),
        h('select', { style: field, value: form.transport, onChange: (e) => setForm({ ...form, transport: e.target.value }) },
          TRANSPORTS.map(([value, label]) => h('option', { key: value, value }, label))),
        h('input', { style: { ...field, flex: '1 1 150px' }, placeholder: '队列名 / IP / 留空', value: form.target, onChange: (e) => setForm({ ...form, target: e.target.value }) }),
        h('select', { style: field, value: form.paperWidthMm, onChange: (e) => setForm({ ...form, paperWidthMm: Number(e.target.value) }) },
          h('option', { value: 58 }, '58mm'), h('option', { value: 80 }, '80mm')),
        h(ui.Btn, { onClick: addPrinter }, '添加'),
      ),
    ),

    h(ui.Card, { title: '快速预览' },
      h('textarea', { style: { ...field, width: '100%', minHeight: 70 }, placeholder: '输入要看的文字', value: text, onChange: (e) => setText(e.target.value) }),
      h('div', { style: { marginTop: 8 } },
        h(ui.Btn, {
          onClick: async () => {
            const r = await call('/preview', { text }).catch(() => null)
            setPreview(r?.ok ? `每行 ${r.columns} 列 · 纸宽 ${r.paperWidthMm}mm / 有效 ${r.effectiveWidthMm}mm\n\n${r.preview}` : '没有内容')
          },
        }, '按当前纸宽预览')),
      preview && h('pre', { className: 'ab-small', style: { whiteSpace: 'pre-wrap', marginTop: 10, padding: 10, border: '1px solid rgba(128,128,128,.25)', borderRadius: 8 } }, preview),
    ),

    h(ui.Card, { title: '最近打印' },
      !history.length && h('p', { className: 'ab-muted' }, '还没有记录。'),
      history.map((entry, i) => h('div', { key: i, className: 'ab-small', style: { padding: '4px 0', borderTop: '1px solid rgba(128,128,128,.15)' } },
        `${entry.time} · ${entry.template} · ${entry.printer || '预览'} · ${entry.ok ? '成功' : '失败'}${entry.error ? '：' + entry.error : ''}`)),
    ),
  )
}
