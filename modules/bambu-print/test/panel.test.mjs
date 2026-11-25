// bambu-print 面板测试：和 Aurabot 面板加载 panel.js 的方式一致（new Function(body)），
// 再配一份最小的 React/ui/call stub 把面板真正渲染一遍。
//
// 这一版对应「一个面板装下设置 / 用户总览 / 局域网绑定 / 审计」：
//   · 设置走宿主草稿（props.setSettings），面板自己不再渲染「保存设置」；
//   · 总开关只读写 active，并且是首屏唯一一个 ui.Switch（在顶部 Card 的 right 插槽）；
//   · 秘密（访问码 / 主人安全码）用 password 且不进渲染树，提交成功立即清空。
// 安全底线（docs/ARCHITECTURE.md 第 0 节）：面板不得渲染任何 accessCode / accessToken / 安全码明文。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')
// 和 panel.js 里的 RISK_ACK_KEY 保持一致（面板记住「风险提示已认过」用的键）
const RISK_ACK_KEY_LOCAL = 'aurabot.bambu-print.riskAck'
// panel.js 会在「立即锁定」时调 window.confirm；测试里给它一个可控的替身
if (typeof globalThis.window === 'undefined') globalThis.window = {}
globalThis.window.confirm = () => true

const OVERVIEW = {
  ok: true,
  enabled: true,
  settings: {
    active: true,
    hostAllow: ['100001', '100002'],
    hostGroupAllow: ['700001'],
    unlockDays: 7,
  },
  owner: { qq: '100001', qqMasked: '100****001', online: false, lanAllowed: true, unlockDays: 7 },
  rules: {
    unlockDays: { kind: 'int', def: 7, min: 1, max: 30, step: 1, label: '解锁有效期（天）', hint: '到期后内存里的密钥自动清零（1~30 天，默认 7 天）。' },
    groupMode: { kind: 'enum', def: 'status', values: ['off', 'status', 'control'], label: '群模式', hint: '只作用于发起人自己的绑定。' },
    allowGroupName: { kind: 'bool', def: false, label: '群里允许显示文件名', hint: '默认关。' },
  },
  risk: '访问码 / token 等同于打印机控制权。',
  users: [
    {
      qq: '100001',
      qqMasked: '100****001',
      bindings: 2,
      printers: 3,
      unlocked: true,
      lockedUntil: 0,
      createdAt: 0,
      lastSeenAt: 1710000000000,
      bindingList: [
        {
          id: 'b_lan',
          label: '我的 A1',
          mode: 'lan',
          tokenMask: 'ac****39',
          printers: [{ serialMasked: '01S****789', name: 'A1', model: 'A1' }],
        },
        {
          id: 'b_cloud',
          label: '云端账号',
          mode: 'cloud',
          tokenMask: 'to****en',
          printers: [{ serialMasked: '02P****456', name: 'P1S', model: 'P1S' }],
        },
      ],
    },
    {
      qq: '200002',
      qqMasked: '200****002',
      bindings: 0,
      printers: 0,
      unlocked: false,
      lockedUntil: 0,
      createdAt: 0,
      lastSeenAt: 1710000000000,
      bindingList: [],
    },
  ],
  grants: [],
  // 新契约：actor 是完整 QQ（面板显示它），actorMasked 保留给老宿主/外部调用方
  audit: [
    { at: 1710000000000, actor: '100001', actorMasked: '100****001', action: 'owner-unlock', ok: true, note: '主人解锁' },
    { at: 1710000060000, actor: '100001', actorMasked: '100****001', action: 'control', ok: false, note: 'NEED_CONFIRM' },
  ],
  counts: { users: 2, boundUsers: 1, bindings: 2, printers: 3, unlocked: 1, activeGrants: 0 },
}

const LAN_STATUS = {
  ok: true,
  ownerQQ: '100001',
  ownerMasked: '100****001',
  ownerOnline: true,
  unlockDays: 7,
  lanAllowed: true,
  bindings: [
    { id: 'lan_1', label: '局域网打印机', tokenMask: 'ac****39', printers: [{ serialMasked: '01S****789', name: 'A1', model: 'A1' }] },
  ],
}

/**
 * 最小 React stub：useState 按调用顺序存值，useEffect 先收集、mount 时跑一次。
 * setSettings 桩会像宿主那样把补丁并进 draftSettings，这样二次渲染能拿到新草稿值。
 */
