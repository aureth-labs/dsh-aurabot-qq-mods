// AI 新闻推送面板：顶部三张状态卡（早报 / 午报 / 晚报），下方四个分页（早报 / 午报 / 晚报 / 共享）。
// 契约：源码在受限作用域执行（注入 React/h/ui/call），最后 return 一个组件。
return function NewsPushPanel(props) {
  const settings = props.settings || {}
  const save = props.save
  const toast = props.toast

  const [tab, setTab] = React.useState('morning')
  const [draft, setDraft] = React.useState({})
  const [status, setStatus] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  const [preview, setPreview] = React.useState({ kind: '', text: '' })

  const loadStatus = () => call('/status').then(setStatus).catch(() => setStatus(null))
  React.useEffect(() => { setDraft(Object.assign({}, settings)) }, [JSON.stringify(settings)])
  React.useEffect(() => { loadStatus() }, [])

  const val = (k) => (draft[k] === undefined ? (settings[k] === undefined ? '' : settings[k]) : draft[k])
  const setVal = (k) => (e) => setDraft(Object.assign({}, draft, { [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  // ── 小控件 ──
  const row = (label, child) => h('div', { style: { marginBottom: 10 } },
    h('div', { className: 'ab-small', style: { marginBottom: 4, fontWeight: 600 } }, label),
    child)
  const textField = (k, label, width) => row(label,
    h('input', { className: 'ab-input', style: { width: width || 240, maxWidth: '100%' }, value: val(k) === undefined ? '' : String(val(k)), onChange: setVal(k) }))
  const numField = (k, label) => row(label,
    h('input', { className: 'ab-input', style: { width: 110 }, value: val(k) === undefined ? '' : String(val(k)), onChange: setVal(k) }))
  const areaField = (k, label, rows) => row(label,
    h('textarea', { className: 'ab-textarea', style: { minHeight: 26 * (rows || 5), lineHeight: 1.5 }, value: val(k) === undefined ? '' : String(val(k)), onChange: setVal(k) }))
  const boolField = (k, label) => h('label', { key: k, style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 13 } },
    h('input', { type: 'checkbox', checked: val(k) !== false, onChange: setVal(k) }), label)

  const doSave = async () => {
    if (!save) return
    setBusy('save')
    try { await save(Object.assign({}, draft)); toast && toast('保存好了', 'ok'); setTimeout(loadStatus, 800) } catch (e) { toast && toast(e.message, 'err') }
    setBusy('')
  }

  const doPreview = async (kind) => {
    setBusy('preview-' + kind)
    setPreview({ kind, text: '' })
    try {
      const r = kind === 'forum' ? await call('/forum/preview') : await call('/preview?kind=' + kind)
      if (r && r.ok) setPreview({ kind, text: r.text || '（没有抓到内容）' })
      else if (toast) toast((r && r.message) || '预览失败', 'err')
    } catch (e) { if (toast) toast(e.message, 'err') }
    setBusy('')
  }

  const doSendMe = async (kind) => {
    setBusy('send-' + kind)
    try {
      const r = kind === 'forum' ? await call('/forum/send') : await call('/send?kind=' + kind)
      if (toast) toast(r && r.ok ? '发到你私聊了' : ((r && r.message) || '发送失败'), r && r.ok ? 'ok' : 'err')
    } catch (e) { if (toast) toast(e.message, 'err') }
    setBusy('')
  }

  const nodeInfo = (key) => (status && status.nodes && status.nodes[key]) || { enabled: false, time: '--:--', sent: '' }

  const statusCard = (key, title, hint) => {
    const n = nodeInfo(key)
    const dot = n.enabled ? '●' : '○'
    return h(ui.Card, { key, title: dot + ' ' + title, desc: hint },
      h('div', { className: 'ab-small', style: { lineHeight: 1.9 } },
        h('div', null, '时间：', h('strong', null, n.time || '--:--')),
        h('div', null, n.sent ? '今天：已发 ' + n.sent : '今天：还没发'),
        h('div', null, '状态：', n.enabled ? '已开启' : '已关闭')),
      h('div', { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', marginTop: 8 } },
        h(ui.Btn, { small: true, onClick: () => doPreview(key) }, busy === 'preview-' + key ? '生成中…' : '预览'),
        h(ui.Btn, { small: true, onClick: () => doSendMe(key) }, busy === 'send-' + key ? '发送中…' : '发我')))
  }

  const tabBtn = (id, label) => h(ui.Btn, { key: id, small: true, onClick: () => setTab(id) }, (tab === id ? '● ' : '') + label)

  const previewBox = (key) => (preview.kind === key && preview.text
    ? h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7, marginTop: 10, maxHeight: 360, overflow: 'auto' } }, preview.text)
    : null)

  return h('div', { className: 'ab-grid' },
    // 顶部三张状态卡
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 } },
      statusCard('morning', '早报', 'AI 新闻 · 每天早上一轮'),
      statusCard('forum', '午报 · 论坛速报', '校园论坛热帖 · 中午一轮'),
      statusCard('evening', '晚报', 'AI 新闻 · 每天晚上一轮')),

    // 分页
    h(ui.Card, { title: '参数设置', desc: '每个节点独立开关、时间、条数；改完点「保存设置」立即生效。' },
      h('div', { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap' } },
        tabBtn('morning', '早报'),
        tabBtn('forum', '午报'),
        tabBtn('evening', '晚报'),
        tabBtn('shared', '共享设置')),

      tab === 'morning'
        ? h('div', { style: { marginTop: 10 } },
            boolField('morningEnabled', '启用早报'),
            textField('morning', '发送时间（HH:MM）', 120),
            numField('morningCount', '发几条（1~8）'),
            areaField('bingMorning', 'Bing 新闻查询词（每行一条）', 6),
            boolField('sticker', '发完带一张表情包'),
            boolField('banner', '先发一行「早报来了」'),
            previewBox('morning'))
        : null,
      tab === 'forum'
        ? h('div', { style: { marginTop: 10 } },
            boolField('forumEnabled', '启用午报（论坛速报）'),
            textField('forumTime', '发送时间（HH:MM）', 120),
            textField('forumUrl', '论坛热门页地址', 560),
            numField('forumTopN', '抓几个候选帖'),
            numField('forumPickN', '速报发几条（1~6）'),
            boolField('forumHeadless', '浏览器无头模式（后台跑，不弹窗）'),
            textField('forumBrowserPort', '浏览器调试端口', 110),
            previewBox('forum'))
        : null,
      tab === 'evening'
        ? h('div', { style: { marginTop: 10 } },
            boolField('eveningEnabled', '启用晚报'),
            textField('evening', '发送时间（HH:MM）', 120),
            numField('eveningCount', '发几条（1~8）'),
            areaField('bingEvening', 'Bing 新闻查询词（每行一条）', 6),
            boolField('sticker', '发完带一张表情包'),
            boolField('banner', '先发一行「晚报来了」'),
            previewBox('evening'))
        : null,
      tab === 'shared'
        ? h('div', { style: { marginTop: 10 } },
            boolField('enabled', '总开关（关掉后三个节点都不发）'),
            areaField('feeds', '媒体源 RSS（每行 url|名称，可留空）', 4),
            areaField('keywords', '媒体关键词（逗号或换行分隔）', 6),
            areaField('hotKeywords', '热榜关键词（逗号或换行分隔）', 5),
            boolField('hotNodesEnabled', '启用全网热榜'),
            areaField('hotNodes', '热榜榜单（每行一个）', 3),
            areaField('prompt', 'AI 筛选提示词（system）', 10),
            areaField('askTemplate', 'AI 筛选模板（user，可用 {items} {n}）', 8),
            boolField('shortLinks', '链接转短链（默认关闭，国内短链常打不开）'),
            status ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } }, '当前时间：' + status.now) : null)
        : null,

      h('div', { style: { marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h(ui.Btn, { small: true, kind: 'primary', onClick: doSave }, busy === 'save' ? '保存中…' : '保存设置'),
        h(ui.Btn, { small: true, onClick: loadStatus }, '刷新状态'))))
}
