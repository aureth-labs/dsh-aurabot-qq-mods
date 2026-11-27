// 热敏打印面板：模板（提示词/定时）、打印机、预览、最近记录。
const { useState, useEffect } = React

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const TRIGGER_LABELS = {
  command: '命令',
  panel: '面板',
  schedule: '定时',
  startup: '启动',
  moment: '说说',
  model: '自触发',
  selftest: '自检',
  calibrate: '校准',
  unknown: '未知',
}
const TEMPLATE_TRIGGERS = [
  ['manual', '手动触发'],
  ['schedule', '定时'],
  ['startup', '启动时'],
  ['moment', '她发完说说后'],
  ['model', '让模型判断'],
]
const triggerName = (mode) => (TEMPLATE_TRIGGERS.find(([value]) => value === mode) || [null, '手动触发'])[1]
const TRANSPORTS = [
  ['windows', 'Windows 打印队列（USB，推荐）'],
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
  trigger: 'manual',
  schedule: { enabled: false, time: '08:30', days: [] },
  printer: '',
  widthMm: 0,
  footer: '',
  qr: '',
})

return function Panel({ settings, toast }) {
  const [templates, setTemplates] = useState([])
  const [history, setHistory] = useState([])
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState('')
  const [text, setText] = useState('')
  const [pform, setPform] = useState({ name: '', transport: 'windows', target: '', paperWidthMm: 58 })
  const [live, setLive] = useState(null)
  const [terms, setTerms] = useState(null)
  const [meta, setMeta] = useState(null)
  const [diag, setDiag] = useState('')
  const [hex, setHex] = useState('1B 40 1B 61 01 1D 56 01')
  const [decoded, setDecoded] = useState('')

  const reload = async () => {
    const r = await call('/templates').catch(() => null)
    if (r?.ok) {
      setTemplates(r.templates || [])
      setLive(r.settings || null)
      setTerms(r.terms || null)
      if (r.version) setMeta({ version: r.version, stage: r.stage || '' })
      if (r.printer) {
        setPform({
          name: r.printer.name,
          transport: r.printer.transport,
          target: r.printer.target,
          paperWidthMm: r.printer.paperWidthMm,
        })
      }
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

  const savePrinter = async () => {
    if (!pform.name.trim()) return toast('给打印机起个名字')
    if (pform.transport !== 'preview' && !pform.target.trim()) return toast('填 IP 或系统打印队列名')
    const r = await call('/settings', {
      patch: {
        printer: {
          ...pform,
          name: pform.name.trim(),
          target: pform.target.trim(),
          paperWidthMm: Number(pform.paperWidthMm),
        },
      },
    }).catch(() => null)
    if (!r?.ok) return toast('保存失败')
    reload()
    return true
  }

  const testPrinter = async () => {
    setBusy('test')
    const saved = await savePrinter()
    if (saved) {
      const r = await call('/test', {}).catch(() => null)
      toast(r?.message || '自检失败')
    }
    setBusy('')
    reload()
  }

  const setSchedule = (patch) => setDraft((d) => ({ ...d, schedule: { ...(d.schedule || {}), ...patch } }))
  const toggleDay = (day) => {
    const days = Array.isArray(draft.schedule?.days) ? draft.schedule.days : []
    setSchedule({ days: days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort() })
  }

  const patchSettings = async (patch) => {
    const r = await call('/settings', { patch }).catch(() => null)
    if (!r?.ok) return toast('保存失败')
    setLive(r.settings)
  }

  const termSections = terms?.sections?.length ? terms.sections : [{ title: '', items: terms?.items || [] }]

  return h('div', null,
    terms && !terms.accepted && h(ui.Card, { title: `使用协议 v${terms.version}` },
      termSections.map((section, sectionIndex) => h('div', { key: section.title || sectionIndex },
        section.title && h('p', { style: { fontWeight: 600, margin: '8px 0 2px', fontSize: 13 } }, section.title),
        h('ol', {
          start: 1 + termSections.slice(0, sectionIndex).reduce((sum, item) => sum + item.items.length, 0),
          style: { paddingLeft: 18, lineHeight: 1.7, fontSize: 13, margin: '4px 0 8px' },
        }, section.items.map((item, index) => h('li', { key: index }, item))))),
      h('p', { className: 'ab-note' }, '确认后才能生成和打印；条款更新后需要重新确认。'),
      h(ui.Btn, {
        onClick: async () => {
          const r = await call('/accept', {}).catch(() => null)
          if (!r?.ok) return toast('确认失败')
          toast('已确认使用协议')
          reload()
        },
      }, '我已阅读并同意'),
    ),

    h(ui.Card, { title: '模板' },
      h('p', { className: 'ab-note' }, '模板 = 名称 + 提示词。触发方式可以是手动、定时、启动时、她发完说说后，或让模型自己判断；提示词支持 {date} {weekday} {time} {width} {moment} 占位符。'),
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
              `${triggerName(t.trigger || (t.schedule?.enabled ? 'schedule' : 'manual'))}${t.trigger === 'schedule' ? ` ${t.schedule.time}${t.schedule.days?.length ? ' · 周' + t.schedule.days.map((d) => WEEK[d]).join('') : ' · 每天'}` : ''}`,
              t.widthMm ? `纸张 ${t.widthMm}mm` : '跟随纸宽',
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
          h('label', null, '纸张',
            h('select', { style: field, value: draft.widthMm || 0, onChange: (e) => setDraft({ ...draft, widthMm: Number(e.target.value) }) },
              h('option', { value: 0 }, '跟随打印机'),
              h('option', { value: 58 }, '58mm'),
              h('option', { value: 80 }, '80mm'))),
        ),
        h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
          h('label', null, '触发方式 ',
            h('select', {
              style: field,
              value: draft.trigger || 'manual',
              onChange: (e) => setDraft({
                ...draft,
                trigger: e.target.value,
                schedule: { ...(draft.schedule || {}), enabled: e.target.value === 'schedule' },
              }),
            }, TEMPLATE_TRIGGERS.map(([value, label]) => h('option', { key: value, value }, label)))),
          (draft.trigger || 'manual') === 'schedule' && h('label', null, '时间 ',
            h('input', { type: 'time', style: field, value: draft.schedule?.time || '08:30', onChange: (e) => setSchedule({ time: e.target.value }) })),
          (draft.trigger || 'manual') === 'schedule' && h('span', { className: 'ab-small' }, '星期（不选=每天）'),
          (draft.trigger || 'manual') === 'schedule' && WEEK.map((w, i) => h('label', { key: i, className: 'ab-small' },
            h('input', { type: 'checkbox', checked: (draft.schedule?.days || []).includes(i), onChange: () => toggleDay(i) }), ' ' + w)),
        ),
        h('p', { className: 'ab-small ab-muted' }, '定时=按时间；启动时=模块加载后打一张；说说后=她发完空间说说跟打；模型判断=白天每 3 小时问一次，合适才打（每天最多 3 张）。'),
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
      h('p', { className: 'ab-note' }, `全局纸宽 ${live?.paperWidthMm ?? settings.paperWidthMm ?? 58} mm，有效宽度 ${live?.effectiveWidthMm > 0 ? live.effectiveWidthMm + ' mm' : '自动'}；改有效宽度和自检指令请到「设置」页。建议优先用系统打印队列：Windows 填「设备和打印机」里的队列名，macOS / Linux 用 CUPS；网口填 IP（可带 :9100），没接打印机选「只预览」。`),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        h('input', { style: { ...field, flex: '1 1 120px' }, placeholder: '名字', value: pform.name, onChange: (e) => setPform({ ...pform, name: e.target.value }) }),
        h('select', { style: field, value: pform.transport, onChange: (e) => setPform({ ...pform, transport: e.target.value }) },
          TRANSPORTS.map(([value, label]) => h('option', { key: value, value }, label))),
        h('input', { style: { ...field, flex: '1 1 150px' }, placeholder: '队列名 / IP / 留空', value: pform.target, onChange: (e) => setPform({ ...pform, target: e.target.value }) }),
        h('select', { style: field, value: pform.paperWidthMm, onChange: (e) => setPform({ ...pform, paperWidthMm: Number(e.target.value) }) },
          h('option', { value: 58 }, '58mm'), h('option', { value: 80 }, '80mm')),
      ),
      h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
        h(ui.Btn, { onClick: savePrinter }, '保存'),
        h(ui.Btn, { disabled: busy === 'test', onClick: testPrinter }, busy === 'test' ? '发送中…' : '保存并自检'),
        h(ui.Btn, {
          disabled: busy === 'calibrate',
          onClick: async () => {
            setBusy('calibrate')
            const r = await call('/calibrate', {}).catch(() => null)
            setBusy('')
            toast(r?.message || '校准页发送失败')
          },
        }, busy === 'calibrate' ? '发送中…' : '打印校准页'),
      ),
    ),

    h(ui.Card, { title: '打印机诊断' },
      h('p', { className: 'ab-note' }, '状态回读需要网口 9100 直连；Windows 队列和 CUPS 只能发不能读。解码框可以贴发送的指令，也可以贴打印机返回的十六进制。'),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h(ui.Btn, {
          disabled: busy === 'status',
          onClick: async () => {
            setBusy('status')
            const r = await call('/status', {}).catch(() => null)
            setBusy('')
            setDiag(r?.message || '查询失败')
          },
        }, busy === 'status' ? '查询中…' : '查询打印机状态'),
      ),
      diag && h('pre', { className: 'ab-small', style: { whiteSpace: 'pre-wrap', marginTop: 10, padding: 10, border: '1px solid rgba(128,128,128,.25)', borderRadius: 8 } }, diag),
      h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
        h('input', {
          style: { ...field, flex: '1 1 240px' },
          placeholder: '十六进制，例如 1B 40 1B 61 01',
          value: hex,
          onChange: (e) => setHex(e.target.value),
        }),
        h(ui.Btn, {
          onClick: async () => {
            const r = await call('/decode', { hex }).catch(() => null)
            setDecoded(r?.message || '解码失败')
          },
        }, '解码'),
      ),
      decoded && h('pre', { className: 'ab-small', style: { whiteSpace: 'pre-wrap', marginTop: 10, padding: 10, border: '1px solid rgba(128,128,128,.25)', borderRadius: 8 } }, decoded),
    ),

    h(ui.Card, { title: '说说自动打印' },
      h('p', { className: 'ab-note' }, '她每次发空间说说后，自动按当前纸宽排版打印；配图会按纸宽缩放并自动调色（色阶/亮度/对比度/伽马/锐化），再转成适合热敏纸的黑白位图，打印完自动切纸。默认只打公开发布的说说。'),
      h('div', { style: { display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' } },
        h('label', null, h('input', {
          type: 'checkbox',
          checked: live?.momentAuto !== false,
          onChange: (e) => patchSettings({ momentAuto: e.target.checked }),
        }), ' 发说说自动打印'),
        h('label', null, h('input', {
          type: 'checkbox',
          checked: live?.momentImages !== false,
          onChange: (e) => patchSettings({ momentImages: e.target.checked }),
        }), ' 打印配图'),
        h('label', null, h('input', {
          type: 'checkbox',
          checked: live?.momentIncludeSelf === true,
          onChange: (e) => patchSettings({ momentIncludeSelf: e.target.checked }),
        }), ' 连仅自己可见的也打'),
      ),
      h('p', { className: 'ab-small ab-muted', style: { marginTop: 8 } },
        '配图数量、图片最大高度、抖动等细项在「设置」页。'),
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
      history.map((entry, i) => h('div', { key: i, className: 'ab-small', style: { padding: '6px 0', borderTop: '1px solid rgba(128,128,128,.15)' } },
        `${entry.time} · ${entry.template} · ${(TRIGGER_LABELS[entry.trigger?.type] || '未知')}${entry.trigger?.reason ? `（${entry.trigger.reason}）` : ''} · ${entry.printer || '预览'} · ${entry.ok ? '成功' : '失败'}${entry.error ? '：' + entry.error : ''}`,
        entry.text && h('details', { style: { marginTop: 4 } },
          h('summary', { style: { cursor: 'pointer', opacity: .7 } }, '查看备份内容'),
          h('pre', { style: { whiteSpace: 'pre-wrap', margin: '6px 0 0', padding: 8, border: '1px solid rgba(128,128,128,.2)', borderRadius: 6 } }, entry.text),
          entry.backup && h('div', { style: { opacity: .6, marginTop: 4 } }, `文件：${entry.backup}`),
        ))),
    ),

    meta && h('div', {
      className: 'ab-small ab-muted',
      style: { textAlign: 'center', padding: '12px 0 4px', lineHeight: 1.7 },
    },
      `热敏打印 v${meta.version}${meta.stage ? ` · 阶段：${meta.stage}` : ''}`,
      meta.stage === '测试' ? h('div', null, '测试阶段，功能和指令可能随时调整') : null,
    ),
  )
}
