// panel.js —— 逛电脑（Windows 自动化）的自定义面板（布局仿 phone 模块 panel.js）
// 拿到 React、h（React.createElement）、ui（面板自带组件）、call（调模块路由）
// 模块 settings 数组留空：所有设置由本面板接管（总开关挂在模块名同一行，仿 B 站页），
// 默认值在下面 DEFAULTS 里兜底（原生表单不再渲染，避免两套表单重复）。
// 布局：①逛电脑主卡（标题行=总开关；状态总览+运行安全设置+保存）→ ①¼ 红色「⚠️ 高权限风险提示」卡
//       → ①⅜ 元素定位（UIA）说明/开关卡（坐标点击 vs 读树定位）→ ② 操作白名单 → ③ 危险确认队列
//       → ④ 主流程总纲（独立卡，不可删）→ ⑤ Windows 自动化指引
//       （人格页式分节编辑：左列表右编辑，分节/整段来回切）。
const { useState, useEffect } = React

// 设置默认值（与 index.mjs getSettings() 的代码兜底一致，面板里也要显示出来而不是空白）
const DEFAULTS = {
  enabled: false, // 总开关：默认关
  opsWhitelist: '', // 操作白名单：一行一个操作 id，空 = 内置规则
  allowInput: false, // 键鼠模拟单独开关：默认关
  confirmDanger: true, // 危险操作确认门槛：默认开
  dryRun: false, // 试运行
  rateLimit: 60, // 每分钟操作上限
  powershellPath: '', // 留空 = System32 自动
  preferUia: true, // 优先用元素定位（读无障碍树按选择器操作），关了她会更爱点坐标
}

