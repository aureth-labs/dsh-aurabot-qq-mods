const { Card, Btn, Row, Select, Seg, Switch } = ui
const sources = [{ value: 'konachan', label: 'Konachan' }, { value: 'yandere', label: 'Yande.re' }]

function fieldControl(field, values, change) {
  const { key, type, label, options, min, max } = field
  const value = values[key]
  const placeholder = values[`${key}Set`] ? '已保存（不改就留空）' : field.placeholder
  if (type === 'switch') return h(Switch, { on: Boolean(value), onChange: change, title: label })
  if (type === 'select') return h(Select, { value, options, onChange: change, ariaLabel: label })
  if (type === 'multi-select') {
    const selected = Array.isArray(value) ? value : [value || 's']
    return h('div', { role: 'group', 'aria-label': label, style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
      ...options.map(option => {
        const checked = selected.includes(option.value)
        return h('label', { key: option.value }, h('input', { type: 'checkbox', checked, disabled: checked && selected.length === 1,
          onChange: () => change(checked ? selected.filter(item => item !== option.value) : [...selected, option.value]),
        }), ' ', option.label)
      }))
  }
  const props = { value: value ?? '', placeholder, 'aria-label': label, onChange: e => {
    const next = e.target.value
    change(type === 'number' && next !== '' ? Number(next) : next)
  } }
  if (type === 'textarea') return h('textarea', { ...props, className: 'ab-textarea' })
  return h('input', { ...props, type, min, max, className: 'ab-input', autoComplete: type === 'password' ? 'off' : undefined })
}

return function DailyArtPanel({ draftSettings, setSettings }) {
  const [schema, setSchema] = React.useState(null)
  const [error, setError] = React.useState('')
  const [source, setSource] = React.useState('konachan')
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState(null)
  const [credentials, setCredentials] = React.useState({})
  const [notice, setNotice] = React.useState('')

  React.useEffect(() => {
    let alive = true
    call('/settings-schema').then(data => {
      if (!alive) return
      if (data.ok) setSchema(data)
      else setError(data.message || '读取推图配置失败')
    }).catch(() => { if (alive) setError('读取推图配置失败') })
    return () => { alive = false }
  }, [])

  const isKonachan = source === 'konachan'

  async function admin(path, body, done) {
    setBusy(true)
    setNotice('')
    try {
      const response = await call(path, body)
      if (response.ok) done(response)
      else setNotice(response.message || '操作失败')
    } catch { setNotice('无法连接 Aurabot') }
    finally { setBusy(false) }
  }

  async function test() {
    setResult(null)
    await admin('/connection-test', { source }, setResult)
  }

  function saveCredentials() {
    return admin('/credentials', credentials, response => {
      setSchema(previous => ({ ...previous, konachanApiKeySet: response.konachanApiKeySet, konachanProxyUrlSet: response.konachanProxyUrlSet }))
      setCredentials({})
      setNotice('凭据已保存')
    })
  }

  const row = (field, values, change) => h(Row, { key: field.key, label: field.label, hint: field.hint }, fieldControl(field, values, change))
  const setShared = (key, value) => setSettings({ [key]: value })
  const setSourceField = (key, value) => isKonachan ? setShared(key, value) : setSettings({ yandere: { ...draftSettings.yandere, [key]: value } })
  const setCredential = (key, value) => setCredentials(previous => ({ ...previous, [key]: value }))

  if (!schema) return h(Card, { title: '每日推图' }, error || '正在加载配置…')
  const values = isKonachan ? draftSettings : { ...schema.scheduleDefaults, ...draftSettings.yandere }
  const fields = schema.scheduleFields.map(field => field.key === 'pushRating'
    ? { ...field, options: schema.ratings[source], hint: isKonachan ? '当前 Konachan 安全站点仅返回 Safe。' : '可多选，图片匹配任一勾选分级即可。默认 Safe。' }
    : field)

  return h(React.Fragment, null,
    h(Card, { title: '图源凭据', desc: '在面板管理 Konachan API Key 和两个图源共用的代理地址。' },
      ...[schema.proxyField, ...schema.accountFields.filter(field => field.type === 'password')].map(field => row(field, { ...schema, ...credentials }, value => setCredential(field.key, value))),
      h(Btn, { small: true, onClick: () => setCredential('konachanProxyUrl', '') }, '标记清除代理'),
      h(Btn, { small: true, onClick: () => setCredential('konachanApiKey', '') }, '标记清除密钥'),
      h(Btn, { disabled: busy || !Object.keys(credentials).length, onClick: saveCredentials }, '保存凭据'),
      notice ? h('div', { role: 'status' }, notice) : null),
    h(Card, { title: '按需找图权限' },
      row(schema.searchAccessField, draftSettings, value => setShared(schema.searchAccessField.key, value))),
    h(Card, { title: '图片缓存', desc: '开启后保存定时推送和按需找图下载的图片。' },
      row({ key: 'cacheImages', type: 'switch', label: '缓存图片' }, draftSettings, value => setShared('cacheImages', value)),
      row({ key: 'imageCacheDir', type: 'text', label: '缓存目录', placeholder: schema.defaultCacheDir,
        hint: '填写 Aurabot 运行环境中的绝对路径。留空使用默认目录。' }, draftSettings, value => setShared('imageCacheDir', value))),
    h(Card, { title: '图源配置', desc: '每个图源单独保存时间、张数、白名单和筛选条件。' },
      h(Seg, { value: source, options: sources, disabled: busy, onChange: value => { setSource(value); setResult(null) } }),
      ...fields.map(field => row(field, values, value => setSourceField(field.key, value))),
      ...(isKonachan ? schema.accountFields.filter(field => field.type !== 'password').map(field => row(field, draftSettings, value => setShared(field.key, value))) : []),
      h(Btn, { small: true, disabled: busy || Boolean(Object.keys(credentials).length), onClick: test }, busy ? '检测中…' : '检测连接'),
      result && (result.ok
        ? h('div', { className: 'ab-small' }, h('div', null, `${result.proxyConfigured ? '使用代理' : '直连'} · ${result.authenticatedRequest ? '优先尝试输入的密钥' : '公开接口'}`),
          ...result.results.map(item => h('div', { key: item.host }, `${item.host} · ${item.message}`,
            item.fallbackReason ? h('div', null, `已回退到公开接口（${item.fallbackReason}）`) : null,
            item.image ? h('div', null, item.image.message) : null)))
        : h('div', { className: 'ab-note err' }, result.message || '检测失败')),
    ),
  )
}
