// 价格监控面板：总开关就在这一页里，而且只有一个。
// 和 Aurabot 面板加载 panel.js 的方式一致：整段函数体丢给 new Function，React 用最小 stub。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')

const STATE = {
  ok: true,
  enabled: true,
  busy: false,
  intervalMinutes: 60,
  lastRun: 0,
  lastResult: '还没检查过',
  watches: [],
  records: {},
  stats: { watches: 0, alerts: 0, checkedAt: 0, checks: 0 },
  window: { startHour: 0, endHour: 0 },
  whitelist: [],
}

const tick = () => new Promise((r) => setTimeout(r, 0))

const MEMORY = { ok: true, available: true, enabled: true, ttlMinutes: 30, ttlLabel: '30 分钟', items: [], importance: 0.45 }

function load (state = STATE, memory = MEMORY) {
  const values = []
  let index = 0
  const calls = []
  const effects = []
  let mounted = false
  const React = {
    useState: (initial) => {
      const i = index++
      if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial
      return [values[i], (v) => { values[i] = typeof v === 'function' ? v(values[i]) : v }]
    },
    useEffect: (fn) => { effects.push(fn) },
    useCallback: (fn) => fn,
  }
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false),
  })
  const ui = Object.fromEntries(['Card', 'Row', 'Btn', 'Select', 'Empty', 'Switch'].map((k) => [k, k]))
  const tracked = { memoryCalls: 0, lastMemoryPayload: null }
  const call = async (path, body) => {
    calls.push(path)
    if (path === '/state') return JSON.parse(JSON.stringify(state))
    if (path === '/memory') {
      if (!body) return JSON.parse(JSON.stringify(memory.value === undefined ? memory : memory.value))
      tracked.memoryCalls++
      tracked.lastMemoryPayload = body
      return { ok: true, message: '已删掉这条价格记忆。', items: [] }
    }
    return { ok: true, message: '完成' }
  }
  const Panel = new Function('React', 'h', 'ui', 'call', SOURCE)(React, h, ui, call)
  const render = (props) => {
    index = 0
    return Panel({ settings: {}, draftSettings: {}, setSettings: () => {}, save: async () => {}, toast: () => {}, ...props })
  }
  const mount = async (props) => {
    render(props)
    if (!mounted) { mounted = true; for (const fn of effects.splice(0)) fn(); await tick() }
    return render(props)
  }
  return { Panel, render, mount, calls, get memoryCalls () { return tracked.memoryCalls }, get lastMemoryPayload () { return tracked.lastMemoryPayload } }
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
  return [p.title, p.desc, p.text, p.label, p.placeholder].filter((x) => typeof x === 'string').join('') + (node.children || []).map(text).join('')
}
const switches = (tree) => walk(tree).filter((n) => n.type === 'Switch')

test('panel.js 求值后是一个组件函数，首屏能渲染出来', () => {
  const p = load()
  assert.equal(typeof p.Panel, 'function')
  assert.equal(typeof p.render(), 'object')
})

test('总开关就在价格监控卡片右上角，而且整页只有这一个', async () => {
  const p = load()
  const tree = await p.mount()
  const all = switches(tree)
  assert.equal(all.length, 1, '整页只该有一个开关，实际 ' + all.length + ' 个')
  // 它挂在标题为「价格监控」的 Card 的 right 上
  const card = walk(tree).find((n) => n.type === 'Card' && n.props && n.props.title === '价格监控')
  assert.ok(card, '要有「价格监控」卡片')
  assert.equal(card.props.right, all[0], '开关要在卡片右上角')
})

test('没有 enabled 这个键时按开处理（默认开）', async () => {
  const p = load()
  const tree = await p.mount()
  assert.equal(switches(tree)[0].props.on, true)
})

test('草稿里关掉后，开关显示关，页面给出「总开关关着」的提示', async () => {
  const p = load()
  const tree = await p.mount({ settings: {}, draftSettings: { enabled: false } })
  assert.equal(switches(tree)[0].props.on, false)
  assert.match(text(tree), /总开关关着/)
})

test('拨动开关会同时写 enabled 和 active（后者给标签页圆点）', async () => {
  const p = load()
  const patches = []
  const tree = await p.mount({ settings: {}, draftSettings: {}, setSettings: (x) => patches.push(x) })
  switches(tree)[0].props.onChange(false)
  assert.deepEqual(patches, [{ enabled: false }, { active: false }])
})

test('价格显示用数字，券后条件放括号里', () => {
  // 面板不能 import，只能按同一种函数体重算一遍
  const start = SOURCE.indexOf('function numOf')
  const end = SOURCE.indexOf('function toDate')
  assert.ok(start > 0 && end > start, '要能截到 yuan / priceOf / conditionOf')
  const build = new Function(SOURCE.slice(start, end) + '; return { priceOf, conditionOf }')
  const { priceOf } = build()
  assert.equal(priceOf({ price: 872, priceText: '872元（多人团）' }), '¥872（多人团）')
  assert.equal(priceOf({ price: 831.3, priceText: '过期 | 831.3元（需用券）' }), '¥831.3（需用券）')
  assert.equal(priceOf({ price: 872, priceText: '872元' }), '¥872')
  assert.equal(priceOf({ price: null, priceText: '价格未知' }), '价格未知')
  assert.equal(priceOf(null), '')
})