return function Panel({ settings, save, toast }) {
  const [busy, setBusy] = useState('') // 当前在跑的操作名（按钮转圈/禁用用）
  const [st, setSt] = useState(null) // /status 的状态总览
  const [opsList, setOpsList] = useState(null) // /ops 的操作目录（白名单「加入」用）
  const [confirms, setConfirms] = useState(null) // /confirm 的待确认队列

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
  const loadStatus = lock('status', async () => {
    const s = await call('/status')
    setSt(s)
    const c = await call('/confirm')
    if (c.ok) setConfirms(c.confirms || [])
  })
  useEffect(() => { loadStatus() }, [])

  // ---- 总开关：挂在卡片标题行，即切即存（同 B 站页/phone 的写法）----
  const masterOn = d.enabled === true
  const toggleMaster = lock('master', async () => {
    upd({ enabled: !masterOn })
    await save({ enabled: !masterOn })
    setDraft((p) => (p ? { ...p, enabled: !masterOn } : p))
    toast(!masterOn ? '总开关已打开，她可以操作这台电脑了' : '总开关已关，工具/命令全部停用', 'ok')
  })

  // ---- 保存设置：草稿里改过的全部字段一次落盘 ----
  const saveSettings = () => lock('savesettings', async () => {
    await save(d)
    setDraft(null)
    toast('设置已保存', 'ok')
  })

  // ---- 操作白名单：设置框 + 从操作目录里挑的助手同卡 ----
  const loadOps = lock('ops', async () => {
    const r = await call('/ops')
    if (!r.ok) return toast(r.error || '获取操作目录失败')
    setOpsList(r.ops || [])
  })
  const addWhitelist = (id) => lock('add:' + id, async () => {
    const cur = String(d.opsWhitelist || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    if (cur.includes(id)) return toast(id + ' 已在白名单里')
    const val = cur.concat(id).join('\n')
    upd({ opsWhitelist: val }); await save({ opsWhitelist: val })
    toast('已加入白名单：' + id)
  })

  // ---- 危险确认队列：列表 + 批准/拒绝，操作完刷新 ----
  const actConfirm = (id, approve) => lock('confirm:' + id, async () => {
    const r = await call('/confirm', approve ? { approve: true, id } : { reject: true, id })
    if (!r.ok) return toast(r.error || '操作失败')
    toast(approve ? '已批准，下一次同动作直接放行' : '已拒绝', 'ok')
    await loadStatus()
  })

  // ---- 指引提示词库：仿「人格」页的分节编辑（分节/整段来回切，保存仍是原来的一整段） ----
  // 节标记认两种写法：【标题】（文档首行）与「◆ 标题」（总则/操作套路/坑），拼回时保持原标记，旧指引不用改。
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
      const m = GSEC_HEAD.exec(line.replace(/[​-‍﻿]/g, '').trim())
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
  // ---- 主流程总纲（main）：独立卡编辑，不混进手册列表 ----
  const [mainSecs, setMainSecs] = useState(null) // null=未加载
  const [mainWhole, setMainWhole] = useState(false)
  const [mainDirty, setMainDirty] = useState(false)
  const mainGuide = (guides || []).find((g) => g.key === 'main') || null
  const opGuides = (guides || []).filter((g) => g.key !== 'main') // 手册列表不含总纲
  const pickGuide = (g) => { setGuideKey(g.key); setSecs(splitGuide(g.text || '')); setGdirty(false) }
  const loadGuides = async () => {
    const r = await call('/guides')
    const list = r.guides || []
    setGuides(list)
    setCreating(false)
    const m = list.find((g) => g.key === 'main')
    if (m && !mainDirty) setMainSecs(splitGuide(m.text || ''))
    if (!list.some((g) => g.key === guideKey) && list.length) pickGuide(list[0])
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
    setSecs(splitGuide('【' + name + ' · 操作手册】\n◆ 总则\n- \n\n◆ 操作套路\n- \n\n◆ 坑\n- '))
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

  // ---- 主流程总纲（main）：独立卡的编辑/保存/还原；删除入口不存在（内置总纲删不掉） ----
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

  // 面板 Btn 调 onClick 时不传参：这里吞掉事件、靠闭包传行数据（操作 id），不然 handler 收到 undefined。
  // handler 两种形态都兼容：预锁定的（loadStatus 等，调用即跑、返回 Promise）；
  // 工厂式的（addWhitelist(id) 等返回执行器函数）——返回的是函数就再调一次。
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
  // 操作目录里的风险标签
  const dangerBadge = (dg) => h('span', { className: 'ab-badge' + (dg === 'close' ? ' mine' : '') },
    dg === 'safe' ? '安全' : dg === 'input' ? '键鼠' : '危险')

  return h('div', null,

    // ===== ① 模块主卡：标题行 = 模块名 + 总开关，下面是状态总览 + 运行安全设置 + 保存 =====
    h(ui.Card, {
      title: '逛电脑（Windows 自动化）',
      right: h('span', { className: 'ab-flex', style: { gap: 8, alignItems: 'center' } },
        h('span', { className: 'ab-small ab-muted' }, '总开关'),
        h(ui.Switch, { on: masterOn, disabled: !!busy, title: '总开关', onChange: toggleMaster }),
        h('span', { className: 'ab-badge mine' }, 'windows-ops')),
      desc: '经 PowerShell 操作这台电脑：窗口枚举/激活/关闭、截屏、剪贴板读写、键鼠模拟，以及 UIA 元素定位（读无障碍树按选择器精确操作控件）。默认仅主人可用。'
        + (masterOn ? ' 总开关开着：AI 工具、/wops 命令都能操作这台电脑。' : ' 总开关关着：她碰不了这台电脑，工具/命令全部停用。'),
    },
    // 状态总览（只读，一键刷新）
    st === null
      ? h('div', { className: 'ab-small ab-muted', style: { marginBottom: 8 } }, '状态加载中…')
      : h('div', { style: { marginBottom: 12 } },
        stRow('平台', st.platform || '未知'),
        stRow('键鼠模拟', st.allowInput ? '开' : '关（键鼠类操作全被拦）'),
        stRow('待确认', (st.confirms || []).length + ' 条危险操作'),
        stRow('指引', (st.guides || []).length + ' 份（总纲常驻，手册按需取）'),
        stRow('操作目录', (st.ops || []).length + ' 个'),
        h('div', { className: 'ab-flex', style: { marginTop: 6 } }, btn('刷新状态', loadStatus, 'status'))),
    // 运行安全设置
    swRow('危险操作需确认', 'confirmDanger', '关窗口、键鼠动作先入队等主人批准（默认开；批准后一次性放行，10 分钟内有效）'),
    swRow('允许键鼠模拟', 'allowInput', '激活窗口/移动/点击/打字/按键这类动作型操作的总开关（默认关）'),
    swRow('试运行', 'dryRun', '只过闸门不出动作，用来安全地试配置（默认关）'),
    h(ui.Row, { label: '每分钟操作上限', hint: '每分钟最多执行的操作数，超了直接拒（默认 60，0 = 不限）' },
      h('input', { className: 'ab-input', style: { width: 100 }, type: 'number', min: 0, step: 10, value: d.rateLimit, onChange: (e) => upd({ rateLimit: e.target.value }) })),
    h(ui.Row, { label: 'PowerShell 路径', hint: '留空 = 自动用 System32 里的 powershell.exe' },
      h('input', { className: 'ab-input', style: { width: 320 }, value: d.powershellPath || '', placeholder: '（自动）', onChange: (e) => upd({ powershellPath: e.target.value }) })),
    // 保存行
    h('div', { className: 'ab-flex', style: { marginTop: 12 } },
      dirty ? h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, '有改动还没保存') : null,
      h('div', { className: 'ab-spacer' }),
      btn('💾 保存设置', saveSettings, 'savesettings', true))),

    // ===== ①¼ 高权限风险提示（红色突出，紧跟主卡）=====
    h('div', { style: { margin: '0 0 12px', padding: '10px 12px', border: '1px solid #e5484d', borderRadius: 8, background: 'rgba(229,72,77,.08)' } },
      h('div', { style: { color: '#e5484d', fontWeight: 700, fontSize: 13 } }, '⚠️ 高权限风险提示'),
      h('div', { className: 'ab-small', style: { color: '#e5484d', marginTop: 4, lineHeight: 1.6 } },
        '本模块可模拟键鼠、关闭窗口、读写剪贴板、截取全屏——等同于把这台电脑交给 AI 远程控制：她能代你点击任何界面（包括聊天窗口和支付页面）、能读到剪贴板里的密码与验证码、能截走屏幕上的隐私内容。'
        + '缓解措施：总开关默认关、键鼠模拟单独开关、操作白名单、危险操作确认队列、试运行模式、每分钟限速，且工具只在主人会话放行。'
        + '请只在本人可信设备上开启；不用时把总开关关上，并留意下面的「待确认」列表，防止误批准。')),

    // ===== ①⅜ 元素定位（UIA）：坐标点击 vs 读无障碍树按选择器操作，默认优先后者 =====
    // 放在高权限风险提示之后、白名单之前：先让主人知道「动」有风险，再告诉他「动」有两种动法。
    h(ui.Card, { title: '元素定位（UIA）', desc: '同样是点按钮/填输入框，有两种动法：点坐标（告诉她屏幕第几个像素）与元素定位（读无障碍树，告诉她「那个叫提交的按钮」）。读树那套更稳，所以默认优先用它，坐标只在读不到树时兜底。' },
      swRow('优先用元素定位', 'preferUia', '默认开：把「能读无障碍树就别猜坐标」这条偏好记进设置（preferUia），她按总纲第一原则先读树再操作；关掉表示你更愿意让她直接点坐标（读不到树的界面本来就走坐标兜底）'),
      h('div', { className: 'ab-small', style: { marginTop: 10, lineHeight: 1.85 } },
        h('b', null, '· 坐标点击（mouse.move / mouse.click）'),
        h('div', { className: 'ab-muted' },
          '指定屏幕像素坐标再点：简单、什么界面都能点，但窗口一挪、一改大小、换个主题或屏幕缩放变了就全点偏；'
          + '而且她并不知道自己点到了什么，只能靠截图猜。'),
        h('b', { style: { display: 'block', marginTop: 8 } }, '· 元素定位（uia.tree / uia.click / uia.setValue / uia.getText / uia.invoke）'),
        h('div', { className: 'ab-muted' },
          '先读目标窗口的无障碍树（每个控件的类型、名字、AutomationId、位置都在清单里），再用选择器点名操作某个元素：'
          + '窗口挪动、改大小、换主题/DPI 都不影响；填输入框走 setValue 直接写控件值，不受中文输入法影响。'
          + '读不到树的界面（Canvas、游戏、自绘框架）才退回坐标兜底。')),
      // 选择器写法示例（等宽字体，照抄改关键字即可）
      h('div', { className: 'ab-small', style: { marginTop: 12 } },
        h('b', null, '选择器怎么写'),
        h('div', { className: 'ab-muted', style: { marginTop: 2 } },
          '参数 sel，格式「键=值」，多个条件用 && 连起来（全部满足才算命中）。可用的键四个：'
          + 'AutomationId / Name / ControlType / ClassName；值按前缀匹配，不支持通配符。'),
        h('pre', { style: { fontFamily: 'monospace', fontSize: 12, background: 'var(--ab-bg, rgba(127,127,127,.08))', padding: '8px 10px', borderRadius: 6, margin: '8px 0 0', whiteSpace: 'pre', overflowX: 'auto' } },
          'AutomationId=submitBtn                    // 最稳：程序员给的唯一标识\n'
          + 'Name=提交                                  // 用户看得见的文字\n'
          + 'Name=提交&&ControlType=Button              // 多个条件一起钉死\n'
          + 'ControlType=Edit&&AutomationId=username    // 输入框常见写法'),
        h('div', { className: 'ab-muted', style: { marginTop: 8, lineHeight: 1.8 } },
          '挑条件的顺序：AutomationId 优先；没有就 Name（目标程序界面上的原文）；再不行 ControlType + ClassName 组合。'
          + '每次操作都要带上 pid（目标窗口进程号，先 window.list 认准），元素不跨调用有效，别指望上一步找到的元素这一步还在。'))),

    // ===== ② 操作白名单：设置框 + 从操作目录里挑的助手同卡 =====
    h(ui.Card, { title: '操作白名单', desc: '管住她只能用哪些操作，一行一个操作 id，空 = 按内置规则放行（安全操作直接放行，键鼠类还要开上面的开关，危险类还要过确认门）。点「获取操作目录」挑着加，点「加入」直接追加落盘；也可以手填，改完点上面的「保存设置」。' },
      h('textarea', {
        className: 'ab-textarea', rows: 5, style: { width: '100%', fontFamily: 'monospace', fontSize: 12 },
        placeholder: 'clipboard.read\nscreenshot\nwindow.list', value: d.opsWhitelist, onChange: (e) => upd({ opsWhitelist: e.target.value }),
      }),
      h('div', { className: 'ab-flex', style: { marginTop: 10 } }, btn('获取操作目录', loadOps, 'ops')),
      opsList ? h('div', { style: { marginTop: 8, maxHeight: 320, overflowY: 'auto' } },
        opsList.map((o) => h('div', {
          key: o.id,
          style: { display: 'flex', gap: 8, alignItems: 'center', padding: '7px 4px', borderBottom: '1px solid var(--ab-line)' },
        },
        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          h('span', { style: { fontFamily: 'monospace', fontSize: 12 } }, o.id),
          h('span', { className: 'ab-muted ab-small', style: { marginLeft: 8 } }, o.label)),
        dangerBadge(o.danger),
        btn('加入', () => addWhitelist(o.id), 'add:' + o.id)))) : null),

    // ===== ③ 危险确认队列：先入队等主人批准，批准后一次性放行 =====
    h(ui.Card, { title: '危险确认队列', desc: '开「危险操作需确认」时，关窗口、键鼠动作第一次执行只进这个队列，不真动。批准后放行一次同动作（10 分钟内有效），过时作废。也能在 QQ 里发 /wops confirm 批准|拒绝 <尾号>。' },
      confirms === null
        ? h('span', { className: 'ab-muted ab-small' }, '加载中…')
        : confirms.length
          ? confirms.map((c) => h('div', {
            key: c.id,
            style: { display: 'flex', gap: 8, alignItems: 'center', padding: '7px 4px', borderBottom: '1px solid var(--ab-line)' },
          },
          h('span', { style: { flex: 1, minWidth: 0 } },
            h('span', { style: { fontFamily: 'monospace', fontSize: 12 } }, c.op),
            h('span', { className: 'ab-muted ab-small', style: { marginLeft: 8 } }, c.summary + ' · 尾号 ' + c.id + ' · ' + new Date(c.at).toLocaleTimeString())),
          btn('批准', () => actConfirm(c.id, true), 'approve:' + c.id),
          btn('拒绝', () => actConfirm(c.id, false), 'reject:' + c.id)))
          : h('div', { className: 'ab-small ab-muted' }, '没有待确认的危险操作。')),

    // ===== ④ 主流程总纲（独立于操作手册；主人让动电脑时的总章程，不可删除只能还原） =====
    h(ui.Card, { title: '主流程总纲', desc: '主人让她动电脑时，总纲常驻注入（经规则进她的每轮思考）：整体怎么排任务、安全红线怎么守。它独立于下面的单类手册，手册由她按当前操作用 windows_ops_guide 工具按需取，两边一起看，总纲优先。只能编辑和还原内置版，不能删除。' },
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

    // ===== ⑤ Windows 自动化指引（单类手册：左列表右编辑，人格页式分节） =====
    h(ui.Card, { title: 'Windows 自动化指引', desc: '教她怎么稳妥地用某类操作（元素定位/键鼠/窗口/剪贴板/截屏）。她按当前操作用 windows_ops_guide 工具按需取对应手册（uia.* 取「元素定位」那份），总纲在上面单独一张卡。左边选手册，右边像人格页那样一节一个框地改（也能切「整段」）；自定义条目可删除（要过两道确认），内置条目只能还原。' },
      h('div', { className: 'ab-persona' },
        // 左列：所有手册（内置 + 自定义，不含总纲）＋ 新增入口，仿人格页的列表
        h('div', { className: 'ab-plist' },
          guides === null ? h('div', { className: 'ab-muted ab-small' }, '加载中…') : null,
          opGuides.map((g) => h('div', { key: g.key, style: { display: 'flex', gap: 4, alignItems: 'stretch' } },
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
        // 右列：选中的分节/整段编辑，或新增指引的建卡页
        creating
          ? h(ui.Card, { title: '新增指引', desc: 'key 用于存盘，也留给你显式指定；名字显示在左边列表。' },
            h(ui.Row, { label: 'key', hint: '小写字母/数字/短横线，2~40 字' }, h('input', { className: 'ab-input', value: newKey, placeholder: 'my-op-guide', onChange: (e) => setNewKey(e.target.value) })),
            h(ui.Row, { label: '名字' }, h('input', { className: 'ab-input', value: newName, placeholder: '如：某软件专属套路', onChange: (e) => setNewName(e.target.value) })),
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
            : h(ui.Card, null, h(ui.Empty, { icon: '📄', text: '选一份手册，或点左边「＋ 新增指引」' })))),
  )
}
