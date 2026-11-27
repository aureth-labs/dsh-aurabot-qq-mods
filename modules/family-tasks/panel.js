// 家人代办面板：设置 + 待办。call('/get') 读，call('/set',{patch}) 写。

return function FamilyTasksPanel({ toast }) {
  const [status, setStatus] = React.useState(null)
  const [form, setForm] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [saved, setSaved] = React.useState(false)

  function load() {
    call('/status').then(function (s) { setStatus(s) }).catch(function () { setStatus(null) })
    call('/get').then(function (r) { setForm(r); setSaved(false) }).catch(function () { setForm(null) })
  }
  React.useEffect(function () { load() }, [])

  function set(k, v) {
    setForm(function (f) { const o = Object.assign({}, f); o[k] = v; return o })
    setSaved(false)
  }

  function save() {
    if (!form) return
    setBusy(true)
    const patch = {
      enabled: !!form.enabled,
      autoHandle: !!form.autoHandle,
      familyQQ: form.familyQQ || '',
      ownerQQ: form.ownerQQ || '',
      ownerLabel: form.ownerLabel || '主人',
      notifyGapSec: Number(form.notifyGapSec) || 30,
      tablePath: form.tablePath || '',
    }
    call('/set', { patch: patch })
      .then(function (r) {
        if (r && r.ok === false) {
          toast && toast('保存失败：' + (r.message || ''))
        } else {
          setSaved(true)
          toast && toast('已保存')
          load()
        }
      })
      .catch(function (e) { toast && toast('出错：' + e.message) })
      .finally(function () { setBusy(false) })
  }

  const inp = { width: '100%', padding: '5px 8px', border: '1px solid #d0d7de', borderRadius: 5, fontSize: 13, boxSizing: 'border-box' }
  const pending = (status && status.pending) || []
  const total = (status && status.total) || 0

  function line(label, node, hint) {
    return h('div', { style: { marginBottom: 10 } },
      h('label', { style: { display: 'block', fontSize: 12, color: '#555', marginBottom: 3 } }, label),
      node,
      hint ? h('div', { style: { fontSize: 11, color: '#999', marginTop: 2 } }, hint) : null
    )
  }

  // 设置区
  let settingsBlock = h('div', { style: { color: '#888', fontSize: 13 } }, '读取配置中…')
  if (form) {
    settingsBlock = h('div', { style: { border: '1px solid #d0d7de', borderRadius: 8, padding: 12, marginBottom: 12 } },
      line('家人 QQ（一行一个）',
        h('textarea', { value: form.familyQQ || '', onChange: function (e) { set('familyQQ', e.target.value) }, rows: 3, style: Object.assign({}, inp, { resize: 'vertical', fontFamily: 'monospace' }) }),
        '只有这些 QQ 的私聊会被当成家人托付'),
      line('主人 QQ',
        h('input', { value: form.ownerQQ || '', onChange: function (e) { set('ownerQQ', e.target.value) }, style: inp })),
      line('怎么称呼主人',
        h('input', { value: form.ownerLabel || '', onChange: function (e) { set('ownerLabel', e.target.value) }, placeholder: '主人', style: inp }),
        '叫醒消息里用这个称呼，比如 爸爸 / 老大 / 主人'),
      line('统计表格路径（可选）',
        h('input', { value: form.tablePath || '', onChange: function (e) { set('tablePath', e.target.value) }, placeholder: '留空则只提醒、不自己算', style: inp }),
        '填了 xlsx 路径，能自己办算合计这类活'),
      line('两次提醒间隔（秒）',
        h('input', { type: 'number', value: form.notifyGapSec, onChange: function (e) { set('notifyGapSec', e.target.value) }, style: inp })),
      h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 6 } },
        h('input', { type: 'checkbox', checked: !!form.autoHandle, onChange: function (e) { set('autoHandle', e.target.checked) } }),
        '统计类的活先自己试，办不了再叫主人'),
      h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 10 } },
        h('input', { type: 'checkbox', checked: !!form.enabled, onChange: function (e) { set('enabled', e.target.checked) } }),
        '启用家人代办'),
      h('button', {
        onClick: save,
        disabled: busy,
        style: { padding: '6px 18px', background: saved ? '#2da44e' : '#0969da', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }
      }, busy ? '保存中…' : saved ? '✓ 已保存' : '保存设置')
    )
  }

  // 待办区
  let tasksBlock = h('div', { style: { color: '#888', fontSize: 13 } }, '暂无待办')
  if (pending.length > 0) {
    tasksBlock = h('div', null, pending.map(function (t) {
      return h('div', { key: t.id, style: { borderBottom: '1px solid #eee', padding: '8px 0', fontSize: 13 } },
        h('div', null, h('b', null, t.speaker || '家人'), ' · ', t.kind, ' · ', new Date(t.at).toLocaleString('zh-CN')),
        h('div', { style: { marginTop: 4 } }, t.text)
      )
    }))
  }

  return h('div', { style: { padding: 12, maxWidth: 640 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
      h('h3', { style: { margin: 0 } }, '家人代办'),
      h('button', { onClick: load, style: { marginLeft: 'auto', padding: '4px 12px' } }, '刷新')),
    h('div', { style: { background: '#f6f8fa', borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 13, lineHeight: 1.7 } },
      h('div', null, '状态：', status ? (status.enabled ? '运行中' : '已关闭') : '读取中…'),
      h('div', null, '家人 QQ：', status ? status.familyCount + ' 个' : '—'),
      h('div', null, '主人 QQ：', status ? status.owner || '未填' : '—'),
      h('div', null, '流水总数：', total + ' 条')),
    h('h4', { style: { margin: '16px 0 8px' } }, '设置'),
    settingsBlock,
    h('h4', { style: { margin: '16px 0 8px' } }, '最近待办'),
    tasksBlock
  )
}