test('面板有「查价附带链接」开关（设置区展开后可见）', async () => {
  const p = load()
  // 设置区默认收起：先点「展开编辑」
  const collapsed = await p.mount()
  const openBtn = walk(collapsed).filter((n) => n.type === 'Btn').find((b) => b.children.includes('展开编辑'))
  assert.ok(openBtn, '要有展开编辑按钮')
  openBtn.props.onClick()
  const tree = await p.mount()
  assert.match(text(tree), /查价附带链接/)
  assert.equal(SOURCE.includes('queryShowLink'), true, '开关要写进设置草稿')
})

test('面板引用的接口路径都存在', () => {
  for (const path of ["'/state'", "'/search'", "'/add'", "'/remove'", "'/check'", "'/memory'"]) {
    assert.ok(SOURCE.includes(path), '缺少接口路径 ' + path)
  }
})

test('价格记忆卡片：读到记忆就列出来，并写明保留时长（默认 30 分钟）', async () => {
  const p = load(STATE, {
    path: '/memory',
    value: {
      ok: true,
      available: true,
      enabled: true,
      ttlMinutes: 30,
      ttlLabel: '30 分钟',
      items: [{ id: 'm1', text: '价格：任天堂 Switch 2，京东 ¥2999', at: 1763000000000, validUntil: 1763600000000 }],
    },
  })
  const tree = await p.mount({ settings: {}, draftSettings: { memoryTtlMinutes: 30 } })
  const all = text(tree)
  assert.match(all, /价格记忆（1）/)
  assert.match(all, /任天堂 Switch 2/)
  assert.match(all, /保留 30 分钟/)
  assert.match(all, /失效/)
})

test('价格记忆卡片：记忆里没有价格时给空状态提示', async () => {
  const p = load(STATE, { path: '/memory', value: { ok: true, available: true, enabled: true, ttlMinutes: 30, ttlLabel: '30 分钟', items: [] } })
  const tree = await p.mount()
  assert.match(text(tree), /记忆里还没有价格/)
})

test('价格记忆卡片：记忆模块不在跑时要说明，不能假装写进去了', async () => {
  const p = load(STATE, { path: '/memory', value: { ok: true, available: false, enabled: true, ttlMinutes: 30, ttlLabel: '30 分钟', items: [] } })
  const tree = await p.mount()
  assert.match(text(tree), /记忆模块没在跑/)
})

test('价格记忆：每条都能单独删，不必整页清空', async () => {
  const p = load(STATE, {
    path: '/memory',
    value: {
      ok: true, available: true, enabled: true, ttlMinutes: 30, ttlLabel: '30 分钟',
      items: [
        { id: 'm1', text: '价格：任天堂 Switch 2，京东 ¥2999', at: 1763000000000, validUntil: 1763600000000 },
        { id: 'm2', text: '价格：咖啡机，天猫 ¥900', at: 1762900000000, validUntil: 1763500000000 },
      ],
    },
  })
  const tree = await p.mount()
  const nodes = walk(tree)
  const rows = nodes.filter((n) => n.type === 'div' && n.props && n.props.className === 'ab-li')
  assert.equal(rows.length, 2, '两条记忆各一行')
  for (const [i, row] of rows.entries()) {
    assert.match(text(row), new RegExp('^' + (i + 1) + '\\. 价格：'))
    const buttons = walk(row).filter((n) => n.type === 'Btn')
    assert.ok(buttons.some((b) => b.children.includes('删除')), '第 ' + (i + 1) + ' 条要有删除按钮')
  }
  // 点「删除」先进确认态，不会立刻删
  const firstDelete = walk(rows[0]).filter((n) => n.type === 'Btn').find((b) => b.children.includes('删除'))
  firstDelete.props.onClick()
  const after = walk(await p.mount()).filter((n) => n.type === 'div' && n.props && n.props.className === 'ab-li')
  assert.match(text(after[0]), /确定吗/)
  assert.equal(p.memoryCalls, 0, '只是点开确认，还没真删')

  // 再点「确认删除」才发请求，且带的是这一条的 id
  const confirm = walk(after[0]).filter((n) => n.type === 'Btn').find((b) => b.children.includes('确认删除'))
  confirm.props.onClick()
  await tick()
  assert.equal(p.memoryCalls, 1)
  assert.deepEqual(p.lastMemoryPayload, { clear: true, id: 'm1' })
})

test('价格记忆卡片：关掉 memorySync 后说明不写记忆', async () => {
  const p = load(STATE, { path: '/memory', value: { ok: true, available: true, enabled: true, ttlMinutes: 30, ttlLabel: '30 分钟', items: [] } })
  const tree = await p.mount({ settings: {}, draftSettings: { memorySync: false } })
  assert.match(text(tree), /写进记忆.*关着/)
})
