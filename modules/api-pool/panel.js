// 后台面板（React 组件函数体）
// 闭包可用：React, h (=createElement), ui（面板组件库）, call(path[,body])（打模块路由）
//   官方组件：Card, Btn, Switch, Row, Select, Seg, Empty  |  css 类：ab-input, ab-note, ab-small, ab-muted, ab-flex
// 组件签名 ({ settings, save, toast })
// 路由：GET  /pool → { pool:{groups:[],apis:[]} }
//       POST /save   body:{api}
//       POST /del    body:{id}
//       POST /settings body:{groups:[],scope,blacklist:[]}  保存全局生效范围
//       GET  /libs → { libs:[{id,name,base,hasKey}] }（密钥只写，不回明文）
//       POST /libSave body:{lib:{id,name,base,key?,clearKey?}}  留空 key=不改，clearKey=清空
//       POST /test   body:{api}  测单条（不存储）
//       POST /testAll           遍历测全部并刷新“有效”

const { useState, useEffect, useCallback, Fragment } = React
const { Card, Btn, Switch, Row, Select, Seg, Empty } = ui

const TYPE_OPTIONS = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'mixed', label: '混合' },
]
const SCOPE_OPTIONS = [
  { value: 'everyone', label: '所有人' },
  { value: 'owner', label: '仅主人' },
]

function emptyApi() {
  return {
    id: 'new', name: '', url: '', libId: '', path: '', method: 'GET', params: [{ k: '', v: '', d: '' }],
    type: 'image', parts: [], parse: [''], template: '', errorTpl: '', keywords: [{ value: '', mode: 'exact' }], enabled: true, valid: false,
  }
}

// ---- 小组件 ----
const Input = ({ value, onChange, placeholder, style, type, disabled }) =>
  h('input', { className: 'ab-input', type: type || 'text', value: value || '', placeholder: placeholder || '',
    disabled: !!disabled,
    style: { width: '100%', flex: '1', ...(style || {}) },
    onChange: (e) => onChange(e.target.value) })
const TextArea = ({ value, onChange, placeholder, rows }) =>
  h('textarea', { className: 'ab-input', value: value || '', placeholder: placeholder || '', rows: rows || 3,
    style: { width: '100%', resize: 'vertical' },
    onChange: (e) => onChange(e.target.value) })
