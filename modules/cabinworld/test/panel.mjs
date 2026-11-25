// 面板脚本：语法、形状、挂载后真的请求了哪些路径、call 抛错时有没有错误文案。
// 用法：node test/panel.mjs
// 这里只有一个「一次挂载 + 一次重渲染」的极简 React 桩，不是完整状态机。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mod from '../index.mjs'
import { GAME_DIR, BRIDGE_JSON } from './_dirs.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const code = fs.readFileSync(path.join(here, '..', 'panel.js'), 'utf8')
const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}

// ---- index.mjs 真正注册了哪些面板路由（面板请求的路径必须都在里面） --------------------------
const registered = new Set()
const probe = {
  id: mod.id, version: '1.2.1', apiVersion: 1, source: 'user', dir: process.cwd(),
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  settings: () => ({ gameDir: path.join(process.env.TEMP || '.', 'cabinworld-panel-not-installed'), waitMs: 30000, writeMemory: false }),
  defineTool: (spec) => ({ ...spec }),
  tool: () => () => {},
  rule: () => () => {},
  context: () => () => {},
  every: () => () => {},
  on: () => () => {},
  command: () => () => {},
  route: (p) => { registered.add(p); return () => {} },
  use: () => null,
  send: async () => {},
  config: () => ({ ownerQQ: '', ownerName: '' }),
  core: { hub: { turnSendersAllOwner: () => true }, http: { send: () => {}, body: async () => ({}) } },
  dataDir: () => process.env.TEMP || '.',
}
await mod.setup(probe)
ok(registered.size > 0, 'index.mjs 注册了面板路由', registered.size + ' 个')

// ---- 极简 React：useState 真的存值（重渲染能读到），useEffect 挂载时跑一次 ------------------
const store = []
let cursor = 0
let effects = []
const React = {
  useState: (init) => {
    const at = cursor++
    if (!(at in store)) store[at] = typeof init === 'function' ? init() : init
    return [store[at], (v) => { store[at] = typeof v === 'function' ? v(store[at]) : v }]
  },
  useEffect: (fn) => { effects.push(fn) },
  useRef: (init) => {
    const at = cursor++
    if (!(at in store)) store[at] = { current: init }
    return store[at]
  },
  createElement: (type, props, ...children) => ({ type, props, children }),
}
const h = React.createElement
const ui = { Card: 'Card', Btn: 'Btn', Row: 'Row', Switch: 'Switch', Empty: 'Empty', Select: 'Select' }

// ---- call 桩：记录每次请求的路径，按路径给形状对得上的数据（不再是同一个对象） --------------
const requested = []
let healthFails = false
const answers = {
  '/health': { ok: true, game: true, installed: true, url: 'http://127.0.0.1:18790', advanced: { tools: { sleep: true, toolpose: true } }, install: { phase: 'idle', percent: 0 }, pendingRestart: null },
  '/memory-log': { ok: true, items: [{ at: 1700000000000, label: '荡秋千', text: '在小屋世界荡了会儿秋千' }] },
  '/auto-life/state': { ok: true, enabled: true, state: { count: 3 } },
  '/bridge-config': { bridgeName: '漪漪凛', personaName: '漪漪凛', qqNickname: '漪漪凛', same: true, config: { port: 18790, launchGame: true, weatherMode: 'virtual' } },
  '/update': { ok: true, release: '1.1', modules: [{ id: 'sleep', name: '睡觉', summary: '能躺下睡觉', state: 'on' }] },
  '/models': { ok: true, models: [{ provider: 'deepseek', model: 'deepseek-chat', name: 'deepseek-chat' }] },
}
const call = async (p) => {
  requested.push(p)
  if (healthFails && p === '/health') throw new Error('桥没在跑（测试桩故意抛错）')
  return answers[p] || { ok: true }
}
const toast = () => {}
const save = async (patch) => ({ ok: true, patch })

let factory
try {
  factory = new Function('React', 'h', 'ui', 'call', 'toast', code)
} catch (error) {
  ok(false, 'panel.js 语法', error.message)
  process.exit(1)
}
ok(true, 'panel.js 语法')

let Comp
try {
  Comp = factory(React, h, ui, call, toast)
} catch (error) {
  ok(false, 'panel.js 执行', error.message)
  process.exit(1)
}
ok(typeof Comp === 'function', '返回了组件函数')

function draw() {
  cursor = 0
  return Comp({ settings: { gameDir: GAME_DIR, bridgeJson: BRIDGE_JSON, waitMs: 30000 }, save: save, toast: toast })
}

// 挂载：渲染一次 → 跑 useEffect → 等请求落地 → 带着 state 再渲染一次
async function mount() {
  store.length = 0
  const first = draw()
  const cleanups = []
  for (const fn of effects.splice(0)) {
    const out = fn()
    if (typeof out === 'function') cleanups.push(out)
  }
  await new Promise((r) => setTimeout(r, 50))
  const tree = draw()
  return { first, tree, cleanups }
}

