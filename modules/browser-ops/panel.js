// panel.js —— 浏览器自动化（browser-ops）的自定义面板
// 拿到 React、h（React.createElement）、ui（面板自带组件）、call（调模块路由）
// 模块 settings 数组留空：所有设置由本面板接管（总开关挂在模块名同一行），
// 默认值在下面 DEFAULTS 里兜底（原生表单不再渲染，避免两套表单重复）。
// 布局照 phone：①逛网页主卡（标题行=总开关；状态总览+运行设置+保存）
//   → ①¼ 红色「⚠️ 高权限风险提示」卡 → ②站点白名单 → ③主流程总纲（独立卡）
//   → ④浏览器自动化指引（左列表右编辑，人格页式分节编辑）。
const { useState, useEffect } = React

// 设置默认值（与 index.mjs getSettings() 的代码兜底一致，面板里也要显示出来而不是空白）
const DEFAULTS = {
  enabled: false, // 总开关：默认关
  ownerOnly: true, // 仅主人可用：默认开
  browserPath: '', // 浏览器路径；空 = 自动探测
  windowVisible: false, // 窗口显示在屏幕内：默认关（屏幕外运行）
  snapshotChars: 3000, // 页面快照字数上限
  navigateTimeoutMs: 15000, // 打开网页超时
  whitelist: '', // 站点白名单（每行一个域名），空 = 不限制
  injectGuides: true, // 浏览任务注入指引（总纲+场景手册）：默认开
}

