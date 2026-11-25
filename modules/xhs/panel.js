// panel.js —— 刷小红书的自定义面板（v3：四卡分区布局）
// 拿到 React、h（React.createElement）、ui（Card/Btn/Switch/Row/Empty/Select/Seg/Range，见 client.js ExtPanel）、
// call（GET=call(p)，POST=call(p, body)，打模块路由 /ext/xhs/*）。组件 props：{ settings, save, toast, ... }。
// 模块 settings 数组仍留在 index.mjs（没面板的环境兜底 + 检查脚本用）；本面板接管全部表单。
// 布局（Lead 钉版）：①设置（五组小节+共用保存，放最上）→ ②总览（仪表网格+警示行+四个等宽按钮）→一个保存）
// → ③登录与身份（三块并排）→ ④产物（Seg Tab：截图库 / 发帖草稿 / 运行记录）。
// 即存项口径不变：总开关 / dryRun / browserPath / ownerInput 四个即存，其余进草稿点「保存设置」一次落盘。
const { useState, useEffect } = React

// 设置默认值（与 index.mjs defaults 一致；未设置/为空的项在面板里显示兜底值而不是空白）
const DEFAULTS = {
  enabled: false,
  dryRun: false,
  browserPath: '',
  perRun: 5,
  dwellMin: 8,
  dwellMax: 25,
  maxWatchPerDay: 40,
  maxRunsPerDay: 4,
  intervalHours: 4,
  likeEnabled: true,
  collectEnabled: true,
  commentEnabled: true,
  shareEnabled: true,
  dmEnabled: true,
  publishEnabled: false,
  capLike: 20,
  capCollect: 10,
  capComment: 3,
  capShare: 5,
  capPublish: 1,
  minWriteGapSec: 90,
  newAccountDays: 3,
  shareTo: 'qq',
  dmPollMinutes: 7,
  ownerInput: '',
  keywords: '',           // 关键词巡游：每行一个；空=只刷推荐
  visionEnabled: false,   // 视觉看图：默认关
  shotChance: 0.3,        // 看过的图存截图库概率
  atOwnerEnabled: false,  // 评论里真·@主人：默认关
  capAtOwner: 3,
  replyEnabled: false,    // 回复笔记下的新评论：默认关
  capReply: 5,
  replyPollMinutes: 30,
  shotLibrary: 30,
}

// 运行记录的动作名（state().history[].kind → 人话）
const KIND = {
  watch: '看了', like: '点赞', collect: '收藏', comment: '评论', share: '分享给你', publish: '发布了',
  dm: '私信里回', 'dm-out': '主动私信', reply: '回评论', at: '@了你', error: '没成功',
}
const kindLabel = (k) => String(k || '').startsWith('dry:') ? '试运行·' + (KIND[String(k).slice(4)] || String(k).slice(4)) : (KIND[k] || k)

// 下一轮的倒计时人话（面板每分钟会随刷新状态更新）
const countdown = (ts) => {
  if (!ts) return '未排'
  const ms = ts - Date.now()
  if (ms <= 0) return '到点了'
  const m = Math.round(ms / 60_000)
  return m >= 60 ? (Math.round(m / 60) + ' 小时后') : (m + ' 分后')
}