const TextRow = ({ label, hint, children }) =>
  h(Row, { label, hint },
    h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', gap: 6 } }, children))

// 键 / 值 / 默认值 编辑（默认值仅在「测试」时兜底，真实触发不生效，捕获缺失就走错误模板）
const KVEditor = ({ items, onChange }) => {
  const set = (idx, patch) => {
    const next = items.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    onChange(next)
  }
  const add = () => onChange([...items, { k: '', v: '', d: '' }])
  const del = (idx) => onChange(items.filter((_, i) => i !== idx))
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    items.map((p, i) =>
      h('div', { key: i, style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h(Input, { placeholder: '键 key', value: p.k, onChange: (k) => set(i, { k }), style: { width: 110 } }),
        h(Input, { placeholder: '值，如 {qq}/{hero}/{match}/{text}', value: p.v, onChange: (v) => set(i, { v }) }),
        h(Input, { placeholder: '默认值', value: p.d || '', onChange: (d) => set(i, { d }), style: { width: 100 } }),
        h(Btn, { small: true, onClick: () => del(i) }, '✕'))),
    h('div', {}, h(Btn, { small: true, onClick: add }, '+ 添加参数')))
}
const ListEditor = ({ items, onChange, placeholder, oneRow }) => {
  const rows = (items && items.length) ? items : (oneRow ? [''] : []) // 解析表达式默认留一个空框
  const set = (idx, v) => onChange(rows.map((x, i) => (i === idx ? v : x)))
  const add = () => onChange([...rows, ''])
  const del = (idx) => onChange(rows.filter((_, i) => i !== idx))
  if (!rows.length) return h('div', {}, h(Btn, { small: true, onClick: add }, '+ 添加'))
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    rows.map((x, i) =>
      h('div', { key: i, style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h(Input, { value: x, onChange: (v) => set(i, v), placeholder, style: {} }),
        h(Btn, { small: true, onClick: () => del(i) }, '✕'))),
    h('div', {}, h(Btn, { small: true, onClick: add }, '+ 添加')))
}

// 触发关键词：每行 = 关键词 + 匹配方式下拉（完全匹配 / 正则匹配），默认「完全匹配」。
// 旧配置里的纯字符串按「正则匹配」显示，行为不变。
const MATCH_MODE_OPTIONS = [
  { value: 'exact', label: '完全匹配' },
  { value: 'regex', label: '正则匹配' },
]
const normKeyword = (k) => (k && typeof k === 'object')
  ? { value: String(k.value ?? ''), mode: k.mode === 'exact' ? 'exact' : 'regex' }
  : { value: String(k ?? ''), mode: 'regex' } // 旧纯字符串按「正则匹配」显示，行为不变
const KeywordsEditor = ({ items, onChange }) => {
  const rows = (items && items.length) ? items : [{ value: '', mode: 'exact' }]
  const set = (idx, patch) => onChange(rows.map((k, i) => (i === idx ? { ...normKeyword(k), ...patch } : k)))
  const add = () => onChange([...rows, { value: '', mode: 'exact' }])
  const del = (idx) => onChange(rows.filter((_, i) => i !== idx))
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    rows.map((k, i) => {
      const n = normKeyword(k)
      return h('div', { key: i, style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h(Input, { value: n.value, onChange: (value) => set(i, { value }), placeholder: '关键词或正则，如 狮子座 / 座$' }),
        h(Select, { value: n.mode, options: MATCH_MODE_OPTIONS, style: { width: 110 },
          onChange: (mode) => set(i, { mode }) }),
        h(Btn, { small: true, onClick: () => del(i) }, '✕'))
    }),
    h('div', {}, h(Btn, { small: true, onClick: add }, '+ 添加关键词')))
}
// 「混合」类型的消息段编辑：每行 = 类型 + 该段自己的解析表达式
const PART_TYPES = [
  { value: 'text', label: '文字' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
]
const PartsEditor = ({ items, onChange }) => {
  const set = (idx, patch) => onChange(items.map((p, i) => (i === idx ? { ...(p || {}), ...patch } : p)))
  const add = () => onChange([...(items || []), { type: 'text', value: '' }])
  const del = (idx) => onChange(items.filter((_, i) => i !== idx))
  const move = (idx, step) => {
    const j = idx + step
    if (j < 0 || j >= items.length) return
    const next = items.slice(); const t = next[idx]; next[idx] = next[j]; next[j] = t; onChange(next)
  }
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    (items || []).map((p, i) =>
      h('div', { key: i, style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h(Select, { value: p?.type || 'text', options: PART_TYPES, style: { width: 90 },
          onChange: (type) => set(i, { type }) }),
        h(Input, { value: p?.value || '', onChange: (value) => set(i, { value }),
          placeholder: '解析表达式，如 $.data.reply / $.data.image_url' }),
        h(Btn, { small: true, onClick: () => move(i, -1) }, '↑'),
        h(Btn, { small: true, onClick: () => move(i, 1) }, '↓'),
        h(Btn, { small: true, onClick: () => del(i) }, '✕'))),
    h('div', {}, h(Btn, { small: true, onClick: add }, '+ 添加消息段')))
}

// ---- 编辑 / 新增 API 弹层 ----
function EditModal({ api, libs, onSave, onCancel, onTest }) {
  const [d, setD] = useState(api)
  const set = (patch) => setD((p) => ({ ...p, ...patch }))
  const testing = useState(false)
  const [testingState] = testing
  const [testOut, setTestOut] = useState(null)

  const runTest = async () => {
    testing[1](true); setTestOut(null)
    try { const r = await call('/test', { api: d }); setTestOut(r) } catch (e) { setTestOut({ ok: false, message: '请求失败：' + e.message }) }
    testing[1](false)
  }

  return h(Card, { title: (d.id && d.id !== 'new') ? '编辑 API' : '添加 API', desc: '接口定义 + 触发配置；生效范围在下方全局设置' },
    // —— 接口定义 ——
    h(TextRow, { label: '名称', hint: '给接口起个名字' },
      h(Input, { value: d.name, onChange: (v) => set({ name: v }), placeholder: '如：电脑壁纸' })),
    h(TextRow, { label: '请求地址', hint: '直接贴完整 URL，或从 API 库选站点只填路径' },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h(Seg, { value: d.libId ? 'lib' : 'url',
          options: [{ value: 'url', label: '直接 URL' }, { value: 'lib', label: 'API 库 + 路径' }],
          onChange: (v) => set(v === 'lib' ? { libId: libs?.[0]?.id || '', path: '', url: '' } : { libId: '', url: '' }) }),
        d.libId
          ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h(Select, { value: d.libId, options: (libs || []).map((l) => ({ value: l.id, label: l.name })), onChange: (libId) => set({ libId }), style: { width: 180 } }),
              h(Input, { value: d.path, onChange: (v) => set({ path: v }), placeholder: '接口路径，如 wzyyb.php ' }))
          : h(Input, { value: d.url, onChange: (v) => set({ url: v }), placeholder: 'https://api.example.com/data' }))),
    h(TextRow, { label: '请求方式', hint: 'POST 用表单格式提交参数' },
      h(Seg, { value: d.method, options: [{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }],
        onChange: (v) => set({ method: v }) })),
    h(TextRow, { label: '参数', hint: '值可写 {qq}/{match}/{text} 等内置变量，默认值仅「测试」时兜底' },
      h(KVEditor, { items: d.params || [], onChange: (params) => set({ params }) })),
    h(TextRow, { label: '数据类型', hint: '决定回复怎么发；「混合」可分成多条消息' },
      h(Select, { value: d.type, options: TYPE_OPTIONS, onChange: (v) => set({ type: v }) })),
    d.type === 'mixed' && h(TextRow, { label: '混合消息段', hint: '一行一段、自上而下发送；文字段取到字典才用下方「回复模板」。' },
      h(PartsEditor, { items: d.parts || [], onChange: (parts) => set({ parts }) })),
    d.type !== 'mixed' && h(TextRow, { label: '解析表达式', hint: '点号路径取返回里的字段，如 $.data.url；留空用整段返回' },
      h(ListEditor, { items: d.parse || [], onChange: (parse) => set({ parse }), placeholder: '如 $.data.url', oneRow: true })),
    h(TextRow, { label: '回复模板（可选）', hint: '对「文本」类型、及「混合」文字段取到字典时生效；用 {路径} 拼字段。' },
      h(TextArea, { value: d.template || '', onChange: (v) => set({ template: v }), placeholder: '例：\n「{data.name}」今日运势 {data.overall.level}\n{data.overall.summary}\n宜：{data.yi}  忌：{data.ji}' })),
    h(TextRow, { label: '错误模板（可选）', hint: '所有类型、所有失败场景通用；可用 {error} 与内置变量。' },
      h(TextArea, { value: d.errorTpl || '', onChange: (v) => set({ errorTpl: v }), rows: 2, placeholder: '例：格式错误~ 请输入正确格式，如「王者语音瑶」' })),
    // —— 触发配置 ——（生效范围已提升为全局，在下方「生效范围（全局）」卡片里统一设置）
    h('div', { className: 'margin' }, h('div', { className: 'ab-note', style: { margin: '10px 0' } }, '— 触发配置 —')),
    h(TextRow, { label: '触发关键词', hint: '默认整条消息完全相等才命中；切「正则匹配」可用正则 / {变量名}，详见 README。' },
      h(KeywordsEditor, { items: d.keywords || [], onChange: (keywords) => set({ keywords }) })),

    testOut && h('div', { className: 'ab-flex', style: { marginTop: 10, gap: 8, alignItems: 'center' } },
      testOut.ok
        ? h('span', { className: 'ab-small', style: { color: '#2e7d32' } }, '✓ ' + testOut.message)
        : h('span', { className: 'ab-small', style: { color: '#c62828' } }, '✗ ' + testOut.message)),

    h('div', { className: 'ab-flex', style: { marginTop: 16, justifyContent: 'flex-end', gap: 8, alignItems: 'center' } },
      h(Btn, { small: true, disabled: testingState, onClick: runTest }, '测试参数'),
      h(Btn, { small: true, onClick: () => onSave(d) }, '保存'),
      h(Btn, { small: true, onClick: onCancel }, '取消')))
}