return function Panel({ settings, save, toast }) {
  const [busy, setBusy] = useState('') // 当前在跑的操作名（按钮转圈/禁用用）
  const [st, setSt] = useState(null) // /status 的状态总览

  // ---- 编辑草稿：改了先存本地，点「保存设置」一次落盘；null = 与已存值一致（不脏）----
  const [draft, setDraft] = useState(null)
  const d = draft || { ...DEFAULTS, ...settings }
  const upd = (patch) => setDraft({ ...d, ...patch })
  const dirty = draft !== null

  const lock = (name, fn) => async () => {
    if (busy) return
    setBusy(name)
    try { await fn() } catch (e) { toast('出错了：' + (e.message || e)) }
    setBusy('')
  }

  // ---- 状态总览：打开面板拉一次，操作完可手动刷新 ----
  const loadStatus = lock('status', async () => { setSt(await call('/status')) })
  useEffect(() => { loadStatus() }, [])

  // ---- 总开关：挂在卡片标题行，即切即存（同 B 站页的写法） ----
  const masterOn = d.enabled === true
  const toggleMaster = lock('master', async () => {
    upd({ enabled: !masterOn })
    await save({ enabled: !masterOn })
    setDraft((p) => (p ? { ...p, enabled: !masterOn } : p))
    toast(!masterOn ? '总开关已打开，她可以开专用浏览器了' : '总开关已关，工具/命令/跨模块调用全部停用', 'ok')
  })

  // ---- 保存设置：草稿里改过的全部字段一次落盘 ----
  const saveSettings = () => lock('savesettings', async () => {
    await save(d)
    setDraft(null)
    toast('设置已保存', 'ok')
  })

  // ---- 打开/关闭专用浏览器（面板手动开关，不开面板不该弹窗口）----
  const openBrowser = lock('openb', async () => {
    if (!masterOn) return toast('总开关没开：先到上面把总开关打开')
    const r = await call('/open')
    if (!r.ok) return toast(r.message || r.error || '启动失败')
    toast('专用浏览器已就绪', 'ok')
    await loadStatus()
  })
  const closeBrowser = lock('closeb', async () => {
    await call('/close')
    toast('已关闭专用浏览器', 'ok')
    await loadStatus()
  })

  // ---- 指引提示词库：仿「人格」页的分节编辑（分节/整段来回切，保存仍是原来的一整段） ----
  // 节标记认两种写法：【标题】（文档首行）与「◆ 标题」（总则/操作套路/坑），拼回时保持原标记。
  const GSEC_HEAD = /^\s*(?:【([^【】\n]{1,40})】|◆\s*([^◆\n]{1,40}))\s*$/
  const GSEC_SUGGEST = ['总则', '操作套路', '坑']
  const GSEC_COLORS = ['#4f9a8c', '#8a7bc0', '#c08a4a', '#5f8fc7', '#c47a90', '#6f9f68', '#5c6fae', '#b9775a', '#8d9450', '#a173b5']
  let gsecSeq = 0
  const gsec = (title, marker, text) => ({ k: ++gsecSeq, title, marker, text })
  const splitGuide = (body) => {
    const out = [gsec(null, 'plain', '')] // 开头的无标题段（正文里没有任何节标记时兜底）
    let cur = out[0]
    let buf = []
    const flush = () => { cur.text = buf.join('\n').replace(/^\n+/, '').replace(/\s+$/, ''); buf = [] }
    for (const line of String(body || '').replace(/\r\n/g, '\n').split('\n')) {
      const m = GSEC_HEAD.exec(line.replace(/[​-‍﻿]/g, '').trim()) // 复制粘贴的零宽字符不算标题
      if (m) { flush(); cur = gsec((m[1] != null ? m[1] : m[2] || '').trim(), m[1] != null ? 'bracket' : 'dot', ''); out.push(cur) }
      else buf.push(line)
    }
    flush()
    if (out.length > 1 && out[0].title === null && !out[0].text.trim()) out.shift()
    return out
  }
  const joinGuide = (list) => list
    .map((s) => {
      const t = s.text.replace(/\s+$/, '')
      if (s.title === null) return t.trim()
      const head = s.marker === 'bracket' ? '【' + (s.title.trim() || '未命名') + '】' : '◆ ' + (s.title.trim() || '未命名')
      return (head + '\n' + t).trim()
    })
    .filter(Boolean).join('\n\n')
  const gRows = (text) => Math.min(22, Math.max(3, String(text || '').split('\n').length + 1))

  /** 一节指引：标题、正文、上下移、删除（样式类复用人格页的 ab-psec） */
  function GuideSection({ sec, i, n, onChange, onMove, onDelete }) {
    const color = GSEC_COLORS[sec.k % GSEC_COLORS.length]
    return h('div', { className: 'ab-psec', style: { '--c': color } },
      h('div', { className: 'ab-psec-head' },
        h('input', { className: 'ab-psec-title', value: sec.title || '', placeholder: '这一节叫什么', maxLength: 40, onChange: (e) => onChange({ title: e.target.value.replace(/[【】◆\n]/g, '') }) }),
        h('span', { className: 'ab-psec-n' }, sec.text.length + ' 字'),
        h('div', { className: 'ab-psec-act' },
          h('button', { type: 'button', className: 'ab-ibtn', title: '往上移', disabled: i === 0, onClick: () => onMove(-1) }, '↑'),
          h('button', { type: 'button', className: 'ab-ibtn', title: '往下移', disabled: i === n - 1, onClick: () => onMove(1) }, '↓'),
          h('button', { type: 'button', className: 'ab-ibtn danger', title: '删掉这一节', onClick: onDelete }, '✕'))),
      h('textarea', { value: sec.text, rows: gRows(sec.text), placeholder: '- 一条一行，短句就好', onChange: (e) => onChange({ text: e.target.value }) }))
  }

  const [guides, setGuides] = useState(null) // null = 还没加载；打开面板就自动拉一次
  const [guideKey, setGuideKey] = useState('')
  const [secs, setSecs] = useState([]) // 当前指引拆成的节
  const [whole, setWhole] = useState(false) // false=分节编辑，true=整段
  const [gdirty, setGdirty] = useState(false)
  const [creating, setCreating] = useState(false) // 「＋ 新增指引」的建卡页
  const [newKey, setNewKey] = useState('')
  const [newName, setNewName] = useState('')
  // ---- 主流程总纲（main）：独立卡编辑，不混进场景指引列表 ----
  const [mainSecs, setMainSecs] = useState(null) // null=未加载
  const [mainWhole, setMainWhole] = useState(false)
  const [mainDirty, setMainDirty] = useState(false)
  const mainGuide = (guides || []).find((g) => g.key === 'main') || null
  const sceneGuides = (guides || []).filter((g) => g.key !== 'main') // 场景指引列表不含总纲
  const pickGuide = (g) => { setGuideKey(g.key); setSecs(splitGuide(g.text || '')); setGdirty(false) }
  const loadGuides = async () => {
    const r = await call('/guides')
    const list = r.guides || []
    setGuides(list)
    setCreating(false)
    // 总纲跟着刷新（本地有未保存改动时不动它，免得被覆盖）
    const m = list.find((g) => g.key === 'main')
    if (m && !mainDirty) setMainSecs(splitGuide(m.text || ''))
    if (!list.some((g) => g.key === guideKey) && list.length) pickGuide(list.find((g) => g.key !== 'main') || list[0])
  }
  useEffect(() => { loadGuides().catch((e) => toast('指引库加载失败：' + (e.message || e))) }, [])
  const viewGuide = (key) => {
    if (gdirty && !confirm('这条指引还没保存，切走就丢了。确定切换？')) return
    const g = (guides || []).find((x) => x.key === key)
    if (g) pickGuide(g)
  }
  const startCreate = () => {
    if (gdirty && !confirm('当前指引还没保存，先放一放？')) return
    setNewKey(''); setNewName(''); setCreating(true)
  }
  const beginNew = () => {
    const key = newKey.trim()
    if (!/^[a-z0-9-]{2,40}$/.test(key)) { toast('key 只能是小写字母/数字/短横线（2~40 字）', 'err'); return }
    if (key === 'main') { toast('main 是主流程总纲的专用 key，请另起一个', 'err'); return }
    if ((guides || []).some((g) => g.key === key)) { toast('已有同名 key：' + key + '，保存会覆盖它；想另建就换个 key', 'err'); return }
    const name = newName.trim() || key
    setCreating(false)
    setGuideKey(key)
    setSecs(splitGuide('【' + name + ' · 场景手册】\n◆ 总则\n- \n\n◆ 操作套路\n- \n\n◆ 坑\n- '))
    setGdirty(true)
  }
  const updSec = (k, p) => { setSecs(secs.map((s) => (s.k === k ? { ...s, ...p } : s))); setGdirty(true) }
  const moveSec = (i, dd) => { const arr = secs.slice(); const [x] = arr.splice(i, 1); arr.splice(i + dd, 0, x); setSecs(arr); setGdirty(true) }
  const delSec = (s) => { if (s.text.trim() && !confirm('删掉「' + (s.title || '未命名') + '」这一节？')) return; setSecs(secs.filter((x) => x.k !== s.k)); setGdirty(true) }
  const addSec = (title) => { setSecs(secs.concat([gsec(title, 'dot', '')])); setGdirty(true) }
  const body = joinGuide(secs)
  const saveGuide = lock('saveguide', async () => {
    const r = await call('/guides', { key: guideKey, text: body })
    if (!r.ok) return toast(r.error || '保存失败')
    toast('已保存自定义指引：' + guideKey)
    setGdirty(false)
    await loadGuides()
  })
  const resetGuide = lock('delguide', async () => {
    const r = await call('/guides', { key: guideKey, reset: true })
    if (!r.ok) return toast(r.error || '还原失败')
    toast('已还原成内置版：' + guideKey)
    const g = await call('/guides')
    const list = g.guides || []
    setGuides(list); setGdirty(false)
    const cur = list.find((x) => x.key === guideKey)
    if (cur) pickGuide(cur)
  })

  // ---- 主流程总纲（main）：独立卡的编辑/保存/还原；删除入口不存在（内置条目删不掉） ----
  const mainBody = joinGuide(mainSecs || [])
  const updMainSec = (k, p) => { setMainSecs((mainSecs || []).map((s) => (s.k === k ? { ...s, ...p } : s))); setMainDirty(true) }
  const moveMainSec = (i, dd) => { const arr = (mainSecs || []).slice(); const [x] = arr.splice(i, 1); arr.splice(i + dd, 0, x); setMainSecs(arr); setMainDirty(true) }
  const delMainSec = (s) => { if (s.text.trim() && !confirm('删掉「' + (s.title || '未命名') + '」这一节？')) return; setMainSecs((mainSecs || []).filter((x) => x.k !== s.k)); setMainDirty(true) }
  const addMainSec = (title) => { setMainSecs((mainSecs || []).concat([gsec(title, 'dot', '')])); setMainDirty(true) }
  const saveMain = lock('savemain', async () => {
    const r = await call('/guides', { key: 'main', text: mainBody })
    if (!r.ok) return toast(r.error || '保存失败')
    toast('已保存主流程总纲', 'ok')
    setMainDirty(false)
    await loadGuides()
  })
  const resetMain = lock('resetmain', async () => {
    if (!confirm('把主流程总纲还原成内置版？自定义的改动会丢。')) return
    const r = await call('/guides', { key: 'main', reset: true })
    if (!r.ok) return toast(r.error || '还原失败')
    toast('已还原成内置总纲', 'ok')
    setMainDirty(false)
    await loadGuides()
  })

  // ---- 删除自定义指引：两道确认（先确认框，再手输 key）；内置指引没有这个按钮 ----
  const delGuide = (g) => lock('delguide:' + g.key, async () => {
    if (!confirm('删除自定义指引「' + (g.name || g.key) + '」（' + g.key + '）？删除后不可恢复。')) return
    if (prompt('最后确认：请输入它的 key「' + g.key + '」以删除') !== g.key) { toast('key 不对，已取消删除'); return }
    const r = await call('/guides', { key: g.key, del: true })
    if (!r.ok) return toast(r.error || '删除失败')
    toast('已删除自定义指引：' + g.key)
    if (guideKey === g.key) setGuideKey('')
    await loadGuides()
  })

  // 面板 Btn 调 onClick 时不传参：这里吞掉事件、靠闭包传行数据，不然 handler 收到 undefined
  const btn = (label, onClick, key, primary) => h(ui.Btn, {
    key, kind: primary ? 'primary' : undefined, disabled: !!busy,
    onClick: async () => { const r = onClick(); if (typeof r === 'function') await r() },
  }, busy === key ? '处理中…' : label)

  // 状态总览里的一行「键：值」
  const stRow = (k, v) => h('div', { className: 'ab-small', style: { display: 'flex', gap: 8, marginTop: 2 } },
    h('span', { className: 'ab-muted', style: { flex: '0 0 96px' } }, k),
    h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, v))
  // 开关设置行（Row + Switch）
  const swRow = (label, key, hint) => h(ui.Row, { label, hint },
    h(ui.Switch, { on: d[key] === true, disabled: !!busy, title: label, onChange: () => upd({ [key]: d[key] !== true }) }))

  return h('div', null,

    // ===== ① 模块主卡：标题行 = 模块名 + 总开关，下面是状态总览 + 运行设置 + 保存 =====
    h(ui.Card, {
      title: '逛网页（浏览器自动化）',
      right: h('span', { className: 'ab-flex', style: { gap: 8, alignItems: 'center' } },
        h('span', { className: 'ab-small ab-muted' }, '总开关'),
        h(ui.Switch, { on: masterOn, disabled: !!busy, title: '总开关', onChange: toggleMaster }),
        h('span', { className: 'ab-badge mine' }, 'browser-ops')),
      desc: '封装 CDP 专用浏览器（独立登录资料）：打开网页、点击、输入、滚动、截屏、页面快照等原子操作，供其他模块复用。'
        + (masterOn ? ' 总开关开着：AI 工具、/browser 命令、跨模块调用都能开浏览器。' : ' 总开关关着：她开不了浏览器，所有入口全部停用。'),
    },
    // 状态总览（只读，一键刷新 + 手动开/关浏览器）
    st === null
      ? h('div', { className: 'ab-small ab-muted', style: { marginBottom: 8 } }, '状态加载中…')
      : h('div', { style: { marginBottom: 12 } },
        stRow('浏览器', st.connected ? '已连接（端口 ' + (st.port || '?') + '）' : '未连接'),
        stRow('登录资料', st.profileDir || '未知'),
        stRow('最近错误', st.lastError || '无'),
        stRow('指引', ((guides || []).length || 0) + ' 条'),
        h('div', { className: 'ab-flex', style: { marginTop: 6 } },
          btn('刷新状态', loadStatus, 'status'),
          btn('打开浏览器', openBrowser, 'openb'),
          btn('关闭浏览器', closeBrowser, 'closeb'))),
    // 运行设置
    swRow('仅主人可用', 'ownerOnly', 'AI 工具只在主人会话里可用（默认开；/browser 命令本来就只认主人）'),
    swRow('窗口显示在屏幕内', 'windowVisible', '默认关（屏幕外运行不抢前台）；扫二维码登录时可临时打开'),
    swRow('浏览任务注入指引', 'injectGuides', '执行浏览任务时先注入「主流程总纲 + 场景手册」再给页面快照（默认开）'),
    h(ui.Row, { label: '浏览器路径', hint: '留空自动探测：Edge → Chrome → Chromium；即改即存' },
      h('div', { className: 'ab-flex', style: { gap: 8, width: '100%' } },
        h('input', {
          className: 'ab-input', style: { flex: '1 1 240px' }, placeholder: '（自动探测）',
          defaultValue: d.browserPath, onBlur: (e) => { const v = e.target.value.trim(); if (v !== d.browserPath) { upd({ browserPath: v }); save({ browserPath: v }) } },
        }))),
    h(ui.Row, { label: '页面快照字数上限', hint: '快照是给模型读的文本摘要（默认 3000 字）' },
      h('input', { className: 'ab-input', style: { width: 100 }, type: 'number', min: 500, max: 8000, value: d.snapshotChars, onChange: (e) => upd({ snapshotChars: e.target.value }) })),
    h(ui.Row, { label: '打开网页超时（毫秒）', hint: '等页面 load 事件的上限（默认 15000）' },
      h('input', { className: 'ab-input', style: { width: 100 }, type: 'number', min: 3000, max: 60000, value: d.navigateTimeoutMs, onChange: (e) => upd({ navigateTimeoutMs: e.target.value }) })),
    // 保存行
    h('div', { className: 'ab-flex', style: { marginTop: 12 } },
      dirty ? h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, '有改动还没保存') : null,
      h('div', { className: 'ab-spacer' }),
      btn('💾 保存设置', saveSettings, 'savesettings', true))),

    // ===== ①¼ 高权限风险提示（红色突出，紧跟主卡）=====
    h('div', { style: { margin: '0 0 12px', padding: '10px 12px', border: '1px solid #e5484d', borderRadius: 8, background: 'rgba(229,72,77,.08)', borderColor: '#e5484d' } },
      h('div', { style: { color: '#e5484d', fontWeight: 700, fontSize: 13 } }, '⚠️ 高权限风险提示'),
      h('div', { className: 'ab-small', style: { color: '#e5484d', marginTop: 4, lineHeight: 1.6 } },
        '本模块启动的专用浏览器经 CDP 调试口接管：AI 可代你在浏览器里打开任意网页、点击、输入文字。'
        + '登录资料目录里存着 Cookie 等登录态，等于账号本体——拿到它就能免密码登录你的账号。'
        + '缓解措施：调试端口只监听 127.0.0.1（不对局域网/公网开放）、登录资料不随模块分发、默认窗口放屏幕外不抢前台。'
        + '请只在本人可信设备上开启；不要把登录资料目录交给任何人；不用时建议把总开关关上。')),

    // ===== ② 站点白名单（可选）：管住她只能打开哪些网站 =====
    h(ui.Card, { title: '站点白名单', desc: '管住她只能打开哪些网站，每行一个域名（如 bilibili.com，写主域即可，子域自动放行），空 = 不限制。改完点上面的「保存设置」落盘；AI 工具和跨模块 navigate 都会过这道门。' },
      h('textarea', {
        className: 'ab-textarea', rows: 5, style: { width: '100%', fontFamily: 'monospace', fontSize: 12 },
        placeholder: 'bilibili.com\nzhihu.com', value: d.whitelist, onChange: (e) => upd({ whitelist: e.target.value }),
      })),

    // ===== ③ 主流程总纲（独立于场景指引；主动浏览任务的章程，不可删除只能还原） =====
    h(ui.Card, { title: '主流程总纲', desc: '主人让逛网页、或其他模块发起浏览任务时，她按这份总纲决定任务怎么排、安全红线在哪。它独立于下面的场景手册，两边会一起注入决策上下文（总纲常驻、手册按任务目标挑）；只能编辑和还原内置版，不能删除。' },
      mainSecs === null
        ? h('span', { className: 'ab-muted ab-small' }, '加载中…')
        : h('div', null,
          h('div', { className: 'ab-flex', style: { marginBottom: 2 } },
            h(ui.Seg, { value: mainWhole ? 'whole' : 'secs', onChange: (v) => setMainWhole(v === 'whole'), options: [{ value: 'secs', label: '分节' }, { value: 'whole', label: '整段' }] }),
            h('div', { className: 'ab-spacer' }),
            h('span', { className: 'ab-muted ab-small' }, mainBody.length + ' 字')),
          mainWhole
            ? h('textarea', { className: 'ab-input', style: { width: '100%', minHeight: 260, marginTop: 10, fontFamily: 'monospace', fontSize: 12 }, value: mainBody, onChange: (e) => { setMainSecs(splitGuide(e.target.value)); setMainDirty(true) } })
            : h('div', { className: 'ab-psecs', style: { marginTop: 8 } },
              (mainSecs || []).map((s, i) => h(GuideSection, {
                key: s.k, sec: s, i, n: mainSecs.length,
                onChange: (p) => updMainSec(s.k, p), onMove: (dd) => moveMainSec(i, dd), onDelete: () => delMainSec(s),
              })),
              h('div', { className: 'ab-psec-add' },
                h('span', { className: 'ab-muted ab-small' }, '加一节：'),
                GSEC_SUGGEST.filter((t) => !(mainSecs || []).some((s) => s.title === t)).map((t) => h('button', { key: t, type: 'button', className: 'ab-chip', onClick: () => addMainSec(t) }, t)),
                h('button', { type: 'button', className: 'ab-chip solid', onClick: () => addMainSec('') }, '＋ 自己起名'))),
          h('div', { className: 'ab-flex', style: { marginTop: 12 } },
            mainDirty ? h('span', { className: 'ab-muted ab-small' }, '有改动还没保存') : null,
            h('div', { className: 'ab-spacer' }),
            btn('保存总纲', saveMain, 'savemain', true),
            btn('还原内置版', resetMain, 'resetmain')))),

    // ===== ④ 浏览器自动化指引（场景手册）：左列表右编辑，人格页式分节 =====
    h(ui.Card, { title: '浏览器自动化指引', desc: '教她怎么在网页里完成某类任务（怎么登录/搜索/读页/填表单）。浏览任务按目标关键词自动挑场景手册，和总纲一起注入；自定义条目可删除（要过两道确认），内置条目只能还原。主流程总纲在上面单独一张卡。' },
      h('div', { className: 'ab-persona' },
        // 左列：所有场景（内置 + 自定义，不含总纲）＋ 新增入口
        h('div', { className: 'ab-plist' },
          guides === null ? h('div', { className: 'ab-muted ab-small' }, '加载中…') : null,
          sceneGuides.map((g) => h('div', { key: g.key, style: { display: 'flex', gap: 4, alignItems: 'stretch' } },
            h('button', {
              type: 'button',
              className: 'ab-pitem' + (!creating && guideKey === g.key ? ' on' : ''),
              style: { flex: 1, minWidth: 0 },
              onClick: () => viewGuide(g.key),
            },
            h('div', { className: 'nm' }, g.name, g.source === 'custom' ? h('span', { className: 'ab-badge' }, '自定义') : null),
            h('div', { className: 'tg' }, g.key + ' · ' + (g.text || '').length + ' 字')),
          g.source === 'custom' ? h('button', { type: 'button', className: 'ab-ibtn danger', title: '删除这条自定义指引（两道确认）', disabled: !!busy, onClick: () => delGuide(g) }, '✕') : null)),
          h(ui.Btn, { kind: 'ghost', onClick: startCreate }, '＋ 新增指引')),
        // 右列：选中指引的分节/整段编辑，或新增指引的建卡页
        creating
          ? h(ui.Card, { title: '新增指引', desc: 'key 用于存盘，也可经 api.use(\'browser-ops\') 显式指定；名字显示在左边列表。' },
            h(ui.Row, { label: 'key', hint: '小写字母/数字/短横线，2~40 字' }, h('input', { className: 'ab-input', value: newKey, placeholder: 'my-scene', onChange: (e) => setNewKey(e.target.value) })),
            h(ui.Row, { label: '名字' }, h('input', { className: 'ab-input', value: newName, placeholder: '某场景', onChange: (e) => setNewName(e.target.value) })),
            h('div', { className: 'ab-flex', style: { marginTop: 12 } },
              h(ui.Btn, { kind: 'primary', onClick: beginNew }, '创建并开始编辑'),
              h(ui.Btn, { onClick: () => setCreating(false) }, '取消')))
          : guideKey
            ? h('div', null,
              h('div', { className: 'ab-flex', style: { marginBottom: 2 } },
                h(ui.Seg, { value: whole ? 'whole' : 'secs', onChange: (v) => setWhole(v === 'whole'), options: [{ value: 'secs', label: '分节' }, { value: 'whole', label: '整段' }] }),
                h('div', { className: 'ab-spacer' }),
                h('span', { className: 'ab-muted ab-small' }, Math.max(0, secs.length - (secs[0] && secs[0].title === null ? 1 : 0)) + ' 节 · ' + body.length + ' 字')),
              whole
                ? h('textarea', { className: 'ab-input', style: { width: '100%', minHeight: 340, marginTop: 10, fontFamily: 'monospace', fontSize: 12 }, value: body, onChange: (e) => { setSecs(splitGuide(e.target.value)); setGdirty(true) } })
                : h('div', { className: 'ab-psecs', style: { marginTop: 0 } },
                  secs.map((s, i) => h(GuideSection, {
                    key: s.k, sec: s, i, n: secs.length,
                    onChange: (p) => updSec(s.k, p), onMove: (dd) => moveSec(i, dd), onDelete: () => delSec(s),
                  })),
                  h('div', { className: 'ab-psec-add' },
                    h('span', { className: 'ab-muted ab-small' }, '加一节：'),
                    GSEC_SUGGEST.filter((t) => !secs.some((s) => s.title === t)).map((t) => h('button', { key: t, type: 'button', className: 'ab-chip', onClick: () => addSec(t) }, t)),
                    h('button', { type: 'button', className: 'ab-chip solid', onClick: () => addSec('') }, '＋ 自己起名'))),
              h('div', { className: 'ab-flex', style: { marginTop: 12 } },
                gdirty ? h('span', { className: 'ab-muted ab-small' }, '有改动还没保存') : null,
                h('div', { className: 'ab-spacer' }),
                btn('保存为自定义', saveGuide, 'saveguide'),
                btn('还原内置版', resetGuide, 'delguide')))
            : h(ui.Card, null, h(ui.Empty, { icon: '📄', text: '选一条指引，或点左边「＋ 新增指引」' })))),
  )
}
