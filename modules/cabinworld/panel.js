// 小屋世界面板：一栏到底 —— 状态、一键安装/启动、设置、名字同步、桥设置、保存。
// 这段是函数体，面板会注入 React、h、ui、call、toast。

const { useState, useEffect, useRef } = React

const FIELD_STYLE = { marginBottom: 14 }
const LABEL_STYLE = { fontWeight: 620, fontSize: 13, marginBottom: 2 }
const LINE_STYLE = { height: 1, background: 'var(--ab-line-2)', margin: '18px 0 14px' }
const errText = function (e) { return (e && e.message) || e }

return function CabinPanel({ settings, save, toast }) {
  const base = settings || {}
  const [info, setInfo] = useState(null)
  const [job, setJob] = useState(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState(function () { return Object.assign({}, base) })
  const [names, setNames] = useState(null)
  const [models, setModels] = useState([])
  const [nameInput, setNameInput] = useState('')
  const [portInput, setPortInput] = useState('18790')
  const [launchInput, setLaunchInput] = useState(true)
  const [weatherInput, setWeatherInput] = useState('virtual')
  const [bridgeMsg, setBridgeMsg] = useState('')
  const [booting, setBooting] = useState(false)
  const [pending, setPending] = useState(null)
  const [upd, setUpd] = useState(null)
  const [updSel, setUpdSel] = useState({})
  const [updMsg, setUpdMsg] = useState('')
  const [updBusy, setUpdBusy] = useState(false)
  const [memLog, setMemLog] = useState({ items: [], message: '' })
  const [life, setLife] = useState(null)
  const [lifeBusy, setLifeBusy] = useState(false)
  const [lifeMsg, setLifeMsg] = useState('')

  const loadHealth = async function () {
    try {
      const r = await call('/health')
      setInfo(r)
      setPending((r && r.pendingRestart) || null)
      if (r && r.install) setJob(r.install)
    } catch (e) {
      setMsg('取状态失败：' + errText(e))
    }
  }

  // 全量刷新：手动刷新按钮、安装完成、跑完一轮自动生活之后用。
  const load = async function () {
    await loadHealth()
    loadMemory()
    loadLife()
  }

  const loadMemory = async function () {
    try {
      const r = await call('/memory-log')
      setMemLog({ items: (r && r.items) || [], message: '' })
    } catch (e) {
      setMemLog({ items: [], message: '读记忆记录失败：' + errText(e) })
    }
  }

  const loadLife = async function () {
    try {
      const r = await call('/auto-life/state')
      setLife(r || null)
    } catch (e) {
      setLife(null)
      setLifeMsg('读自动生活状态失败：' + errText(e))
    }
  }

  const runLifeNow = async function () {
    setLifeBusy(true)
    setLifeMsg('正在让她自己活动一下，可能要一两分钟…')
    try {
      const r = await call('/auto-life/now', {})
      setLifeMsg((r && r.message) || '跑完了')
      await loadLife()
    } catch (e) {
      setLifeMsg('没跑成：' + errText(e))
    }
    setLifeBusy(false)
  }

  const loadNames = async function () {
    try {
      const r = await call('/bridge-config')
      setNames(r)
      if (r && r.config) {
        setPortInput(String(r.config.port))
        setLaunchInput(r.config.launchGame !== false)
        setWeatherInput(r.config.weatherMode || 'virtual')
      }
      if (r && r.bridgeName) setNameInput(function (old) { return old || r.bridgeName })
    } catch (e) {
      setBridgeMsg('读桥配置失败：' + errText(e))
    }
  }

  // 1.1 可选内容：读一次当前状态（不轮询，免得打断用户勾选）。
  const loadUpdate = async function () {
    try {
      const r = await call('/update', {})
      if (!r || !r.ok) { setUpd({ modules: [] }); setUpdMsg((r && r.message) || '读不到可选内容'); return }
      setUpd(r)
      setUpdMsg('')   // 上一次的报错要清掉，否则成功读到列表后下面还挂着旧文案
      const sel = {}
      ;(r.modules || []).forEach(function (m) { if (m && m.id) sel[m.id] = m.state === 'on' })
      setUpdSel(sel)
    } catch (e) {
      setUpdMsg('读可选内容失败：' + errText(e))
    }
  }

  const aliveRef = useRef(true)
  useEffect(function () { return function () { aliveRef.current = false } }, [])

  useEffect(function () {
    load()
    loadNames()
    loadUpdate()
    call('/models').then(function (r) { if (r && r.ok) setModels(r.models || []) }).catch(function (e) { setModels([]); setMsg('读模型列表失败：' + errText(e) + '，自动生活模型可能显示成「已下线」。') })
    // 状态 5 秒一次；记忆记录和自动生活状态降到 30 秒一次，少打两次读盘/请求。
    const fast = setInterval(loadHealth, 5000)
    const slow = setInterval(function () { loadMemory(); loadLife() }, 30000)
    return function () { clearInterval(fast); clearInterval(slow) }
  }, [])

  useEffect(function () {
    setForm(Object.assign({}, base))
  }, [base.writeMemory, base.allowSocial, base.injectState, base.injectStateGroup, base.autoLife, base.autoLifeMinutes, base.autoLifeMaxPerDay, base.autoLifeAllowBuy, base.autoLifeNotify, base.autoLifeProvider, base.autoLifeModel, base.autoLifeEffort])

  const set = function (key, value) {
    setForm(function (previous) {
      const next = Object.assign({}, previous)
      next[key] = value
      return next
    })
  }

  const watch = async function () {
    for (let i = 0; i < 900; i++) {
      await new Promise(function (r) { setTimeout(r, 1500) })
      if (!aliveRef.current) return
      try {
        const st = await call('/install/status')
        setJob(st)
        if (st && (st.phase === 'done' || st.phase === 'error')) {
          setMsg(st.message || '')
          load()
          return
        }
      } catch (e) { /* 还没好，继续等 */ }
    }
    setMsg('等太久了，去日志页看看。')
  }

  const install = async function () {
    setBusy(true)
    setMsg('')
    try {
      const r = await call('/install', {})
      setMsg((r && r.message) || '')
      await watch()
    } catch (e) {
      setMsg('安装失败：' + errText(e))
    }
    setBusy(false)
  }

  // 三个「点一下就发请求、把结果说出来、过一会儿刷新」的按钮只差三样：路径、失败文案、刷新延迟。
  const action = function (path, failText, delay) {
    return async function () {
      try {
        const r = await call(path, {})
        setMsg((r && r.message) || '')
        setTimeout(load, delay)
      } catch (e) {
        setMsg(failText + errText(e))
      }
    }
  }

  // 游戏窗口平时是藏着的，这个按钮把它叫出来（Godot 窗口用 SW_RESTORE 唤回）。
  const showGame = action('/game/show', '显示游戏窗口失败：', 800)
  // 关窗口（点 ×）会直接把游戏进程结束掉，想让它退到后台就用这个。
  const hideGame = action('/game/hide', '藏起游戏窗口失败：', 800)
  const start = action('/start', '启动失败：', 1500)

  // 重启：关掉游戏窗口再重启桥；游戏会自己连回来。
  const restart = async function () {
    setBusy(true)
    setMsg('正在重启…')
    try {
      const r = await call('/restart', {})
      setMsg((r && r.message) || '')
      setTimeout(load, 2500)
    } catch (e) {
      setMsg('重启失败：' + errText(e))
    }
    setBusy(false)
  }

  // 模块里装不上时，把这段贴给 DSH，让它手动把游戏装好。路径用面板已知的 gameDir，贴过去就能直接用。
  const copyInstallPrompt = async function () {
    const dir = (info && info.gameDir) ? String(info.gameDir).trim() : ''
    const text = [
      '帮我手动装一下 Cabin World（小屋世界）这个游戏。我的 DSH 里已经装了 aurabot 的 cabinworld 模块，但模块里「一键安装」失败了。',
      '',
      '游戏在 GitHub：https://github.com/BabyBus2022/cabin-world',
      '要 Release 里的 Windows 版，资源名是 CabinWorld-win64.zip。',
      '',
      dir ? ('请把它装到这个目录：' + dir) : '请先确认 cabinworld 模块的数据目录（一般叫 modules-data/cabinworld），把游戏装进去；具体路径看模块设置里「游戏目录」的值。',
      '装好的标志：那个目录下有 start.cmd 和 CabinWorld.exe。',
      '',
      '装完之后：',
      '1. 按模块设置里的住户名和端口准备 bridge.config.json（HTTP 只监听 127.0.0.1）；',
      '2. 启动游戏，确认 http://127.0.0.1:<端口>/v1/health 能返回 game:true；',
      '3. 回到 cabinworld 模块面板，点「取一次状态」看是不是在线。',
      '',
      '每一步都告诉我结果，哪里卡住了直说。',
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setMsg('提示词已复制，粘贴给 DSH 就行')
    } catch (e) {
      setMsg('复制失败：' + errText(e) + '。可以先把游戏目录发给 DSH，说「帮我照 cabinworld 模块的说明装 Cabin World 到 <目录>」。')
    }
  }

  // 只提交和当前不同的项；桥要求 modules 是 {"id": true/false}。
  const saveUpdate = async function () {
    if (!upd) return
    const diff = {}
    ;(upd.modules || []).forEach(function (m) {
      if (!m || !m.id) return
      const want = updSel[m.id] === true
      const now = m.state === 'on'
      if (want !== now) diff[m.id] = want
    })
    if (!Object.keys(diff).length) { setUpdMsg('没有改动'); return }
    setUpdBusy(true)
    try {
      const r = await call('/update/apply', { modules: diff })
      setUpdMsg((r && r.message) || '')
      if (r && r.ok) await loadUpdate()
    } catch (e) {
      setUpdMsg('保存失败：' + errText(e))
    }
    setUpdBusy(false)
  }

  const test = async function () {
    try {
      const r = await call('/status')
      if (!r || !r.ok) { setMsg('取状态失败：' + ((r && r.error) || '桥没在跑')); return }
      const s = r.status || {}
      const p = s.position || {}
      setMsg('她现在在：' + (p.place || '?') + (p.zoneName ? ' · ' + p.zoneName : '') + '，零花钱 ' + (s.wallet == null ? '?' : s.wallet) + ' 元')
    } catch (e) {
      setMsg('取状态失败：' + errText(e))
    }
  }

  const persist = async function () {
    setBusy(true)
    try {
      const patch = Object.assign({}, form)
      await save(patch)
      setMsg('设置已保存')
      load()
    } catch (e) {
      setMsg('保存失败：' + errText(e))
    }
    setBusy(false)
  }

  // 「自动生活」和「模块设置」两段末尾的保存按钮是同一块，抽出来共用。
  const saveRow = function () {
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 } },
      h(ui.Btn, { kind: 'primary', onClick: persist, disabled: busy }, '保存设置'),
      h('span', { className: 'ab-small ab-muted' }, '保存后几秒生效'))
  }

  const applyName = async function (payload) {
    setBooting(true)
    setBridgeMsg('正在保存名字…')
    try {
      const r = await call('/apply-name', payload)
      setBridgeMsg((r && r.message) || '')
      if (r && r.ok) { setMsg(''); load(); loadNames() }
    } catch (e) {
      setBridgeMsg('改名字失败：' + errText(e))
    }
    setBooting(false)
  }

  const applyBridge = async function () {
    const portText = String(portInput == null ? '' : portInput).trim()
    const port = Number(portText)
    if (portText === '' || !Number.isFinite(port) || (port !== 0 && (port < 1 || port > 65535))) {
      toast('端口要填 1-65535（0 = 自动）')
      return
    }
    setBooting(true)
    setMsg('正在保存桥设置…')
    try {
      const r = await call('/bridge-settings', { port: port, launchGame: launchInput, weatherMode: weatherInput })
      // 桥设置的提示必须用顶部通用的那条：bridgeMsg 渲染在「名字」折叠块里，在这个块点保存会什么都不显示。
      setMsg((r && r.message) || '')
      if (r && r.ok) { load(); loadNames() }
    } catch (e) {
      setMsg('保存桥设置失败：' + errText(e))
    }
    setBooting(false)
  }

  const installed = info && info.installed
  const bridgeOk = info && info.ok
  const gameOk = info && info.game
  const phase = job && job.phase
  const percent = job && job.percent ? job.percent : 0
  const running = job && (job.running || phase === 'downloading' || phase === 'unzipping' || phase === 'installing' || phase === 'checking')

  const HINT_STYLE = { fontSize: 11, lineHeight: 1.45, opacity: .55, marginTop: 3 }

  const line = function (label, value, ok) {
    return h('div', { className: 'ab-small', style: { marginBottom: 3, lineHeight: 1.6 } },
      h('span', { style: { color: ok === false ? 'var(--ab-warn)' : (ok === true ? 'var(--ab-ok)' : 'inherit') } }, '● '),
      h('b', null, label + '：'), value)
  }

  // 说明直接看得见，但压成输入框下面一行小字（11px、淡化），不靠悬停。
  const field = function (key, label, hint, node) {
    return h('div', { key: key, style: FIELD_STYLE },
      h('div', { style: LABEL_STYLE }, label),
      node,
      hint ? h('div', { style: HINT_STYLE }, hint) : null)
  }

  const inputBox = function (value, onChange, placeholder, type) {
    return h('input', {
      className: 'ab-input',
      style: { width: '100%', boxSizing: 'border-box' },
      type: type || 'text',
      value: value == null ? '' : String(value),
      placeholder: placeholder || '',
      onChange: function (e) { onChange(e.target.value) },
    })
  }

  // 开关的说明放到同一行的右侧（灰色小字），不额外占高度。
  const switchRow = function (value, onChange, label, hint) {
    return h('div', { style: { marginBottom: 10 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        h(ui.Switch, { on: value === true, onChange: function (v) { onChange(v === true) } }),
        h('span', { style: { fontWeight: 620, fontSize: 13, flex: '0 0 auto' } }, label),
        hint ? h('span', { style: { fontSize: 11, opacity: .55, marginLeft: 'auto', textAlign: 'right', maxWidth: '62%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, hint) : null))
  }

  // 每段收成可折叠的一块：默认收起，标题右边带一句概况，点开才展开。
  const fold = function (key, title, brief, children) {
    return h('details', { key: key, style: { marginTop: 12, borderTop: '1px solid rgba(127,127,127,.18)', paddingTop: 10 } },
      h('summary', { style: { cursor: 'pointer', fontWeight: 700, fontSize: 14 } },
        title,
        brief ? h('span', { className: 'ab-small ab-muted', style: { fontWeight: 400, marginLeft: 8 } }, brief) : null),
      h('div', { style: { marginTop: 10 } }, children))
  }

  // 已保存的「provider::model」可能不在 /models 列表里（模型下线或列表没读到），补一个占位项，
  // 免得受控 select 回落显示「跟随默认」而表单里还留着旧值。
  const curModelKey = String(form.autoLifeProvider || '') + '::' + String(form.autoLifeModel || '')
  const curModelMissing = curModelKey !== '::' && !models.some(function (m) { return m && (String(m.provider || '') + '::' + String(m.model || '')) === curModelKey })
  const namesReadFailed = String(bridgeMsg || '').indexOf('读桥配置失败') === 0
  const updReadFailed = (!upd || !Array.isArray(upd.modules) || upd.modules.length === 0) && !!updMsg
  const lifeReadFailed = String(lifeMsg || '').indexOf('读自动生活状态失败') === 0
  const personaText = names ? (names.personaName || '(未知)') : '…'
  const adv = info && info.advanced && info.advanced.tools ? info.advanced.tools : null
  const advNames = adv ? [['sleep', '睡觉'], ['toolpose', '姿势']].filter(function (row) { return adv[row[0]] === true }).map(function (row) { return row[1] }) : []
  const advText = !bridgeOk ? '等桥起来' : (!gameOk ? '游戏没连上（连上后才有）' : (advNames.length ? advNames.join('、') : '补丁没打上（看 bridge-host/sync.log）'))
  const bridgeNameText = names ? (names.bridgeName || '(没读到)') : '…'
  const same = names && names.same === true

  return h(ui.Card, {
    title: '小屋世界',
    desc: '给她一个会走路的身体：去公园、荡秋千、钓鱼、买零食，动作由游戏判定，结果记进记忆。桥和游戏只在本机跑。',
  },
  line('桥', bridgeOk ? ('在跑 ' + (info.url || '')) : ('没在跑' + (info && info.error ? '（' + info.error + '）' : '')), bridgeOk ? true : false),
  line('游戏', !bridgeOk ? '等桥起来' : (gameOk ? '在线' : '没打开 / 没连上'), !bridgeOk ? undefined : (gameOk ? true : false)),
  line('文件', installed ? '已安装' : '还没安装', installed ? true : false),
  line('高级', advText, !bridgeOk || !gameOk ? undefined : (advNames.length > 0)),

  h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } },
    h(ui.Btn, { kind: 'primary', onClick: install, disabled: busy || running }, installed ? '重新安装 / 更新' : '一键安装'),
    h(ui.Btn, { kind: 'ghost', onClick: copyInstallPrompt }, '装不上？复制提示词'),
    h(ui.Btn, { onClick: start, disabled: !installed || gameOk || busy || running }, gameOk ? '游戏已在运行' : '启动小屋世界'),
    h(ui.Btn, { onClick: restart, disabled: busy || running || !installed }, '重启小屋世界'),
    // 按「装没装」启用，不按桥有没有连上游戏：启动失败时窗口是被藏起来的，
    // 提示里让人「先看游戏窗口有没有报错」，按钮却灰着，只能去任务管理器。
    h(ui.Btn, { onClick: showGame, disabled: !installed }, '显示游戏窗口'),
    h(ui.Btn, { onClick: hideGame, disabled: !installed }, '藏起游戏窗口'),
    h(ui.Btn, { onClick: test, disabled: !bridgeOk }, '取一次状态'),
    h(ui.Btn, { kind: 'ghost', onClick: load }, '刷新')),

  pending ? h('div', { className: 'ab-small', style: { color: 'var(--ab-warn)', marginTop: 8, lineHeight: 1.55 } },
    '有改动还没生效：' + (pending.what || '设置') + '改过了，点上面「重启小屋世界」才会应用到游戏。') : null,

  running ? h('div', { style: { marginTop: 10 } },
    h('div', { className: 'ab-small ab-muted' }, (job.message || '') + '（' + percent + '%）'),
    h('div', { style: { height: 6, background: 'rgba(127,127,127,.25)', borderRadius: 3, overflow: 'hidden', marginTop: 4 } },
      h('div', { style: { width: Math.max(2, percent) + '%', height: '100%', background: '#4a7dff', transition: 'width .3s' } }))) : null,
  phase === 'error' ? h('div', { className: 'ab-small', style: { color: 'var(--ab-warn)', marginTop: 8 } }, job.error || job.message || '安装失败') : null,
  phase === 'done' ? h('div', { className: 'ab-small', style: { color: 'var(--ab-ok)', marginTop: 8 } }, job.message || '装好了') : null,
  msg ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } }, msg) : null,

  h('div', { style: LINE_STYLE }),

  fold('mem', '她记住了什么', (Array.isArray(memLog.items) && memLog.items.length ? '最近 ' + memLog.items.length + ' 条' : (memLog.message ? '读不到，点开看原因' : '')), [
  !(Array.isArray(memLog.items) && memLog.items.length)
    ? h('div', { className: 'ab-small ab-muted', style: { lineHeight: 1.6, marginBottom: 8 } }, memLog.message || '还没有记录。她做完一件事之后，写进记忆的内容会出现在这里。')
    : h('div', null, memLog.items.map(function (it, i) {
        const d = new Date(Number(it.at || 0))
        const p = function (n) { return String(n).padStart(2, '0') }
        const when = it.at ? ((d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())) : ''
        return h('div', { key: i, style: { marginBottom: 9 } },
          h('div', { className: 'ab-small ab-muted', style: { marginBottom: 2 } }, when + (it.label ? ' · ' + it.label : '')),
          h('div', { style: { fontSize: 12, lineHeight: 1.55 } }, it.text))
      })),
  h('div', { style: { marginTop: 8 } }, h(ui.Btn, { small: true, kind: 'ghost', onClick: loadMemory }, '刷新')),
  ]),

  fold('life', '自动生活', (life && life.state ? '共 ' + (Number(life.state.count) || 0) + ' 次' : (lifeReadFailed ? '读不到，点开看原因' : '自己去活动')), [
  switchRow(form.autoLife === true, function (v) { set('autoLife', v) }, '自动生活', '她自己会去公园、荡秋千、钓鱼、买吃的。'),
  field('autoLifeMinutes', '自动生活：多久一次（分钟）', '默认 45 分钟，最小 10。',
    inputBox(form.autoLifeMinutes, function (v) { set('autoLifeMinutes', v === '' ? '' : Number(v)) }, '45', 'number')),
  field('autoLifeMaxPerDay', '自动生活：每天最多几次', '默认 8，第二天重置。',
    inputBox(form.autoLifeMaxPerDay, function (v) { set('autoLifeMaxPerDay', v === '' ? '' : Number(v)) }, '8', 'number')),
  switchRow(form.autoLifeAllowBuy === true, function (v) { set('autoLifeAllowBuy', v) }, '自动生活：允许她自己花钱', '关掉后只用背包里已有的。'),
  switchRow(form.autoLifeNotify === true, function (v) { set('autoLifeNotify', v) }, '自动生活后发 QQ 告诉我', '每轮结束私聊告诉你她做了什么。'),
  field('autoLifeModel', '自动生活用哪个模型', '留空 = 跟随 DSH 默认。',
    h('select', { className: 'ab-input', style: { width: '100%', boxSizing: 'border-box' }, value: curModelKey, onChange: function (e) { const v = String(e.target.value || ''); const at = v.indexOf('::'); set('autoLifeProvider', at >= 0 ? v.slice(0, at) : ''); set('autoLifeModel', at >= 0 ? v.slice(at + 2) : '') } },
      h('option', { value: '::' }, '跟随 DSH 默认'),
      models.map(function (m) { return h('option', { key: m.provider + '::' + m.model, value: m.provider + '::' + m.model }, (m.provider || '?') + ' / ' + (m.name || m.model)) }),
      curModelMissing ? h('option', { value: curModelKey }, '（已下线）' + curModelKey) : null)),
  field('autoLifeEffort', '自动生活的思考强度', '留空 = 模型默认。',
    h('select', { className: 'ab-input', style: { width: 220 }, value: String(form.autoLifeEffort || ''), onChange: function (e) { set('autoLifeEffort', e.target.value) } },
      h('option', { value: '' }, '不指定'),
      h('option', { value: 'low' }, 'low'),
      h('option', { value: 'high' }, 'high'),
      h('option', { value: 'max' }, 'max'))),
  h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 } },
    h(ui.Btn, { small: true, onClick: runLifeNow, disabled: lifeBusy || !(life && life.enabled) }, lifeBusy ? '正在跑…' : '立刻跑一轮'),
    lifeMsg ? h('span', { className: 'ab-small ab-muted' }, lifeMsg) : null),
  saveRow(),
  ]),

  fold('names', '小屋世界里的名字', namesReadFailed ? '读不到，点开看原因' : ('桥：' + bridgeNameText + '　·　aurabot：' + personaText), [
    h('div', { className: 'ab-small ab-muted', style: { marginBottom: 10 } },
      '桥和游戏里的名字一起改；游戏没连上时只改桥，下次连上再点一次。'),
  same ? h('div', { className: 'ab-small', style: { color: 'var(--ab-ok)', marginBottom: 8 } }, '两边的名字已经一致。') : null,
  field('displayName', '要显示的名字', '', inputBox(nameInput, setNameInput, '例如 大肥鱼')),
  h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 } },
    h(ui.Btn, { small: true, onClick: function () { setNameInput((names && names.personaName) || '') } }, '用当前人格名'),
    h(ui.Btn, { small: true, onClick: function () { setNameInput((names && names.qqNickname) || '') } }, '用 QQ 昵称'),
    h(ui.Btn, { small: true, kind: 'ghost', onClick: function () { setNameInput('') } }, '清空')),
  h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 } },
    h(ui.Btn, { kind: 'primary', onClick: function () { applyName({ displayName: nameInput.trim() }) }, disabled: booting || !nameInput.trim() }, booting ? '处理中…' : '保存名字'),
    h('span', { className: 'ab-small ab-muted' }, '游戏连上时立刻改；没连上就等它连回来再点一次')),
  bridgeMsg ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6, marginBottom: 4 } }, bridgeMsg) : null,
  ]),
  fold('upd', '1.1 可选内容' + (upd && upd.release ? '（' + upd.release + '）' : ''),
    (updReadFailed ? '读不到，点开看原因' : (upd && Array.isArray(upd.modules) ? '已开 ' + upd.modules.filter(function (m) { return m && m.id && updSel[m.id] === true }).length + ' / ' + upd.modules.length : '')), [
  h('div', { className: 'ab-small ab-muted', style: { marginBottom: 12, lineHeight: 1.6 } },
    '关着就是 1.0 的样子；勾好点保存，重启游戏后生效。'),
  upd && (upd.modules || []).length ? h('div', null,
    (upd.modules || []).map(function (m) {
      if (!m || !m.id) return null
      const on = updSel[m.id] === true
      return h('div', { key: m.id, style: FIELD_STYLE },
        switchRow(on, function (v) { setUpdSel(function (old) { const next = Object.assign({}, old); next[m.id] = v; return next }) }, m.name, m.summary))
    }),
    h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 } },
      h(ui.Btn, { kind: 'primary', onClick: saveUpdate, disabled: updBusy }, updBusy ? '保存中…' : '保存可选内容'),
      h(ui.Btn, { kind: 'ghost', onClick: loadUpdate }, '重新读')))
  : h('div', { className: 'ab-small ab-muted', style: { lineHeight: 1.6 } }, updMsg || (upd ? '这一版没有可选内容' : '正在读…')),
  updMsg && upd && (upd.modules || []).length ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, updMsg) : null,
  ]),
  fold('bridge', '桥设置', '端口 ' + (String(portInput || '').trim() || 18790) + ' · ' + (launchInput ? '启动时自动开游戏' : '只起桥'), [
  field('port', '端口', '默认 18790，被占用就换一个。', inputBox(portInput, setPortInput, '18790', 'number')),
  switchRow(launchInput, setLaunchInput, '启动桥时自动打开游戏', '关掉就只起桥，不打开游戏。'),
  field('weatherMode', '天气', '虚拟天气是桥生成的；选「由机器人推送」需要你的机器人定时发天气。',
    h('select', { className: 'ab-input', value: weatherInput, style: { width: 220 }, onChange: function (e) { setWeatherInput(e.target.value) } },
      h('option', { value: 'virtual' }, '虚拟天气（默认）'),
      h('option', { value: 'push' }, '由机器人推送真实天气'))),
  h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 } },
    h(ui.Btn, { onClick: applyBridge, disabled: booting }, booting ? '处理中…' : '保存桥设置')),
  ]),
  fold('module', '模块设置', '记忆、状态注入', [
  h('div', { className: 'ab-small ab-muted', style: { marginBottom: 12, lineHeight: 1.55 } }, '改完点下面的保存，开关一样。'),
  switchRow(form.writeMemory === true, function (v) { set('writeMemory', v) }, '把经历记进记忆', '做完的事会记进她的记忆。'),
  switchRow(form.allowSocial === true, function (v) { set('allowSocial', v) }, '群聊里也能看小屋状态', '群聊里只让她看状态和身边。'),
  switchRow(form.injectState === true, function (v) { set('injectState', v) }, '每轮把当前状态塞进上下文（私聊）', '聊天时她知道自己在哪、饿不饿；会多花点 token。'),
  switchRow(form.injectStateGroup === true, function (v) { set('injectStateGroup', v) }, '群聊里也塞一点状态', '群聊里也知道地点、在做什么、天气。'),

  saveRow(),
  ]))
}