function harness (overview = OVERVIEW, opts = {}) {
  const values = []
  let index = 0
  const effects = []
  const calls = []
  const toasts = []
  const saved = []
  const patches = []
  const secretRefs = {}
  // localStorage 桩：面板用它在「我知道」之后记住风险横幅已认过
  const store = Object.assign({}, opts.store || {})
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
  }
  const settings = Object.assign({ active: true }, opts.settings || {})
  const draft = Object.assign({ active: true }, opts.settings || {}, opts.draft || {})

  const React = {
    useState: (initial) => {
      const i = index++
      if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial
      return [values[i], (v) => { values[i] = typeof v === 'function' ? v(values[i]) : v }]
    },
    useEffect: (fn) => { effects.push(fn) },
    useCallback: (fn) => fn,
    useRef: (initial) => {
      const i = index++
      if (!(i in values)) values[i] = { current: initial }
      return values[i]
    },
  }
  const h = (type, props, ...children) => {
    const node = {
      type,
      props: props || {},
      children: children.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false),
    }
    if (node.props['data-secret'] && node.props.ref) secretRefs[node.props['data-secret']] = node.props.ref
    return node
  }
  const ui = Object.fromEntries(['Card', 'Row', 'Btn', 'Select', 'Empty', 'Switch', 'Seg'].map((k) => [k, k]))

  const call = async (path, body) => {
    calls.push({ path, body })
    if (typeof opts.call === 'function') {
      const injected = await opts.call(path, body)
      if (injected !== undefined) return injected
    }
    if (path === '/overview') return JSON.parse(JSON.stringify(overview === undefined ? OVERVIEW : overview))
    if (path === '/lan/status') return JSON.parse(JSON.stringify(opts.lanStatus || LAN_STATUS))
    if (path === '/lan/bind') return { ok: true, count: 1, probe: { ok: true, message: '已连上打印机' }, cert: { fingerprint256: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44' } }
    if (path === '/owner/unlock') return { ok: true, until: Date.now() + 7 * 86400000, unlockDays: 7 }
    if (path === '/owner/lock') return { ok: true }
    if (path === '/audit') return { ok: true, audit: (overview || OVERVIEW).audit || [] }
    if (path === '/tutk/status') {
      return {
        ok: true,
        bridge: { ok: true, path: 'C:/mods/assets/tutk-bridge/bambu-tutk-bridge.exe', builtin: true },
        lib: { ok: true, path: 'C:/mods/assets/tutk-bridge/BambuSource.dll', download: 'https://github.com/ClusterM/open-bamboo-networking/releases', file: 'BambuSource.dll' },
      }
    }
    if (path === '/tutk/download') return { ok: true, path: 'C:/mods/assets/tutk-bridge/BambuSource.dll', bytes: 5606400, version: 'v2.3.0', via: 'githubproxy.cc', proxy: true, ready: true }
    return { ok: true, message: '完成' }
  }

  // 面板里用 window.localStorage 记住「风险提示已认过」；测试里给它一个内存桩
  const prevWindow = globalThis.window
  globalThis.window = Object.assign({}, prevWindow || {}, { localStorage })
  const Panel = new Function('React', 'h', 'ui', 'call', SOURCE)(React, h, ui, call)
  const render = (extra) => {
    index = 0
    return Panel(Object.assign({
      settings,
      draftSettings: draft,
      setSettings: (patch) => { patches.push(patch); Object.assign(draft, patch) },
      save: async (patch) => { saved.push(patch) },
      toast: (message, kind) => toasts.push({ message, kind }),
      reload: () => {},
    }, extra || {}))
  }
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  // mount：跑一次 effect（load() 是异步的），等它把数据落到 state 里再渲染
  const mount = async (extra) => {
    render(extra)
    for (const fn of effects.splice(0)) {
      const out = fn()
      if (typeof out === 'function') out()
    }
    await settle()
    return render(extra)
  }
  return {
    Panel, render, mount, settle, calls, toasts, saved, patches, secretRefs, settings, draft,
    store: () => store,
    seedStore: (patch) => Object.assign(store, patch || {}),
    setState: (i, v) => { values[i] = v },
  }
}

const walk = (node) => {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(walk)
  return [node, ...walk(node.children), ...walk(node.props && node.props.right)]
}
const text = (node) => {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  if (!node || typeof node !== 'object') return ''
  const p = node.props || {}
  const own = [p.title, p.desc, p.placeholder, p.alt, p.text].filter((x) => typeof x === 'string').join('')
  return own + (node.children || []).map(text).join('')
}
const byType = (tree, type) => walk(tree).filter((n) => n.type === type)
const buttons = (tree) => byType(tree, 'Btn')
const button = (tree, label) => buttons(tree).find((n) => text(n) === label)
const inputs = (tree) => walk(tree).filter((n) => n.type === 'input' || n.type === 'textarea')
const switches = (tree) => byType(tree, 'Switch')
const cards = (tree) => byType(tree, 'Card')
const cardTitled = (tree, label) => cards(tree).find((c) => String(c.props.title) === label)
const seg = (tree) => byType(tree, 'Seg')[0]
const pass = async (h1) => {
  const tree = await h1.mount()
  const s = seg(tree)
  assert.ok(s, '首屏应有 ui.Seg 分页')
  s.props.onChange('lan')
  await h1.settle()
  return h1.render()
}
const gotoSettings = async (h1, tree) => {
  const mounted = tree || h1.render()
  seg(mounted).props.onChange('settings')
  await h1.settle()
  return h1.render()
}

test('panel.js 能被 new Function(body) 解析，并返回一个组件函数', () => {
  assert.doesNotThrow(() => new Function(SOURCE))
  const h1 = harness()
  assert.equal(typeof h1.Panel, 'function')
  assert.equal(typeof h1.render(), 'object')
})

test('首屏：顶部卡片 + 五个页签，默认停在「总览」', async () => {
  const h1 = harness()
  const tree = await h1.mount()
  const all = text(tree)
  assert.match(all, /拓竹/)
  assert.match(all, /2 个用户 · 3 台打印机/)
  const s = seg(tree)
  assert.ok(s, '缺少 ui.Seg 分页')
  assert.deepEqual(s.props.options.map((o) => o.value), ['overview', 'enroll', 'lan', 'settings', 'audit', 'help'])
  assert.deepEqual(s.props.options.map((o) => o.label), ['总览', '登录信封', '局域网绑定', '设置', '审计', '帮助'])
  assert.equal(s.props.value, 'overview', '默认页应是总览')
  assert.match(all, /用户与打印机/)
  assert.ok(cardTitled(tree, '用户与打印机'), '总览页内容应在首屏')
  // 切页不重新请求 /overview
  const before = h1.calls.filter((c) => c.path === '/overview').length
  s.props.onChange('settings')
  await h1.settle()
  const settingsTree = h1.render()
  assert.equal(seg(settingsTree).props.value, 'settings')
  assert.ok(cardTitled(settingsTree, '设置'))
  assert.equal(h1.calls.filter((c) => c.path === '/overview').length, before, '切页不该重新拉 /overview')
  // 再切到审计、总览
  seg(settingsTree).props.onChange('audit')
  await h1.settle()
  assert.ok(cardTitled(h1.render(), '审计'))
  seg(h1.render()).props.onChange('overview')
  await h1.settle()
  assert.ok(cardTitled(h1.render(), '用户与打印机'))
  // 局域网页
  seg(h1.render()).props.onChange('lan')
  await h1.settle()
  assert.ok(cardTitled(h1.render(), '局域网绑定'))
})

test('总开关：首屏唯一一个 Switch 就在顶部 Card 的 right 上，改的是草稿 active，且没有「保存设置」按钮', async () => {
  const h1 = harness()
  const tree = await h1.mount()
  const all = switches(tree)
  assert.equal(all.length, 1, '首屏只应有顶部那一个总开关')
  const top = cardTitled(tree, '拓竹')
  assert.ok(top, '缺少顶部卡片')
  assert.equal(top.props.right, all[0], '总开关必须在顶部 Card 的 right 插槽')
  assert.equal(all[0].props.on, true, 'settings.active 默认 true，开关应为开')
  assert.equal(all[0].props.title.indexOf('总开关') >= 0, true)
  all[0].props.onChange(false)
  assert.deepEqual(h1.patches[h1.patches.length - 1], { active: false }, '关掉总开关只写草稿 active')
  // 开着 / 关着两段状态文字都由 active 派生
  assert.match(text(tree), /开着：会响应打印机相关命令/)
  const h2 = harness(OVERVIEW, { settings: { active: false }, draft: { active: false } })
  const off = await h2.mount()
  assert.equal(switches(off)[0].props.on, false)
  assert.match(text(off), /关着：私聊和群里的打印机命令都不再响应/)
  assert.equal(text(off).indexOf('开着：'), -1)
  // 界面里不许再有自己那个「保存设置」按钮
  assert.equal(button(tree, '保存设置'), undefined, '不应再自己渲染「保存设置」')
  assert.equal(button(tree, '保存'), undefined)
  assert.equal(text(tree).indexOf('改过了还没保存'), -1, '没改动时不该有未保存提示')
  assert.equal(button(h1.render(), '保存设置'), undefined)
})

test('dirty：settings 与 draftSettings 不一致时提示要去页面底部保存', async () => {
  const h1 = harness(OVERVIEW, { settings: { active: true }, draft: { active: false } })
  const tree = await h1.mount()
  assert.match(text(tree), /改过了还没保存/)
  assert.match(text(tree), /保存设置/)
  const clean = await harness().mount()
  assert.equal(text(clean).indexOf('改过了还没保存'), -1)
})

test('设置页：字段由 /overview.rules 驱动，数字失焦夹取并回写草稿；rules 缺失时退回内置规则', async () => {
  const h1 = harness()
  const tree = await gotoSettings(h1, await h1.mount())
  const all = text(tree)
  // 分组标题和 rules 里的 label / hint
  for (const label of ['多用户与准入', '多用户模式', '接口与时长', '云端画面（TUTK）', '解锁有效期（天）', '默认接口', '允许主人使用本地接口']) {
    assert.match(all, new RegExp(label))
  }
  assert.match(all, /到期后内存里的密钥自动清零/, 'hint 应来自服务端 rules')
  assert.match(all, /哪些群能用，都跟着 Aurabot 自己的白名单走/)
  assert.match(all, /目前私聊 2 个号、群 1 个群/)
  // 局域网 TLS 只读说明
  assert.match(all, /首次连接自动学习，之后严格校验/)
  assert.match(all, /始终开启/)
  // 设置页不再有总开关、也不再有「保存设置」按钮
  assert.equal(button(tree, '保存设置'), undefined)
  // int 字段：min/max/step 来自规则
  const box = inputs(tree).find((n) => n.props['data-key'] === 'unlockDays')
  assert.ok(box, '缺少 unlockDays 输入框')
  assert.equal(box.props.type, 'number')
  assert.equal(box.props.min, 1)
  assert.equal(box.props.max, 30)
  assert.equal(box.props.step, 1)
  box.props.onChange({ target: { value: '999' } })
  await h1.settle()
  const again = inputs(h1.render()).find((n) => n.props['data-key'] === 'unlockDays')
  again.props.onBlur()
  await h1.settle()
  const patched = h1.patches.filter((p) => 'unlockDays' in p).pop()
  assert.ok(patched, '失焦后应把夹取结果写回草稿')
  assert.equal(patched.unlockDays, 30, '面板端也要把 999 夹到 30')
  // 低于下限也会夹回来
  inputs(h1.render()).find((n) => n.props['data-key'] === 'unlockDays').props.onChange({ target: { value: '0' } })
  await h1.settle()
  inputs(h1.render()).find((n) => n.props['data-key'] === 'unlockDays').props.onBlur()
  await h1.settle()
  assert.equal(h1.patches.filter((p) => 'unlockDays' in p).pop().unlockDays, 1)
  // enum 文案中文化
  const select = walk(h1.render()).filter((n) => n.type === 'Select').map((n) => n.props)
  const groupMode = select.find((p) => (p.options || []).some((o) => o.value === 'control'))
  assert.ok(groupMode, '缺少群模式下拉')
  assert.deepEqual(groupMode.options.map((o) => o.label), ['关闭（群里完全不理）', '仅状态（只读）', '允许控制'])
  const iface = select.find((p) => (p.options || []).some((o) => o.value === 'cloud'))
  assert.ok(iface.options.some((o) => o.label === '云端接口（Bambu 云，需 token）'))
  assert.ok(iface.options.some((o) => o.label === '本地接口（局域网直连，需访问码）'))

  // rules 缺失：不崩，退回内置默认规则
  const bare = JSON.parse(JSON.stringify(OVERVIEW))
  delete bare.rules
  delete bare.settings.rules
  const h2 = harness(bare)
  const t2 = await gotoSettings(h2, await h2.mount())
  assert.match(text(t2), /解锁有效期（天）/)
  const box2 = inputs(t2).find((n) => n.props['data-key'] === 'unlockDays')
  assert.ok(box2, 'rules 缺失时也要有内置规则驱动的输入框')
  assert.equal(box2.props.max, 30)
})

test('局域网绑定页：秘密不进渲染树、提交后清空、校验失败不发请求', async () => {
  const h1 = harness()
  const tree = await pass(h1)
  assert.match(text(tree), /已解锁（7 天内有效）/)
  // 秘密输入必须是 password，渲染树里不能带明文
  const secret = walk(tree).find((n) => n.props && n.props['data-secret'] === 'lan-access-code')
  assert.ok(secret, '缺少访问码输入框')
  assert.equal(secret.props.type, 'password')
  assert.equal(secret.props.autoComplete, 'off')
  // 非受控输入：value 不在渲染树里（所以永远不可能带出明文），DOM 初值是空串
  assert.equal('value' in secret.props, false, 'password 框不该有受控 value')
  assert.equal(secret.props.defaultValue, '')
  secret.props.onChange({ target: { value: 'SECRET-CODE-99' } })
  await h1.settle()
  const typed = h1.render()
  assert.equal(JSON.stringify(typed).indexOf('SECRET-CODE-99'), -1, '渲染树里不能出现访问码原文')

  const serial = inputs(typed).find((n) => n.props['data-key'] === 'serial-0')
  const ip = inputs(typed).find((n) => n.props['data-key'] === 'ip-0')
  assert.ok(serial && ip, '缺少打印机行输入框')
  serial.props.onChange({ target: { value: '01S00A123456789' } })
  ip.props.onChange({ target: { value: '192.168.1.50' } })
  await h1.settle()

  // 提交前先给 ref 塞一个假 DOM 值，验证成功后确实被清空
  assert.ok(h1.secretRefs['lan-access-code'], '秘密输入应带 ref')
  h1.secretRefs['lan-access-code'].current = { value: 'SECRET-CODE-99' }

  const before = h1.calls.filter((c) => c.path === '/lan/bind').length
  await button(h1.render(), '提交绑定').props.onClick()
  await h1.settle()
  const binds = h1.calls.filter((c) => c.path === '/lan/bind')
  assert.equal(binds.length, before + 1, '提交后应调 /lan/bind')
  assert.equal(binds[binds.length - 1].body.accessCode, 'SECRET-CODE-99')
  assert.deepEqual(binds[binds.length - 1].body.printers, [{ serial: '01S00A123456789', ip: '192.168.1.50', name: '' }])
  assert.equal(h1.secretRefs['lan-access-code'].current.value, '', '成功后访问码输入框要被清空')

  const after = h1.render()
  assert.match(text(after), /✓ 绑定成功（1 台）/)
  assert.match(text(after), /已连上打印机/)
  assert.match(text(after), /AA:BB:CC:DD:EE:F…/, '证书指纹只显示前 16 位')
  assert.equal(text(after).indexOf('AA:BB:CC:DD:EE:FF:00:11:22:33:44'), -1, '不能把整条指纹都打出来')
  assert.equal(JSON.stringify(after).indexOf('SECRET-CODE-99'), -1)
  assert.equal(text(after).indexOf('SECRET-CODE-99'), -1)
  // 行也清空了：再点一次提交不会把旧数据再发一遍
  await button(h1.render(), '提交绑定').props.onClick()
  await h1.settle()
  assert.equal(h1.calls.filter((c) => c.path === '/lan/bind').length, before + 1)
  assert.match(text(h1.render()), /至少填一台打印机/)

  // 校验失败：给中文原因，且一个请求都不发
  const h2 = harness()
  const t2 = await pass(h2)
  const sec2 = walk(t2).find((n) => n.props && n.props['data-secret'] === 'lan-access-code')
  sec2.props.onChange({ target: { value: 'CODE' } })
  inputs(t2).find((n) => n.props['data-key'] === 'serial-0').props.onChange({ target: { value: 'x!' } })
  inputs(t2).find((n) => n.props['data-key'] === 'ip-0').props.onChange({ target: { value: '192.168.1.50' } })
  await h2.settle()
  await button(h2.render(), '提交绑定').props.onClick()
  await h2.settle()
  assert.equal(h2.calls.filter((c) => c.path === '/lan/bind').length, 0, '格式不对不该发请求')
  assert.match(text(h2.render()), /序列号格式不对/)

  // IP 不合法
  const h3 = harness()
  const t3 = await pass(h3)
  walk(t3).find((n) => n.props && n.props['data-secret'] === 'lan-access-code').props.onChange({ target: { value: 'CODE' } })
  inputs(t3).find((n) => n.props['data-key'] === 'serial-0').props.onChange({ target: { value: '01S00A123456789' } })
  inputs(t3).find((n) => n.props['data-key'] === 'ip-0').props.onChange({ target: { value: '999.1' } })
  await h3.settle()
  await button(h3.render(), '提交绑定').props.onClick()
  await h3.settle()
  assert.equal(h3.calls.filter((c) => c.path === '/lan/bind').length, 0)
  assert.match(text(h3.render()), /IP 格式不对/)

  // 空访问码
  const h4 = harness()
  const t4 = await pass(h4)
  inputs(t4).find((n) => n.props['data-key'] === 'serial-0').props.onChange({ target: { value: '01S00A123456789' } })
  inputs(t4).find((n) => n.props['data-key'] === 'ip-0').props.onChange({ target: { value: '192.168.1.50' } })
  await h4.settle()
  await button(h4.render(), '提交绑定').props.onClick()
  await h4.settle()
  assert.equal(h4.calls.filter((c) => c.path === '/lan/bind').length, 0)
  assert.match(text(h4.render()), /访问码/)
})

test('局域网绑定页：未解锁时给解锁表单，成功后 reload；lanAllowed=false 时给「去设置」', async () => {
  const locked = JSON.parse(JSON.stringify(OVERVIEW))
  locked.owner.online = false
  const h1 = harness(locked, { lanStatus: { ok: true, ownerMasked: '100****001', ownerOnline: false, unlockDays: 7, lanAllowed: false, bindings: [] } })
  const t1 = await pass(h1)
  assert.match(text(t1), /主人未解锁/)
  assert.match(text(t1), /设置里「允许主人使用本地接口」是关的/)
  assert.ok(button(t1, '去设置'), '应有「去设置」按钮')
  button(t1, '去设置').props.onClick()
  await h1.settle()
  assert.equal(seg(h1.render()).props.value, 'settings')
  // 解锁表单：password 输入 + 解锁按钮
  const back = h1.render()
  seg(back).props.onChange('lan')
  await h1.settle()
  const lanTree = h1.render()
  const code = walk(lanTree).find((n) => n.props && n.props['data-secret'] === 'owner-code')
  assert.ok(code, '缺少主人安全码输入框')
  assert.equal(code.props.type, 'password')
  code.props.onChange({ target: { value: 'MY-OWNER-CODE' } })
  await h1.settle()
  assert.equal(JSON.stringify(h1.render()).indexOf('MY-OWNER-CODE'), -1)
  const before = h1.calls.filter((c) => c.path === '/overview').length
  await button(h1.render(), '解锁').props.onClick()
  await h1.settle()
  const unlock = h1.calls.find((c) => c.path === '/owner/unlock')
  assert.ok(unlock, '应调 /owner/unlock')
  assert.equal(unlock.body.code, 'MY-OWNER-CODE')
  assert.ok(h1.calls.filter((c) => c.path === '/overview').length > before, '解锁成功后应 reload /overview')
})

test('总览页：QQ 显示完整号（不打码），序列号/凭据仍打码；点行才展开', async () => {
  const h1 = harness()
  const tree = await h1.mount()
  const all = text(tree)
  for (const label of ['QQ', '凭据', '打印机', '状态', '最近活跃']) assert.match(all, new RegExp(label))
  // 用户说：QQ 不用打码 —— 列表里必须是完整号
  assert.match(all, /100001/)
  assert.match(all, /200002/)
  assert.equal(all.indexOf('100****001'), -1, '用户列表不该再显示打码 QQ')
  assert.equal(all.indexOf('QQ（打码）'), -1, '表头不该再写「打码」')
  assert.match(all, /已绑定用户/)
  // 点一行展开
  const row = walk(tree).find((n) => n.props && n.props.role === 'button' && text(n).indexOf('100001') >= 0)
  assert.ok(row, '缺少可展开的用户行')
  assert.equal(text(tree).indexOf('01S****789'), -1, '展开前不该有序列号')
  row.props.onClick()
  await h1.settle()
  const opened = h1.render()
  // 序列号仍然是打码的
  assert.match(text(opened), /01S\*\*\*\*789/)
  assert.equal(text(opened).indexOf('01S00A123456789'), -1, '序列号不该出现完整值')
  assert.match(text(opened), /局域网/)
  assert.match(text(opened), /云端/)
  assert.match(text(opened), /ac\*\*\*\*39/)
  // 「只看已绑定」：本地 state，不能进 setSettings
  const patchesBefore = h1.patches.length
  const filterBtn = button(opened, '只看已绑定')
  assert.ok(filterBtn, '缺少「只看已绑定」筛选')
  filterBtn.props.onClick()
  await h1.settle()
  const filtered = h1.render()
  assert.equal(text(filtered).indexOf('200002'), -1, 'bindings===0 的用户应被过滤掉')
  assert.ok(text(filtered).indexOf('100001') >= 0)
  assert.equal(h1.patches.length, patchesBefore, '本地筛选不该写设置')
  // 空状态
  const empty = JSON.parse(JSON.stringify(OVERVIEW))
  empty.users = []
  empty.counts = { users: 0, boundUsers: 0, bindings: 0, printers: 0, unlocked: 0, activeGrants: 0 }
  const h2 = harness(empty)
  assert.match(text(await h2.mount()), /还没有人绑定过打印机|还没有用户/)
})

test('局域网页：免安全码入口 + 搜索局域网（发现不返回访问码）', async () => {
  const lanOff = JSON.parse(JSON.stringify(OVERVIEW))
  lanOff.owner = { qq: '100001', qqMasked: '100****001', online: false, lanAllowed: true, unlockDays: 7, noCode: true, codeless: false, hasAccount: false }
  const h1 = harness(lanOff, {
    // 夹具里的 LAN_STATUS 默认 ownerOnline:true，这条用例要「未解锁」，显式覆盖
    lanStatus: { ok: true, ownerQQ: '100001', ownerMasked: '100****001', ownerOnline: false, unlockDays: 7, lanAllowed: true, bindings: [] },
    call: async (path) => {
      if (path === '/lan/discover') {
        return { ok: true, devices: [{ serial: '01S00A123456789', ip: '192.168.1.50', name: 'A1', model: 'C12', signal: '-50' }], port: 2021, note: '访问码不会广播' }
      }
      if (path === '/owner/nocode') return { ok: true, mode: 'host', until: Date.now() + 86400000 }
      return undefined
    },
  })
  const tree = await h1.mount()
  seg(tree).props.onChange('lan')
  await h1.settle()
  const lan = h1.render()
  const all = text(lan)

  // 免码入口：主人不用输密码就能开
  const noCode = button(lan, '建立账号，直接开始')
  assert.ok(noCode, '未解锁时应当有「建立账号，直接开始」')
  await noCode.props.onClick()
  await h1.settle()
  const hit = h1.calls.find((c) => c.path === '/owner/nocode')
  assert.ok(hit, '应当调 /owner/nocode')
  // 说明里必须写清代价，不能只写「更方便」
  assert.match(all, /机器|host-key|数据目录/, '要说明密钥由本机保管')

  // 发现入口
  const scan = button(h1.render(), '搜索局域网打印机')
  assert.ok(scan, '应当有「搜索局域网打印机」')
  await scan.props.onClick()
  await h1.settle()
  const scanCall = h1.calls.find((c) => c.path === '/lan/discover')
  assert.ok(scanCall, '应当调 /lan/discover')

  const after = h1.render()
  const afterText = text(after)
  assert.match(afterText, /01S00A123456789/, '应当列出搜到的序列号')
  assert.match(afterText, /A1/)
  // 点「用这台」把序列号 + IP 填进表单
  const use = button(after, '用这台')
  assert.ok(use, '每台设备应当有「用这台」')
  use.props.onClick()
  await h1.settle()
  const filled = h1.render()
  const serialInput = walk(filled).find((n) => n.props && n.props['data-key'] === 'serial-0')
  assert.ok(serialInput, '序列号那一行要存在')
  assert.equal(serialInput.props.value, '01S00A123456789', '序列号应当被填好')
  const ipInput = walk(filled).find((n) => n.props && n.props['data-key'] === 'ip-0')
  assert.equal(ipInput.props.value, '192.168.1.50', 'IP 应当被填好')
  // 发现结果里不该出现任何访问码
  assert.equal(JSON.stringify(h1.calls).includes('accessCode'), false)
})

test('老服务端只给 qqMasked 时退回打码值，不崩也不显示 undefined', async () => {
  const legacy = JSON.parse(JSON.stringify(OVERVIEW))
  for (const u of legacy.users) delete u.qq
  delete legacy.owner.qq
  const h1 = harness(legacy)
  const all = text(await h1.mount())
  assert.match(all, /100\*\*\*\*001/, '没有完整 QQ 时用打码值兜底')
  assert.equal(all.indexOf('undefined'), -1)
})

test('审计页：点「读取最近 50 条」调 /audit 且 body.limit === 50', async () => {
  const h1 = harness()
  const tree = await h1.mount()
  seg(tree).props.onChange('audit')
  await h1.settle()
  const auditTree = h1.render()
  const all = text(auditTree)
  for (const label of ['时间', '操作者', '动作', '结果', '备注']) assert.match(all, new RegExp(label))
  assert.match(all, /解锁/)
  const read = button(auditTree, '读取最近 50 条')
  assert.ok(read, '缺少「读取最近 50 条」按钮')
  await read.props.onClick()
  await h1.settle()
  const hit = h1.calls.filter((c) => String(c.path).indexOf('/audit') === 0).pop()
  assert.ok(hit, '应当调 /audit')
  assert.equal(hit.body.limit, 50)
  // 操作者显示完整 QQ（用户要求审计不打码）；老服务端只有 actorMasked 时退回打码值
  assert.match(all, /100001/, '审计里应当显示完整 QQ')
  assert.equal(all.indexOf('100****001'), -1, '审计里不该再出现打码 QQ')
  const legacyAudit = JSON.parse(JSON.stringify(OVERVIEW))
  legacyAudit.audit = [{ at: 1710000000000, actorMasked: '100****001', action: 'unlock', ok: true, note: '旧记录' }]
  const h3 = harness(legacyAudit)
  const t3 = await h3.mount()
  seg(t3).props.onChange('audit')
  await h3.settle()
  const legacyText = text(h3.render())
  assert.match(legacyText, /100\*\*\*\*001/, '没有完整 QQ 时退回打码值')
  assert.equal(legacyText.indexOf('undefined'), -1)

  // 空状态
  const h2 = harness(undefined, { call: async (path) => { if (path === '/audit') return { ok: true, audit: [] } ; return undefined } })
  const t2 = await h2.mount()
  seg(t2).props.onChange('audit')
  await h2.settle()
  await button(h2.render(), '读取最近 50 条').props.onClick()
  await h2.settle()
  assert.match(text(h2.render()), /还没有审计记录/)
})

test('读取失败：显示原因 + 「重试」，重试会重新请求', async () => {
  const h1 = harness(undefined, {
    call: async (path) => {
      if (path === '/overview') return { ok: false, message: '读取失败：保险库暂时打不开' }
      return undefined
    },
  })
  const tree = await h1.mount()
  assert.match(text(tree), /读取失败：保险库暂时打不开/)
  assert.equal(JSON.stringify(tree).indexOf('用户与打印机'), -1, '失败时不该画数据')
  const retry = button(tree, '重试')
  assert.ok(retry, '失败时应给「重试」')
  const before = h1.calls.filter((c) => c.path === '/overview').length
  await retry.props.onClick()
  await h1.settle()
  assert.equal(h1.calls.filter((c) => c.path === '/overview').length, before + 1)
})

test('老宿主没有 setSettings：退回本地 patch，并且只对改的那一项调 save', async () => {
  const h1 = harness()
  const tree = await h1.mount({ setSettings: undefined, draftSettings: undefined })
  assert.match(text(tree), /拿不到草稿接口/, '页首要提示这是在老宿主上退化的模式')
  assert.equal(text(tree).indexOf('改过了还没保存'), -1, '没有草稿就没有 dirty 概念')
  const sw = switches(tree)[0]
  sw.props.onChange(false)
  await h1.settle()
  assert.deepEqual(h1.saved[h1.saved.length - 1], { active: false }, '只对改的这一项落盘')
  const after = h1.render({ setSettings: undefined, draftSettings: undefined })
  assert.match(text(after), /关着：私聊和群里的打印机命令都不再响应/, '本页要立刻反映改后的值')
  assert.equal(button(after, '保存设置'), undefined)
})

test('风险提示收成一条横幅：点「我知道」后收起，且重挂也不再出现', async () => {
  const h1 = harness()
  const tree = await h1.mount()
  const top = tree.children ? tree.children[0] : null
  assert.ok(top, '应有内容')
  const topText = text(top)
  // 首屏只有一条提示横幅（不再把四条正文铺在页首）
  assert.match(topText, /高权限设备控制/)
  assert.match(topText, /访问码等于打印机控制权/)
  assert.equal(topText.indexOf('每个用户的凭据仍然加密落盘'), -1, '正文不该再铺在页首')
  // 切页后横幅仍在（没点「我知道」之前它一直提示）
  seg(tree).props.onChange('settings')
  await h1.settle()
  const still = h1.render()
  assert.match(text(still), /高权限设备控制/)

  // 点「我知道」→ 立刻收起
  const afterSwitch = h1.render()
  const ack = button(afterSwitch, '我知道')
  assert.ok(ack, '缺少「我知道」按钮；当前按钮：' + buttons(afterSwitch).map((b) => text(b)).join(' | '))
  ack.props.onClick()
  await h1.settle()
  const gone = h1.render()
  assert.equal(text(gone).indexOf('高权限设备控制'), -1, '点过之后不该再显示')
  assert.equal(h1.store()[RISK_ACK_KEY_LOCAL], '1', '要把「认过了」记在本机')

  // 重挂（宿主重开面板）：仍然不显示
  const h2 = harness()
  h2.seedStore({ [RISK_ACK_KEY_LOCAL]: '1' })
  const remount = await h2.mount()
  assert.equal(text(remount).indexOf('高权限设备控制'), -1, '重开面板也不该再弹')
})

test('帮助页：完整风险告知 + 本地安全策略，正文不再占首屏', async () => {
  const h1 = harness()
  const tree = await h1.mount()
  seg(tree).props.onChange('help')
  await h1.settle()
  const help = h1.render()
  const all = text(help)
  assert.ok(cardTitled(help, '帮助'), '应当有「帮助」卡片')
  // 四条风险告知全在
  assert.match(all, /每个用户的凭据仍然加密落盘/)
  assert.match(all, /没有「管理员」这一级/)
  assert.match(all, /别人看不到你的凭据/)
  assert.match(all, /不要在任何群里发密码/)
  assert.match(all, /服务端说明：访问码 \/ token 等同于打印机控制权/)
  // 本地安全策略要点
  for (const label of ['本地安全策略', '每个用户一把独立密钥', '没有安全码', '控制面与摄像头要求先固定证书', '画面端口(322)单独核对', '云端用系统 CA', '会话到期自动清']) {
    assert.match(all, new RegExp(label.replace(/[()]/g, '\\$&')), '帮助页缺少：' + label)
  }
  // 命令速查也在，方便不记得命令的人
  assert.match(all, /\/打印机 状态/)
})

test('局域网兼容期：/lan/status 不存在时用 /overview 的 lan 凭据兜底并提示升级', async () => {
  const h1 = harness(undefined, {
    call: async (path) => {
      if (path === '/lan/status') return { ok: false, code: 'NOT_FOUND', message: '没有这条路由' }
      return undefined
    },
  })
  const tree = await pass(h1)
  const all = text(tree)
  assert.match(all, /当前模块版本不支持面板绑定，请升级/)
  assert.match(all, /01S\*\*\*\*789/, '应退回 /overview.users 里 mode=lan 的凭据')
  assert.equal(button(tree, '提交绑定'), undefined, '不支持的版本不该给绑定表单')
})

test('云端画面：检查 / 下载 BambuSource 沿用原逻辑', async () => {
  const h1 = harness()
  const tree = await gotoSettings(h1, await h1.mount())
  assert.match(text(tree), /下载 BambuSource 库/)
  await button(h1.render(), '下载 BambuSource 库').props.onClick()
  await h1.settle()
  assert.ok(h1.calls.some((c) => c.path === '/tutk/download'))
  const after = text(h1.render())
  assert.match(after, /已下载/)
  assert.match(after, /v2\.3\.0/)
  assert.match(after, /走了加速代理/)
  // 失败原因原样显示
  const h2 = harness(undefined, {
    call: async (path) => {
      if (path === '/tutk/download') return { ok: false, code: 'ALL_SOURCES_FAILED', message: '所有下载源都失败了，请手动下载' }
      return undefined
    },
  })
  const t2 = await gotoSettings(h2, await h2.mount())
  assert.match(text(t2), /下载 BambuSource 库/)
  await button(h2.render(), '下载 BambuSource 库').props.onClick()
  await h2.settle()
  assert.match(text(h2.render()), /所有下载源都失败了/)
})

test('源码层面：不碰任何查看秘密的路由，秘密只经 /lan/bind 与 /owner/unlock 提交', () => {
  for (const path of ["'/overview'", "'/lan/status'", "'/lan/bind'", "'/owner/unlock'", "'/owner/lock'", "'/audit'", "'/tutk/status'", "'/tutk/download'"]) {
    assert.ok(SOURCE.indexOf(path) >= 0, '缺少路由 ' + path)
  }
  assert.doesNotMatch(SOURCE, /\/secret|\/token|\/export|\/reveal-secret/)
  assert.doesNotMatch(SOURCE, /dangerouslySetInnerHTML|innerHTML/)
  assert.doesNotMatch(SOURCE, /保存设置按钮|save\(\{ *active/)
})