// ---- API 库管理（增删改一个个站点基地址 + 可选密钥） ----
// 密钥「只写」：面板读到的库只有 hasKey 标记，编辑时不回填明文；留空=不改，填新值=替换，
// 点「清除密钥」才真的清空。选了该库的接口请求会自动带 Authorization: Bearer <密钥>。
function LibManager({ libs, reload }) {
  const [lib, setLib] = useState(null) // null 或 {id?,name,base,hasKey} 编辑态
  const [name, setName] = useState('')
  const [base, setBase] = useState('')
  const [key, setKey] = useState('') // 新密钥输入（明文只写：打开编辑时一律清空）
  const reset = () => { setLib(null); setName(''); setBase(''); setKey('') }
  const openEdit = (l) => { setLib(l); setName(l.name); setBase(l.base); setKey('') }
  const openNew = () => { setLib({}); setName(''); setBase(''); setKey('') }
  const saveLib = async (clearKey) => {
    const payload = { id: lib?.id || '', name, base, key: clearKey ? '' : key }
    if (clearKey) payload.clearKey = true
    const r = await call('/libSave', { lib: payload })
    if (r && r.ok) { reset(); reload() }
    else alert(r?.message || '保存失败')
  }
  const delLib = async (l) => {
    if (!confirm('删除库「' + l.name + '」？（已有接口若引用它会失效）')) return
    const r = await call('/libDel', { id: l.id })
    if (r && r.ok) { reload() } else alert(r?.message || '删除失败')
  }
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    lib
      ? h('div', { className: 'ab-flex', style: { gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h(Input, { value: name, onChange: setName, placeholder: '库名称，如 塘豆', style: { width: 130 } }),
          h(Input, { value: base, onChange: setBase, placeholder: '基地址，如 https://api.tinyaii.cn', style: { width: 220 } }),
          h(Input, { value: key, onChange: setKey, type: 'password', style: { width: 200 },
            placeholder: lib?.hasKey ? '密钥已设置：填新值替换，留空不改' : '密钥（可留空=不需要）' }),
          lib?.hasKey && h('span', { className: 'ab-small', style: { color: '#2a7' } }, '🔑 已设置'),
          h(Btn, { small: true, onClick: () => saveLib(false) }, '保存'),
          lib?.hasKey && h(Btn, { small: true, onClick: () => saveLib(true) }, '清除密钥'),
          h(Btn, { small: true, onClick: reset }, '取消'))
      : h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'center' } },
          h('div', { style: { flex: 1 } }),
          h(Btn, { small: true, onClick: openNew }, '+ 添加 API 库')),
    h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 } },
      h('thead', {}, h('tr', {},
        ['名称', '基地址', '密钥', '操作'].map((c) => h('th', { key: c, style: { ...thStyle, textAlign: 'left' } }, c)))),
      h('tbody', {},
        (!libs.length)
          ? h('tr', {}, h('td', { colSpan: 4, style: { padding: 12, textAlign: 'center', color: '#999' } }, '还没有 API 库，点右上角「添加 API 库」'))
          : libs.map((l) =>
              h('tr', { key: l.id, style: { borderTop: '1px solid #eee' } },
                h('td', { style: tdStyle }, h('b', {}, l.name)),
                h('td', { style: tdStyle }, h('span', { className: 'ab-small', style: { wordBreak: 'break-all' } }, l.base)),
                h('td', { style: tdStyle }, l.hasKey
                  ? h('span', { className: 'ab-small', style: { color: '#2a7' } }, '🔑 已设置')
                  : h('span', { className: 'ab-small', style: { color: '#999' } }, '—')),
                h('td', { style: tdStyle },
                  h('div', { className: 'ab-flex', style: { gap: 6, alignItems: 'center' } },
                    h(Btn, { small: true, onClick: () => openEdit(l) }, '编辑'),
                    h(Btn, { small: true, onClick: () => delLib(l) }, '删除'))))))))
}

