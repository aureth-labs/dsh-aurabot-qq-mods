const { useState, useEffect } = React
return function Panel({ settings }) {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setState(null); setError('') }, [JSON.stringify(settings)])
  async function refresh() {
    setState(null)
    setBusy(true)
    setError('')
    try { setState(await call('/status')) }
    catch (e) { setError(String(e.message || e)) }
    finally { setBusy(false) }
  }
  return h(ui.Card, { title: '规则检查与可用 ID' },
    h('p', { className: 'ab-note' }, '先保存设置，再检查。优先级数字越大越优先，同分取靠前规则；未命中沿用原模型。这里只预览当前人格，实际聊天使用各自所属人格。'),
    h(ui.Btn, { disabled: busy, onClick: refresh }, busy ? '检查中…' : '检查已保存规则 / 刷新模型与人格'),
    error && h('p', { role: 'alert' }, error),
    state && h('div', null,
      h('p', null, state.enabled ? '自动切换已开启' : '自动切换未开启'),
      state.errors.length > 0 && h('pre', { role: 'alert', style: { whiteSpace: 'pre-wrap' } }, state.errors.join('\n')),
      h('p', null, '检查时间：' + state.checkedAt + '（时间或设置变化后请重新检查）'),
      h('p', null, state.rule ? '检查时预览命中' + (state.enabled ? '：' : '（尚未启用）：') + state.rule.id + ' → ' + state.rule.provider + ' / ' + state.rule.model : '检查时没有命中规则'),
      h('p', null, '人格 ID：' + (state.personaId || (state.errors.length ? '未评估' : '无需人格条件'))),
      state.warnings.map((w, i) => h('p', { key: i }, w)),
      h('details', null, h('summary', null, '模型 provider / model（需完整复制，包括斜杠）'),
        h('pre', { style: { whiteSpace: 'pre-wrap' } }, JSON.stringify(state.models, null, 2))),
      h('details', null, h('summary', null, '人格 ID 与名称'),
        h('pre', { style: { whiteSpace: 'pre-wrap' } }, JSON.stringify(state.personas, null, 2)))))
}