return function Panel({ settings, save, toast }) {
  const [busy, setBusy] = useState('') // 当前在跑的操作名（按钮转圈/禁用用）
  const [st, setSt] = useState(null) // /state 的状态总览（含 history）
  const [drafts, setDrafts] = useState(null) // /drafts 的待确认草稿
  const [shot, setShot] = useState('') // 登录二维码截图（data:image/png;base64）
  const [ownerInputBox, setOwnerInputBox] = useState('') // 主人核对输入框（独立于设置里的 ownerInput）
  const [shots, setShots] = useState(null) // 截图库（/shots）
  const [vision, setVision] = useState(null) // /vision/state：她现在能不能看图
  const [tab, setTab] = useState('shots') // 卡④产物 Tab：shots / drafts / history

  // ---- 编辑草稿：改了先存本地，点「保存设置」一次落盘；null = 与已存值一致（不脏）----
  const [draft, setDraft] = useState(null)
  const d = { ...DEFAULTS, ...(settings || {}), ...(draft || {}) } // 未设置/为空的项显示 DEFAULTS 兜底
  const upd = (patch) => setDraft({ ...(draft || {}), ...patch })
  const dirty = draft !== null

  const lock = (name, fn) => async (...args) => {
    if (busy) return
    setBusy(name)
    try { return await fn(...args) } catch (e) { toast('出错了：' + (e.message || e)) }
    finally { setBusy('') }
  }

  const loadState = lock('state', async () => { setSt(await call('/state')) })
  const loadDrafts = lock('drafts', async () => {
    const r = await call('/drafts')
    setDrafts(r.drafts || [])
  })
  const loadShotsList = lock('shotslist', async () => {
    const r = await call('/shots')
    setShots(r.shots || [])
  })
  const loadVision = lock('vision', async () => { setVision(await call('/vision/state')) })
  useEffect(() => { loadState(); loadDrafts(); loadShotsList(); loadVision() }, [])

  // ---- 即存项（口径不变）：总开关 / 试运行 / browserPath / ownerInput ----
  const masterOn = d.enabled === true
  const toggleMaster = lock('master', async () => {
    upd({ enabled: !masterOn })
    await save({ enabled: !masterOn })
    setDraft((p) => (p ? { ...p, enabled: !masterOn } : p))
    toast(!masterOn ? '总开关已打开，她可以刷小红书了' : '总开关已关，刷小红书全部停用', 'ok')
  })
  const toggleDry = lock('dry', async () => {
    upd({ dryRun: d.dryRun !== true })
    await save({ dryRun: d.dryRun !== true })
    setDraft((p) => (p ? { ...p, dryRun: d.dryRun !== true } : p))
    toast(d.dryRun !== true ? '试运行已开：只记录「本来要做什么」，不真动手' : '试运行已关：会真的点赞评论发帖', 'ok')
  })
  const saveOne = (key, value, label) => lock('save:' + key, async () => {
    upd({ [key]: value })
    await save({ [key]: value })
    setDraft((p) => (p ? { ...p, [key]: value } : p))
    toast((label || key) + '已保存', 'ok')
  })

  // ---- 保存设置：草稿里改过的全部字段一次落盘（卡②共用）----
  const saveSettings = () => lock('savesettings', async () => {
    await save(d)
    setDraft(null)
    toast('设置已保存', 'ok')
  })

  // 面板 Btn 调 onClick 不传参：吞掉事件、靠闭包传参；返回执行器函数就再调一次（照 phone 面板的坑）
  const btn = (label, onClick, key, primary) => h(ui.Btn, {
    key, kind: primary ? 'primary' : undefined, disabled: !!busy,
    onClick: async () => { const r = onClick(); if (typeof r === 'function') await r() },
  }, busy === key ? '处理中…' : label)

  // ---- 操作（总览卡的一排按钮）----
  const doRun = lock('run', async () => {
    if (!masterOn) return toast('总开关没开：先到上面把总开关打开')
    const r = await call('/run')
    toast(r.ok === false ? (r.message || '没刷成') : '开始刷了，一会儿看「运行记录」', r.ok === false ? undefined : 'ok')
    setTimeout(() => { loadState(); loadDrafts() }, 3000)
  })
  const doDms = lock('dms', async () => {
    const r = await call('/dms')
    if (r.ok === false) return toast(r.message || '没看成')
    toast(r.replied ? '看过了，回了 ' + r.replied + ' 条' : (r.message || '看过了，没有要回的'), 'ok')
    await loadState()
  })
  const doReplies = lock('replies', async () => {
    const r = await call('/replies/run')
    if (r.ok === false) return toast(r.message || '没看成')
    toast(r.replied ? '回完了：回了 ' + r.replied + ' 条评论' : (r.message || '看过了，没有要回的'), 'ok')
    await loadState()
  })

  // ---- 登录与身份 ----
  const doLogin = lock('login', async () => {
    const r = await call('/login', {})
    if (!r.ok) return toast(r.message || r.error || '登录失败')
    if (r.loggedIn) { setShot(''); toast('已登录：' + (r.message || ''), 'ok'); await loadState(); return }
    setShot(r.shot || '')
    toast(r.shot ? '二维码出来了，用小红书 App 扫一下' : '没拿到二维码，点「显示浏览器窗口」直接在窗口里扫')
  })
  const pollLogin = lock('poll', async () => {
    const r = await call('/login/status')
    if (r.ok && r.loggedIn) { setShot(''); toast('登录好了：' + (r.message || ''), 'ok'); await loadState(); return }
    toast(r.shot ? '还没扫上，二维码在旁边（扫完再点一次）' : '还没登录')
    if (r.shot) setShot(r.shot)
  })
  const doWindow = (visible) => lock('window:' + visible, async () => {
    const r = await call('/window', { visible })
    toast(r.ok === false ? (r.message || '没成功') : (r.message || (visible ? '窗口挪到屏幕上了' : '窗口收起来了')), r.ok === false ? undefined : 'ok')
  })
  const doConfirmOwner = lock('confirmowner', async () => {
    const input = ownerInputBox.trim() || String(d.ownerInput || '').trim()
    if (!input) return toast('先填主人的小红书主页链接或 userId')
    const r = await call('/confirm-owner', { input })
    if (!r.ok) return toast(r.message || '没核对上')
    toast('核对好了：' + (r.owner?.nickname || r.owner?.userId || ''), 'ok')
    await loadState()
  })

  // ---- 产物卡：草稿 / 截图 ----
  const doDraft = (id, reject) => lock('draft:' + id + ':' + reject, async () => {
    const r = await call(reject ? '/draft/reject' : '/draft/confirm', { id })
    if (!r.ok) return toast(r.message || '没成功')
    toast(reject ? '已驳回这篇草稿' : '发布成功：' + (r.message || ''), 'ok')
    await Promise.all([loadDrafts(), loadState()])
  })
  const delShot = (file) => lock('delshot:' + file, async () => {
    if (!confirm('删掉这张截图？删除后不可恢复。')) return
    const r = await call('/shot/delete', { file })
    if (!r.ok) return toast(r.message || '没删成')
    toast('已删除', 'ok')
    await Promise.all([loadShotsList(), loadState()])
  })

  // ---- 卡②的小节标题与紧凑行 ----
  const secTitle = (t, hint) => h('div', { className: 'ab-small ab-muted', style: { fontWeight: 600, margin: '10px 0 2px' } },
    t, hint ? h('span', { style: { fontWeight: 400, marginLeft: 8 } }, hint) : null)
  // 开关行（进草稿）
  const swRow = (label, key, hint) => h(ui.Row, { label, hint },
    h(ui.Switch, { on: d[key] === true, disabled: !!busy, title: label, onChange: () => upd({ [key]: d[key] !== true }) }))
  // 滑块行（label 左、Range 固定宽、当前值在右；进草稿）
  const sliderRow = (label, key, { min, max, step, unit, hint }) => h(ui.Row, { label, hint: hint || '默认 ' + DEFAULTS[key] + (unit || '') },
    h('div', { style: { width: 260 } },
      h(ui.Range, {
        min, max, step: step || 1,
        value: Number(d[key] ?? DEFAULTS[key]) || 0,
        onChange: (v) => upd({ [key]: v }),
        fmt: (v) => v + (unit || ''),
      })))
  // 文本框行（即存项用：改完点该项「保存」）
  const saveInputRow = (label, key, { placeholder, hint, okLabel }) => h(ui.Row, { label, hint },
    h('div', { className: 'ab-flex', style: { gap: 8, width: '100%' } },
      h('input', {
        className: 'ab-input', style: { flex: '1 1 240px' },
        placeholder: placeholder || ('默认：' + (DEFAULTS[key] === '' ? '（空）' : DEFAULTS[key])),
        value: d[key] ?? '',
        onChange: (e) => upd({ [key]: e.target.value }),
      }),
      h(ui.Btn, { disabled: !!busy, onClick: saveOne(key, String(d[key] ?? ''), okLabel || label) }, busy === 'save:' + key ? '处理中…' : '保存')))

  const caps = st?.caps || {}
  const acc = st?.account || {}
  const visionText = vision === null ? '…' : (vision.usable ? '能看图' : (d.visionEnabled ? '模型不支持' : '关'))

  // ---- 仪表格的一格：数值大字 + 标签小字 ----
  const gauge = (value, label, sub) => h('div', {
    style: { border: '1px solid var(--ab-line)', borderRadius: 8, padding: '6px 10px', minWidth: 0 },
  },
    h('div', { style: { fontWeight: 600, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, value),
    h('div', { className: 'ab-small ab-muted', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
      label + (sub ? ' · ' + sub : '')))

  // ---- 记录行 ----
  const histRow = (x, i) => h('div', {
    key: i, style: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 2px', borderBottom: '1px solid var(--ab-line)' },
  },
    h('span', { className: 'ab-muted ab-small', style: { flex: '0 0 128px', fontFamily: 'ui-monospace, Consolas, monospace' } }, x.at ? new Date(x.at).toLocaleString() : ''),
    h('span', { className: 'ab-badge', style: { flex: '0 0 auto' } }, kindLabel(x.kind)),
    h('span', { className: 'ab-small', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      (x.title ? '《' + x.title + '》' : '') + (x.text || '')))

  return h('div', null,

    // ===== ① 登录与身份：三块并排 + browserPath 收尾（没登录一切免谈，放最前） =====
    h(ui.Card, { title: '登录与身份', desc: '第一次用先「扫码登录」（小红书 App 扫，网页版登录一次就一直用）；要过验证码时「显示窗口」。主人的小红书号核对过，她才认你的私信、才让你确认发帖。' },
      h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' } },
        // 块1：扫码登录
        h('div', { style: { flex: '1 1 200px', minWidth: 0 } },
          h('div', { className: 'ab-small', style: { fontWeight: 600, marginBottom: 6 } }, '扫码登录'),
          h('div', { className: 'ab-flex', style: { gap: 8, flexWrap: 'wrap' } },
            btn('扫码登录', doLogin, 'login', true),
            btn('刷新登录状态', pollLogin, 'poll')),
          shot ? h('img', { src: shot, alt: '登录二维码', title: '用小红书 App 扫这个码', style: { width: 128, height: 128, marginTop: 8, border: '1px solid var(--ab-line)', borderRadius: 8 } }) : null,
          h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, acc.loggedIn ? '已登录' + (acc.nickname ? '：' + acc.nickname : '') : '未登录')),
        // 块2：浏览器窗口
        h('div', { style: { flex: '1 1 160px', minWidth: 0 } },
          h('div', { className: 'ab-small', style: { fontWeight: 600, marginBottom: 6 } }, '浏览器窗口',
            st?.browserOpen ? h('span', { className: 'ab-badge', style: { marginLeft: 8 } }, '开着') : null),
          h('div', { className: 'ab-flex', style: { gap: 8, flexWrap: 'wrap' } },
            btn('显示窗口', () => doWindow(true), 'win1'),
            btn('收起窗口', () => doWindow(false), 'win0')),
          h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '验证码常常只在窗口里能看到，过验证时点「显示窗口」')),
        // 块3：主人核对
        h('div', { style: { flex: '1 1 260px', minWidth: 0 } },
          h('div', { className: 'ab-small', style: { fontWeight: 600, marginBottom: 6 } }, '主人的小红书号',
            st?.owner ? h('span', { className: 'ab-badge', style: { marginLeft: 8, background: 'rgba(79,154,140,.15)', color: '#4f9a8c', fontWeight: 600 } }, '已核对：' + (st.owner.nickname || st.owner.userId)) : h('span', { className: 'ab-badge', style: { marginLeft: 8 } }, '未核对')),
          saveInputRow('小红书号（设置）', 'ownerInput', { placeholder: '主页链接或 24 位 userId；改了要重新核对', okLabel: '主人的小红书号' }),
          h(ui.Row, { label: '当场核对', hint: '填主人自己主页的链接或 userId，查到人就记下来；只认核对过的输入' },
            h('div', { className: 'ab-flex', style: { gap: 8, width: '100%' } },
              h('input', { className: 'ab-input', style: { flex: '1 1 180px' }, placeholder: '和上面填一样的就行', value: ownerInputBox, onChange: (e) => setOwnerInputBox(e.target.value) }),
              btn('✔ 核对', doConfirmOwner, 'confirmowner', true))))),
      // browserPath 收成最后一行小字输入框（即存）
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' } },
        h('span', { style: { flex: '0 0 auto' } }, '浏览器路径'),
        h('input', {
          className: 'ab-input', style: { flex: 1, fontFamily: 'monospace', fontSize: 12 },
          placeholder: '留空自动找 Edge/Chrome（登录态在数据目录 xhs/edge-profile，别动）',
          value: d.browserPath ?? '', onChange: (e) => upd({ browserPath: e.target.value }),
        }),
        h(ui.Btn, { small: true, disabled: !!busy, onClick: saveOne('browserPath', String(d.browserPath ?? ''), '浏览器路径') }, busy === 'save:browserPath' ? '处理中…' : '保存'))),

    // ===== ② 设置：五组小节 + 共用一个保存 =====
    h(ui.Card, {
      title: '设置',
      desc: '滑块拖好点底部「保存设置」一次落盘；没动过的项显示默认值。总开关 / 试运行 / 浏览器路径 / 主人小红书号是即存项，不在这张卡里。',
    },
      secTitle('巡游'),
      sliderRow('每次几篇', 'perRun', { min: 1, max: 20, unit: ' 篇' }),
      sliderRow('停留（最少）', 'dwellMin', { min: 3, max: 120, unit: ' 秒', hint: '停留太短容易被风控；默认 8 秒' }),
      sliderRow('停留（最多）', 'dwellMax', { min: 5, max: 300, unit: ' 秒', hint: '要 ≥ 最少停留；默认 25 秒' }),
      sliderRow('两轮间隔', 'intervalHours', { min: 0.5, max: 24, step: 0.5, unit: ' 小时' }),
      h(ui.Row, { label: '关键词巡游', hint: '每行一个；空=只刷推荐。非空时隔一轮搜一个（猫→狗→猫…交替），搜索轮的安全闸与推荐轮完全一样' },
        h('textarea', { className: 'ab-textarea', rows: 3, style: { width: '100%' }, placeholder: '猫\n收纳\n旅行', value: d.keywords ?? '', onChange: (e) => upd({ keywords: e.target.value }) })),
      secTitle('互动能力'),
      swRow('允许点赞', 'likeEnabled', '默认开'),
      swRow('允许收藏', 'collectEnabled', '默认开'),
      swRow('允许评论', 'commentEnabled', '默认开。评论是她用自己人格现想的'),
      swRow('允许分享给主人', 'shareEnabled', '默认开'),
      swRow('允许看主人私信并回', 'dmEnabled', '默认开。要先在「登录与身份」卡核对主人的小红书号'),
      swRow('允许发帖', 'publishEnabled', '默认关。开了也只能存草稿，主人在「产物 → 发帖草稿」确认后才真的发'),
      swRow('看笔记配图（视觉）', 'visionEnabled', '默认关。下载配图给模型看，画面描述写进她的观感；全局模型要支持图片，整轮最多看 3 篇防慢'),
      sliderRow('每天点赞上限', 'capLike', { min: 0, max: 100 }),
      sliderRow('每天收藏上限', 'capCollect', { min: 0, max: 100 }),
      sliderRow('每天评论上限', 'capComment', { min: 0, max: 30 }),
      sliderRow('每天分享上限', 'capShare', { min: 0, max: 30 }),
      sliderRow('每天发帖上限', 'capPublish', { min: 0, max: 10 }),
      h(ui.Row, { label: '分享渠道', hint: 'qq=QQ 私聊（她的话+链接）/ dm=站内私信笔记卡片 / both=两边都发；站内失败自动回落 QQ' },
        h(ui.Select, {
          width: 220, value: d.shareTo || 'qq',
          options: [{ value: 'qq', label: 'QQ 私聊' }, { value: 'dm', label: '站内私信笔记卡片' }, { value: 'both', label: '两边都发' }],
          onChange: (v) => upd({ shareTo: v }),
        })),
      secTitle('@主人与回评'),
      swRow('评论里真·@主人', 'atOwnerEnabled', '默认关。只认「核对」写进来的主人号（改配置绕不过）；@ 的笔记主人会收到小红书通知'),
      sliderRow('每天 @ 主人上限', 'capAtOwner', { min: 0, max: 10, hint: '默认 3。@ 太频繁容易招人烦也容易被风控' }),
      swRow('回复笔记下的新评论', 'replyEnabled', '默认关。第一次只记不回，之后挑新评论用她的人格回'),
      sliderRow('每天回评论上限', 'capReply', { min: 0, max: 20 }),
      sliderRow('看新评论间隔', 'replyPollMinutes', { min: 5, max: 120, unit: ' 分钟' }),
      secTitle('节奏与保护'),
      sliderRow('写操作最小间隔', 'minWriteGapSec', { min: 0, max: 600, unit: ' 秒', hint: '两次赞/藏/评/发之间至少隔这么久；默认 90 秒' }),
      sliderRow('新号保护', 'newAccountDays', { min: 0, max: 30, unit: ' 天', hint: '刚登录这几天写上限减半；默认 3 天' }),
      sliderRow('看私信间隔', 'dmPollMinutes', { min: 1, max: 120, unit: ' 分钟' }),
      sliderRow('每天最多看', 'maxWatchPerDay', { min: 1, max: 200, unit: ' 篇' }),
      sliderRow('每天最多自动刷', 'maxRunsPerDay', { min: 0, max: 20, unit: ' 轮', hint: '0 = 不自动刷，只能手动点「去刷一轮」' }),
      secTitle('视觉与截图'),
      sliderRow('存截图库概率', 'shotChance', { min: 0, max: 1, step: 0.05, hint: '看过的图按这个概率存进截图库（主人之后可以叫她发一张）；默认 0.3' }),
      sliderRow('截图库最多留', 'shotLibrary', { min: 5, max: 100, unit: ' 张', hint: '超了删最旧；默认 30 张' }),
      h('div', { className: 'ab-flex', style: { marginTop: 14 } },
        dirty ? h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, '有改动还没保存') : null,
        h('div', { className: 'ab-spacer' }),
        btn('💾 保存设置', saveSettings, 'savesettings', true))),
    // ===== ③ 总览：标题行=总开关+试运行；仪表网格 + 警示行 + 四个等宽按钮 =====
    h(ui.Card, {
      title: '刷小红书',
      right: h('span', { className: 'ab-flex', style: { gap: 10, alignItems: 'center' } },
        h('span', { className: 'ab-small ab-muted' }, '试运行'),
        h(ui.Switch, { on: d.dryRun === true, disabled: !!busy, title: '试运行（只记录不真动手）', onChange: toggleDry }),
        h('span', { className: 'ab-small ab-muted' }, '总开关'),
        h(ui.Switch, { on: masterOn, disabled: !!busy, title: '总开关', onChange: toggleMaster }),
        h('span', { className: 'ab-badge mine' }, 'xhs')),
      desc: masterOn ? '总开关开着：她按下面的节奏刷小红书、互动、看私信。' : '总开关关着：刷、赞、评、私信、发帖全部停用（登录不受影响）。',
    },
    st === null
      ? h('div', { className: 'ab-small ab-muted', style: { marginBottom: 8 } }, '状态加载中…')
      : h('div', null,
        // 仪表网格：两行三列
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 } },
          gauge(acc.loggedIn ? '已登录' : '未登录', '登录', acc.nickname || ''),
          gauge(`${caps.like != null ? Math.max(0, caps.like - (st.like || 0)) : '-'} / ${Math.max(0, caps.collect != null ? caps.collect - (st.collect || 0) : 0)} / ${Math.max(0, caps.comment != null ? caps.comment - (st.comment || 0) : 0)} / ${caps.replyLeft ?? '-'}`,
            '今日余量 赞/藏/评/回', `已看 ${st.watched || 0} 篇`),
          gauge(visionText, '看图', d.visionEnabled ? (vision?.usable ? '' : '全局模型要支持图片') : '开关关'),
          gauge(st.busy ? '正在刷' : countdown(st.nextDueAt), '下一轮', st.lastRun ? '上轮 ' + new Date(st.lastRun).toLocaleTimeString() : ''),
          gauge(String(st.shots != null ? st.shots : '…'), '截图库存', `留 ${d.shotLibrary} 张上限`),
          gauge(String(drafts ? drafts.length : (st.pendingDrafts || 0)), '待确认草稿', '发布需主人确认')),
        // 警示行：只在有值时占位
        st.pauseReason ? h('div', { style: { margin: '0 0 6px' } },
          h('span', { className: 'ab-badge', style: { background: 'rgba(229,72,77,.15)', color: '#e5484d', fontWeight: 600 } },
            '⚠️ 今天停手：' + st.pauseReason + '（明天自动恢复，手机上处理完验证可点「刷新」）')) : null,
        !st.pauseReason && st.lastSkipReason ? h('div', { style: { margin: '0 0 6px' } },
          h('span', { className: 'ab-badge' }, '上次跳过：' + st.lastSkipReason)) : null,
        st.newAccount ? h('div', { style: { margin: '0 0 6px' } },
          h('span', { className: 'ab-badge' }, `新号保护：登录不满 ${d.newAccountDays} 天，写上限自动减半`)) : null,
        // 按钮排：等宽四个
        h('div', { style: { display: 'flex', gap: 8 } },
          btn('▶ 去刷一轮', doRun, 'run', true),
          btn('看私信', doDms, 'dms'),
          btn('回新评论', doReplies, 'replies'),
          btn('刷新', loadState, 'state')))),



    // ===== ④ 产物：Seg Tab（截图库 / 发帖草稿 / 运行记录）=====
    h(ui.Card, { title: '产物', desc: '她刷小红书留下的东西都在这张卡里：截图、等确认的草稿、运行记录。' },
      h('div', { className: 'ab-flex', style: { gap: 10, alignItems: 'center', marginBottom: 10 } },
        h(ui.Seg, {
          value: tab,
          options: [
            { value: 'shots', label: '截图库' + (shots && shots.length ? ' (' + shots.length + ')' : '') },
            { value: 'drafts', label: '发帖草稿' + (drafts && drafts.length ? ' (' + drafts.length + ')' : '') },
            { value: 'history', label: '运行记录' },
          ],
          onChange: (v) => setTab(v),
        }),
        tab === 'drafts' ? h('span', { className: 'ab-badge', style: { background: 'rgba(229,72,77,.15)', color: '#e5484d', fontWeight: 700 } }, '发布需主人确认') : null),
      tab === 'shots'
        ? (shots === null
          ? h('div', { className: 'ab-small ab-muted' }, '截图库加载中…')
          : shots.length
            ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 } },
              shots.map((x) => h('div', {
                key: x.file, style: { position: 'relative', border: '1px solid var(--ab-line)', borderRadius: 8, padding: 6, overflow: 'hidden' },
              },
                x.src ? h('img', { src: x.src, alt: x.title || '截图', title: (x.note || x.title || '') + (x.at ? '（' + new Date(x.at).toLocaleString() + '）' : ''), style: { width: '100%', height: 100, objectFit: 'cover', borderRadius: 6, display: 'block' } }) : null,
                h('div', { className: 'ab-small', style: { marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '《' + (x.title || '无标题') + '》'),
                h('div', { className: 'ab-flex', style: { gap: 6, alignItems: 'center', marginTop: 2 } },
                  h('span', { className: 'ab-small ab-muted', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x.at ? new Date(x.at).toLocaleString() : ''),
                  btn('删除', () => delShot(x.file), 'del:' + x.file)))))
            : h(ui.Empty, { icon: '🖼️', text: '截图库还是空的：开「看笔记配图」后她刷到配图笔记会按概率存进来；主人在聊天里说「发张截图」她就挑一张发过来' }))
        : tab === 'drafts'
          ? (drafts === null
            ? h('div', { className: 'ab-small ab-muted' }, '草稿加载中…')
            : drafts.length
              ? h('div', null,
                drafts.map((x) => h('div', { key: x.id, style: { padding: '8px 2px', borderBottom: '1px solid var(--ab-line)' } },
                  h('div', { className: 'ab-small', style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                    h('b', null, '《' + (x.title || '无标题') + '》'),
                    h('span', { className: 'ab-muted' }, '#' + x.id + ' · ' + (x.at ? new Date(x.at).toLocaleString() : '') + ' · ' + x.images + ' 张图')),
                  h('div', { className: 'ab-small', style: { margin: '4px 0', whiteSpace: 'pre-wrap', maxHeight: 80, overflowY: 'auto' } }, x.desc || ''),
                  h('div', { className: 'ab-flex', style: { gap: 8 } },
                    btn('✔ 确认发布', () => doDraft(x.id, false), 'ok:' + x.id, true),
                    btn('✕ 驳回', () => doDraft(x.id, true), 'no:' + x.id)))),
                h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } }, '也可以在主人私聊里用 xhs_publish_confirm 工具确认/驳回。'))
              : h(ui.Empty, { icon: '📝', text: '没有待确认的草稿（她要发帖时会先存到这里等你确认）' }))
          : (st === null
            ? h('div', { className: 'ab-small ab-muted' }, '加载中…')
            : (st.history || []).length
              ? h('div', null, (st.history || []).map(histRow))
              : h(ui.Empty, { icon: '📖', text: '还没有记录：点上面「去刷一轮」，或等她到点自己刷' }))),
  )
}