// 把树里的文字摊平，用来断言「文案真的出现在面板上」
function texts(node, acc) {
  const out = acc || []
  if (node == null || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) texts(c, out); return out }
  if (typeof node === 'object') {
    const props = node.props || {}
    for (const key of ['title', 'desc']) if (typeof props[key] === 'string') out.push(props[key])
    if (node.children) texts(node.children, out)
  }
  return out
}

const mounted = await mount()
try {
  ok(mounted.tree && (mounted.tree.type === 'Card' || mounted.tree.type === 'div'), '组件能渲染出元素树', String(mounted.tree && mounted.tree.type))
  const kids = (mounted.tree && mounted.tree.children) || []
  ok(kids.length >= 6, '单卡里有状态/按钮/设置', String(kids.length) + ' 个子节点')

  const all = texts(mounted.tree).join('\n')
  ok(all.indexOf('荡了会儿秋千') >= 0, '记忆条目来自 /memory-log', '')
  ok(all.indexOf('漪漪凛') >= 0, '桥名字来自 /bridge-config')

  const uniq = [...new Set(requested)]
  const unknown = uniq.filter((p) => !registered.has(p))
  ok(unknown.length === 0, '面板请求的路径都在注册路由里', unknown.length ? '多出：' + unknown.join(',') : uniq.length + ' 个路径都对得上')
  const musts = ['/health', '/memory-log', '/auto-life/state', '/bridge-config', '/update', '/models']
  const missing = musts.filter((p) => uniq.indexOf(p) < 0)
  ok(missing.length === 0, '挂载时请求了状态/记忆/自动生活/桥配置/可选内容/模型', missing.length ? '缺 ' + missing.join(',') : uniq.join(','))
} finally {
  for (const fn of mounted.cleanups) fn()
}

// call 抛错：顶部（状态行下面那句 msg）必须出现错误文案，不能静默失败
healthFails = true
const broken = await mount()
try {
  const all = texts(broken.tree).join('\n')
  const line = all.split('\n').filter((l) => /取状态失败/.test(l))[0] || ''
  ok(/取状态失败/.test(all), 'call 抛错时面板上有错误文案', line.slice(0, 60))
} finally {
  for (const fn of broken.cleanups) fn()
}

// ---- 静态校验：面板对「写路由」的调用必须带 body（也就是走 POST） ----------------------------
// 运行时的 call 桩看不出方法，所以直接比源码：index.mjs 里 handler 含 assertPost 的路由，
// panel.js 调它时必须给第二个参数。0.4.4 把 /update 改成 POST，这条能防住「面板还用 GET 打回 405」。
const indexSrc = fs.readFileSync(path.join(here, '..', 'index.mjs'), 'utf8')
function routeRequiresPost(routePath) {
  const start = indexSrc.indexOf("api.route('" + routePath + "'")
  if (start < 0) return false
  const next = indexSrc.indexOf("api.route('", start + 12)
  const block = indexSrc.slice(start, next < 0 ? indexSrc.length : next)
  return /\bassertPost\b/.test(block)
}
const panelCalls = []
const callRe = /call\('([^']+)'(\s*,)?/g
let hit = null
while ((hit = callRe.exec(code)) !== null) panelCalls.push({ path: hit[1], hasBody: Boolean(hit[2]) })
const postRoutes = [...registered].filter(routeRequiresPost)
const bodyMissing = panelCalls.filter((c) => postRoutes.indexOf(c.path) >= 0 && !c.hasBody)
ok(postRoutes.length > 0, 'index.mjs 里有要求 POST 的写路由', postRoutes.join('、'))
ok(bodyMissing.length === 0, '面板调写路由都带了 body（走 POST）', bodyMissing.length ? '缺 body：' + bodyMissing.map((c) => c.path).join('、') : postRoutes.length + ' 条写路由都对得上')
const staticUnknown = [...new Set(panelCalls.map((c) => c.path))].filter((p) => !registered.has(p))
ok(staticUnknown.length === 0, '面板里出现的每个路径都有对应路由（静态）', staticUnknown.length ? '多出：' + staticUnknown.join('、') : panelCalls.length + ' 处调用都对得上')

// action() 工厂把路径当参数传进去，call() 那边看到的是变量 path，上面的正则扫不到——
// /start、/game/show、/game/hide 这三条写路由必须单独验：路径要在路由表里，
// 且工厂内部调用时仍然带着 body（否则就是 GET 打 POST 路由）。
const actionPaths = []
const actionRe = /action\('([^']+)'/g
let ah = null
while ((ah = actionRe.exec(code)) !== null) actionPaths.push(ah[1])
ok(actionPaths.length > 0, '面板里有 action() 包装的调用', actionPaths.join('、'))
ok(/call\(path, \{\}\)/.test(code), 'action() 内部调 call 时带 body（走 POST）')
const actionUnknown = actionPaths.filter((p) => !registered.has(p))
ok(actionUnknown.length === 0, 'action() 的路径都有对应路由', actionUnknown.length ? '多出：' + actionUnknown.join('、') : actionPaths.length + ' 条')
const notPost = actionPaths.filter((p) => postRoutes.indexOf(p) < 0)
ok(notPost.length === 0, 'action() 包的都是写路由', notPost.length ? '这些不是：' + notPost.join('、') : actionPaths.join('、'))