// ---- 主面板 ----
function App({ settings, save, toast }) {
  const [pool, setPool] = useState({ groups: [], scope: 'everyone', blacklist: [], apis: [], libraries: [] })
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState(null) // null 或 api 对象（含当前表格用例）
  const [gidText, setGidText] = useState('')
  const [scope, setScope] = useState('everyone')
  const [blacklistText, setBlacklistText] = useState('')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [testingAll, setTestingAll] = useState(false)
  const [page, setPage] = useState(1)
  const [importUrl, setImportUrl] = useState('')
  const [importFile, setImportFile] = useState('')
  const PAGE_SIZE = 10

  const refresh = useCallback(async () => {
    try {
      const r = await call('/pool')
      if (r && r.pool) {
        setPool(r.pool)
        setGidText((r.pool.groups || []).join('\n'))
        setScope(r.pool.scope === 'owner' ? 'owner' : 'everyone')
        setBlacklistText((r.pool.blacklist || []).join('\n'))
      }
    } catch (e) { toast?.('读取配置失败：' + e.message) } finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [])

  const doExport = async () => {
    const r = await call('/export')
    if (r && r.ok) toast?.(r.message + '（可在系统下载目录找到）')
    else toast?.(r?.message || '导出失败')
  }
  const importFromFile = async (ev) => {
    const file = ev.target.files && ev.target.files[0]
    ev.target.value = '' // 允许重复选同一文件
    if (!file) return
    const text = await file.text()
    setImportFile(text) // 选择后内容显示在前面的文本框里
  }
  const doImportFile = async () => {
    const text = (importFile || '').trim()
    if (!text) { toast?.('请先选择配置文件'); return }
    const r = await call('/import', { data: text })
    if (r && r.ok) { toast?.(r.message); setImportFile(''); await refresh() }
    else toast?.(r?.message || '导入失败')
  }
  const importFromUrl = async () => {
    const url = (importUrl || '').trim()
    if (!url) { toast?.('请先填写配置文件地址'); return }
    const r = await call('/importUrl', { url })
    if (r && r.ok) { toast?.(r.message); setImportUrl(''); await refresh() }
    else toast?.(r?.message || '导入失败')
  }

  const saveSettings = async () => {
    const groups = gidText.split(/[\n,，\s]+/).map((s) => s.trim()).filter(Boolean)
    const blacklist = blacklistText.split(/[\n,，\s]+/).map((s) => s.trim()).filter(Boolean)
    await call('/settings', { groups, scope, blacklist })
    setPool((p) => ({ ...p, groups, scope, blacklist }))
    toast?.('已保存生效设置（' + groups.length + ' 个群 / ' + blacklist.length + ' 人黑名单）')
  }

  const toggleEnabled = async (a) => {
    const next = { ...a, enabled: !a.enabled }
    await call('/save', { api: next })
    setPool((p) => ({ ...p, apis: p.apis.map((x) => (x.id === a.id ? next : x)) }))
  }
  const delApi = async (a) => {
    if (!confirm('确定删除「' + a.name + '」？')) return
    await call('/del', { id: a.id })
    setPool((p) => ({ ...p, apis: p.apis.filter((x) => x.id !== a.id) }))
    toast?.('已删除')
  }
  const testOne = async (a) => {
    const r = await call('/test', { api: a })
    toast?.(r.ok ? ('✓ ' + r.message) : ('✗ ' + r.message))
    // 单条测试成功 → 立即刷新该行「有效」标记（避免需切标签页才更新）
    if (r.ok) setPool((p) => ({ ...p, apis: p.apis.map((x) => (x.id === a.id ? { ...x, valid: true } : x)) }))
  }
  const testAll = async () => {
    setTestingAll(true)
    try {
      const r = await call('/testAll')
      toast?.(r.summary || '测试完成')
      await refresh()
    } catch (e) { toast?.('测试失败：' + e.message) } finally { setTestingAll(false) }
  }

  const onSave = async (d) => {
    const r = await call('/save', { api: d })
    if (r && r.ok) { toast?.(r.message); setEdit(null); await refresh() }
    else toast?.(r ? r.message : '保存失败')
  }

  const kwText = (a) => (a.keywords || []).map((k) => normKeyword(k).value).filter(Boolean).join(' / ') || '—'
  const libBase = (id) => { const l = (pool.libraries || []).find((x) => x.id === id); return l ? l.base : '' }
  const effUrl = (a) => {
    if (a && a.libId) {
      const base = libBase(a.libId)
      if (base) return base.replace(/\/+$/, '') + '/' + String(a.path || '').replace(/^\/+/, '')
      return ''
    }
    return String(a.url || '').trim()
  }
  const apis = (pool.apis || []).filter((a) => {
    if (typeFilter !== 'all' && a.type !== typeFilter) return false
    if (search) {
      const s = search.toLowerCase()
      const hay = (a.name + ' ' + effUrl(a) + ' ' + kwText(a)).toLowerCase()
      if (!hay.includes(s)) return false
    }
    return true
  })
  const totalPages = Math.max(1, Math.ceil(apis.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageApis = apis.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    // —— 导入 / 导出 ——
    h(Card, { title: '导入 / 导出（分享配置）', desc: '把「API 库 + API 池」整体导出成一份 JSON 分享给他人，或导入别人分享的配置文件。导入按基地址去重相同库、重复 API 自动追加新 ID，不会覆盖你现有的；生效群不参与导入导出。' },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h(Row, { label: '导出', hint: '把当前「API 库 + API 池」导出成 .json 文件，默认保存到系统「下载」目录' },
          h('div', { style: { flex: 1 } },
            h(Btn, { small: true, onClick: doExport }, '导出到下载目录'))),
        h(Row, { label: '导入', hint: '选择一份 .json 配置文件（内容会显示在文本框）点「导入」，或填网络地址点「从网络地址导入」。' },
          h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 8 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h(Input, { value: importFile, onChange: setImportFile, placeholder: '选择配置文件后内容显示在这里…', style: { flex: 1 } }),
              h('label', { style: { cursor: 'pointer', display: 'inline-flex' } },
                h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: importFromFile }),
                h('span', { style: { padding: '5px 12px', borderRadius: 6, fontSize: 13, border: '1px solid #d0d0d0', background: '#f5f5f5', color: '#333' } }, '选择配置文件')),
              h(Btn, { small: true, onClick: doImportFile, disabled: !(importFile || '').trim() }, '导入')),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h(Input, { value: importUrl, onChange: setImportUrl, placeholder: 'https://example.com/api-pool-20261108.json', style: { flex: 1 } }),
              h(Btn, { small: true, onClick: importFromUrl, disabled: !(importUrl || '').trim() }, '从网络地址导入')))))),

    // —— 生效范围（全局）：统一控制所有 API，不用一条条改 ——
    h(Card, { title: '生效范围（全局）', desc: '生效群 + 触发范围 + 触发人黑名单，统一对所有接口生效' },
      h(Row, { label: '群号', hint: '每行一个 QQ 群号；留空则所有群都不生效' },
        h(TextArea, { value: gidText, onChange: setGidText, rows: 3, placeholder: '如：\n123456789\n987654321' })),
      h(Row, { label: '触发范围', hint: '「仅主人」时只有主人能触发所有接口' },
        h(Select, { value: scope, options: SCOPE_OPTIONS, onChange: setScope })),
      h(Row, { label: '触发人黑名单', hint: '每行一个 QQ 号；被拉黑的人一律触发不了，其他群友照常' },
        h(TextArea, { value: blacklistText, onChange: setBlacklistText, rows: 3, placeholder: '如：\n10001\n10002' })),
      h('div', { className: 'ab-flex', style: { justifyContent: 'flex-end' } },
        h(Btn, { small: true, onClick: saveSettings }, '保存生效设置'))),

    // —— API 库 ——
    h(Card, { title: 'API 库', desc: '保存 API 站点（基地址）+ 可选密钥；选了库的接口请求会自动带 Bearer 密钥，密钥不导出' },
      h(LibManager, { libs: pool.libraries || [], reload: refresh })),

    // —— 操作条 ——
    h(Card, { title: 'API 池', desc: '共 ' + (pool.apis || []).length + ' 条；命中关键词即机械回复，不经模型' },
      h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' } },
        h(Input, { value: search, onChange: setSearch, placeholder: '搜索名称 / URL / 关键词', style: { width: 220 } }),
        h(Select, { value: typeFilter, width: 110,
          options: [{ value: 'all', label: '全部类型' }, ...TYPE_OPTIONS],
          onChange: setTypeFilter }),
        h('div', { style: { flex: 1 } }),
        h(Btn, { small: true, disabled: testingAll, onClick: testAll }, testingAll ? '测试中…' : '测试全部 API'),
        h(Btn, { small: true, onClick: () => setEdit(emptyApi()) }, '+ 添加 API')),

      // —— 添加 / 编辑 API 表单（表格上方）——
      edit && h(EditModal, { api: edit, libs: pool.libraries || [], onSave, onCancel: () => setEdit(null) }),

      h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 } },
        h('thead', {}, h('tr', {},
          ['名称', 'URL', '类型', '有效', '触发关键词', '操作'].map((c) =>
            h('th', { key: c, style: thStyle, textAlign: 'left' }, c)))),
        h('tbody', {},
          (!pageApis.length)
            ? h('tr', {}, h('td', { colSpan: 6, style: { padding: 16, textAlign: 'center', color: '#999' } }, loading ? '加载中…' : '暂无接口，点右上角「添加 API」'))
            : pageApis.map((a) =>
                h('tr', { key: a.id, style: { borderTop: '1px solid #eee' } },
                  h('td', { style: tdStyle }, h('b', {}, a.name)),
                  h('td', { style: tdStyle }, h('span', { className: 'ab-small', style: { wordBreak: 'break-all' } }, effUrl(a))),
                  h('td', { style: tdStyle }, h('span', { className: 'ab-small' }, TYPE_LABEL(a.type))),
                  h('td', { style: tdStyle }, h('span', { className: 'ab-small', style: { color: a.valid ? '#2e7d32' : '#c62828' } }, a.valid ? '是' : '否')),
                  h('td', { style: tdStyle }, h('span', { className: 'ab-small' }, kwText(a))),
                  h('td', { style: tdStyle },
                    h('div', { className: 'ab-flex', style: { gap: 6, alignItems: 'center' } },
                      h(Switch, { on: a.enabled !== false, onChange: () => toggleEnabled(a) }),
                      h(Btn, { small: true, onClick: () => testOne(a) }, '测试'),
                      h(Btn, { small: true, onClick: () => setEdit(a) }, '编辑'),
                      h(Btn, { small: true, onClick: () => delApi(a) }, '删除'))))))),

      // —— 分页 ——
      h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'center', marginTop: 10, justifyContent: 'center' } },
        h(Btn, { small: true, disabled: safePage <= 1, onClick: () => setPage(safePage - 1) }, '‹ 上一页'),
        totalPages > 1
          ? h('span', { className: 'ab-small' }, '第 ' + safePage + ' / ' + totalPages + ' 页（共 ' + apis.length + ' 条）')
          : h('span', { className: 'ab-small' }, '共 ' + apis.length + ' 条'),
        h(Btn, { small: true, disabled: safePage >= totalPages, onClick: () => setPage(safePage + 1) }, '下一页 ›'))))
}

const thStyle = { padding: '8px 6px', borderBottom: '2px solid #ddd', whiteSpace: 'nowrap' }
const tdStyle = { padding: '8px 6px', maxWidth: 220 }
const TYPE_LABEL = (t) => ({ text: '文本', image: '图片', video: '视频', audio: '音频', mixed: '混合' }[t] || t)

return App