// 面板：「生图」页最下面的「用 DSH 已接入的模型」一块。
// 模型清单是动态的（DSH 里新接一个生图模型就会出现），所以下拉框自己画，
// 走 /models 接口拿清单，选中后立刻存进模块设置。
//
// 两条刻意的设计：
//  1. 不做自动兜底 —— 没选就是没选，落回内置接法。替使用者挑等于替他决定花哪份额度。
//  2. 带筛选 —— 绘图模型不多但分散在多个提供方下，按名字筛比翻长列表快。
const { useState, useEffect, useRef } = React

return function Panel ({ settings, save, toast }) {
  const { Card, Btn, Switch, Select } = ui
  const [models, setModels] = useState([])
  const [total, setTotal] = useState(0)
  const [errors, setErrors] = useState([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const timer = useRef(null)

  async function reload (announce, q) {
    setBusy(true)
    try {
      const suffix = q ? `?q=${encodeURIComponent(q)}` : ''
      const r = await call('/models' + suffix)
      setModels((r && r.models) || [])
      setTotal(Number((r && r.total) || 0))
      setErrors((r && r.errors) || [])
      setLoaded(true)
      if (announce) {
        const n = ((r && r.models) || []).length
        toast(n ? `找到 ${n} 个生图模型` : '没找到匹配的生图模型')
      }
    } catch (error) {
      toast('拉取模型失败：' + (error && error.message ? error.message : error))
    } finally {
      setBusy(false)
    }
  }

  // 进面板拉一次全量
  useEffect(() => { reload(false, '') }, [])

  // 输入筛选词后稍等一下再查，避免每敲一个字打一次接口
  useEffect(() => {
    if (!loaded) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { reload(false, query.trim()) }, 250)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [query])

  const current = String(settings.target || '')
  const options = models.map((m) => ({ value: m.key, label: m.label }))
  // 选过但这次没出现：可能是筛选筛掉了，也可能是真没了 —— 分开说
  const exists = models.some((m) => m.key === current)
  const selectedMissing = current && !exists && !query.trim()

  return h(Card, { title: '用 DSH 已接入的模型生图' },
    h('p', { className: 'ab-note' },
      '直接使用 DSH 里已经接好的生图模型（例如豆包插件接入的「豆包 生图（Seedream 5.0）」）。' +
      '清单动态拉取：在 DSH 里新接一个生图模型，刷新就能看到。'),
    h('p', { className: 'ab-note' },
      '注意：走对话模型的生图会消耗对应的对话额度（例如豆包会员额度），不是本插件的生图额度。'),
    h(Switch, {
      checked: settings.enabled === true,
      onChange: (v) => save({ enabled: v === true }),
      label: '开启',
    }),
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
      h('input', {
        className: 'ab-input',
        style: { flex: '1 1 160px', minWidth: 120 },
        placeholder: '筛选模型（名字或提供方）',
        value: query,
        onChange: (e) => setQuery(e.target.value),
      }),
      h(Btn, { onClick: () => reload(true, query.trim()), disabled: busy }, busy ? '拉取中…' : '刷新'),
    ),
    h('div', { style: { marginTop: 8 } },
      h(Select, {
        ariaLabel: '生图模型',
        value: current,
        onChange: (v) => { if (v) save({ target: v }) },
        options: [
          { value: '', label: current ? '（不选，用内置生图）' : (models.length ? '（请选择模型）' : '（还没有可用的生图模型）') },
          // 选中的模型被筛选筛掉时，仍把它列出来，免得下拉看起来像没选
          ...(current && !exists ? [{ value: current, label: current.replace('\u0000', ' / ') + '（当前选中）' }] : []),
          ...options,
        ],
      }),
    ),
    loaded
      ? h('p', { className: 'ab-small ab-muted' },
        query.trim() ? `筛出 ${models.length} / 共 ${total} 个` : `共 ${total} 个生图模型`)
      : null,
    selectedMissing ? h('p', { className: 'ab-note' }, '注意：上次选中的模型这次没出现（可能已删除或服务未启动），请重新选择。') : null,
    loaded && !models.length && !query.trim()
      ? h('p', { className: 'ab-note' }, '没发现生图模型。请确认 DSH 里已经接入并启用了生图模型（例如豆包插件的「豆包 生图」）。')
      : null,
    loaded && !models.length && query.trim()
      ? h('p', { className: 'ab-note' }, '没有匹配的模型，换个关键词试试。')
      : null,
    errors.length
      ? h('p', { className: 'ab-small ab-muted' }, '部分提供方读取失败：' + errors.map((e) => `${e.provider || '?'}（${e.message}）`).join('；'))
      : null,
  )
}
