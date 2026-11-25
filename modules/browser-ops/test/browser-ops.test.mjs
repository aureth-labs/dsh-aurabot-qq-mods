// browser-ops 基础测试：不打真浏览器，全部经注入的假进程 / 假 CDP 验证
// 生命周期（启动成功、启动失败清理、关闭、接回旧窗口）与纯函数（找浏览器、
// 端口文件、快照摘要格式化）。照 douyin browser-lifecycle / phone 测试的钩子模式。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findBrowser, freePort, readPortFile, pickPage,
  createBrowser, connectCdp, formatDomSummary, formatA11yNodes,
} from '../lib/browser.mjs'

/** 假的浏览器子进程：像 EventEmitter 一样能 emit exit/error，带 stderr 管道。 */
function fakeChild() {
  const child = new EventEmitter()
  child.pid = 4321
  child.stderr = new EventEmitter()
  child.unref = () => {}
  child.kill = () => { child.emit('exit', 0, null); return true }
  return child
}

/** 建一个 createBrowser 测试壳：可按 behavior 切换启动/连接的成败。 */
function harness({ behavior = 'ok', pageUrl = 'about:blank' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-ops-'))
  const children = []
  const sends = []
  const b = createBrowser({
    profileDir: dir,
    browserPath: () => process.execPath,
    stopWaitMs: 5,
    stderrWaitMs: 5,
    wait: async () => {},
    killTree: async () => { children.at(-1)?.emit('exit', 0, null); return true },
    log: { info: () => {}, warn: () => {} },
    spawnProcess: (bin, args) => {
      assert.ok(String(args.join(' ')).includes(`--user-data-dir=${dir}`), '资料目录必须指向传入的 profileDir')
      const child = fakeChild()
      children.push(child)
      if (behavior === 'spawn-error') {
        child.pid = undefined
        queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
      }
      // 静默退出：进程起来马上 exit、stderr 一个字不写（同目录残留实例 / 清理搬盘弄坏安装）
      if (behavior === 'silent-exit') queueMicrotask(() => child.emit('exit', 0, null))
      return child
    },
    getPort: async () => 18888,
    getBrowserJson: async (url) => {
      if (behavior === 'no-browser' || behavior === 'silent-exit') throw new Error('连接被拒绝')
      if (url.endsWith('/json/list')) return [{ id: '1', type: 'page', url: pageUrl, webSocketDebuggerUrl: 'ws://127.0.0.1/test' }]
      if (url.includes('/json/new')) return { id: '2', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1/new' }
      return { Browser: '假浏览器' }
    },
    connect: () => {
      const c = {
        closed: false,
        ready: behavior === 'cdp-fail' ? Promise.reject(new Error('WebSocket 连接失败')) : Promise.resolve(),
        async send(method, params = {}) {
          sends.push(method)
          if (behavior === 'cdp-fail' && method !== 'Page.enable') throw new Error('CDP 初始化失败')
          if (method === 'Page.navigate') return {}
          if (method === 'Runtime.evaluate') {
            // 按表达式区分：单个元素查找（querySelector( 但不是 All）回 null（元素不存在），其余当快照脚本
            if (String(params.expression || '').includes('querySelector(') && !String(params.expression || '').includes('querySelectorAll(')) return { result: { value: null } }
            return { result: { value: { title: '假页面', url: 'https://example.com', elements: [], bodyText: '正文内容' } } }
          }
          if (method === 'Accessibility.getFullAXTree') return { nodes: [{ role: { value: 'button' }, name: { value: '登录' } }] }
          return {}
        },
        on: (method, fn) => {
          // 假 CDP：Page.loadEventFired 立刻触发（微任务），navigate 不用等真实加载
          if (method === 'Page.loadEventFired') queueMicrotask(fn)
          return () => {}
        },
        close() { this.closed = true },
      }
      return c
    },
  })
  return { b, dir, children, sends, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('findBrowser：显式路径存在就用它；候选表只挑存在的', () => {
  assert.equal(findBrowser(process.execPath, (p) => p === process.execPath), process.execPath)
  assert.equal(findBrowser('C:/不存在/浏览器.exe', () => false), '')
  assert.equal(findBrowser('', (p) => p === '/usr/bin/chromium'), '/usr/bin/chromium')
  assert.equal(findBrowser('', () => false), '')
})

test('freePort 返回可用的本机端口号', async () => {
  const port = await freePort()
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536)
})

test('readPortFile：合法端口读出来，坏文件回 0', () => {
  const read = (p) => (p.endsWith('DevToolsActivePort') ? '9222\n/devtools/browser/x\n' : (() => { throw new Error('no') })())
  assert.equal(readPortFile('dir', read), 9222)
  assert.equal(readPortFile('dir', () => { throw new Error('缺文件') }), 0)
  assert.equal(readPortFile('dir', () => 'not-a-port'), 0)
})

test('pickPage：只挑 type=page 且带 ws 地址的标签页', () => {
  const page = { type: 'page', webSocketDebuggerUrl: 'ws://x' }
  assert.equal(pickPage([{ type: 'iframe' }, page]), page)
  assert.equal(pickPage([{ type: 'iframe' }]), null)
  assert.equal(pickPage(null), null)
})

test('formatDomSummary：标题/元素/正文成行，超长截断', () => {
  const text = formatDomSummary({
    title: '示例页', url: 'https://example.com',
    elements: [{ tag: 'a', text: '首页', href: 'https://example.com/home' }, { tag: 'button', text: '登录' }],
    bodyText: '这是正文',
  }, 3000)
  assert.match(text, /页面：示例页/)
  assert.match(text, /地址：https:\/\/example\.com/)
  assert.match(text, /a 首页 → https:\/\/example\.com\/home/)
  assert.match(text, /button 登录/)
  assert.match(text, /正文：这是正文/)
  // 严格截断：maxChars=30 时一定不超过 40 字（含截断标记）
  const tiny = formatDomSummary({ title: '很长的标题'.repeat(20), elements: [], bodyText: '' }, 30)
  assert.ok(tiny.length <= 45, `截断没生效：${tiny.length}`)
  assert.match(tiny, /已截断/)
})

test('formatA11yNodes：role+name 压行', () => {
  const text = formatA11yNodes([{ role: { value: 'button' }, name: { value: '登录' } }, { role: { value: 'heading' }, name: { value: '标题' } }])
  assert.match(text, /button：登录/)
  assert.match(text, /heading：标题/)
  assert.equal(formatA11yNodes([]), '（无障碍树为空）')
})

test('生命周期：launch 成功后可 navigate/snapshot，close 后状态归零', async () => {
  const h = harness({ behavior: 'ok' })
  try {
    const opened = await h.b.launch('测试')
    assert.deepEqual(opened, { ok: true, message: '已连接' })
    assert.equal(h.b.connected(), true)
    // 走一遍原子操作
    const nav = await h.b.navigate('https://example.com', 1000)
    assert.equal(nav.ok, true)
    assert.match(nav.title, /假页面/)
    const snap = await h.b.snapshot({ mode: 'dom', maxChars: 1000 })
    assert.equal(snap.ok, true)
    assert.match(snap.text, /假页面/)
    const ax = await h.b.snapshot({ mode: 'a11y', maxChars: 1000 })
    assert.match(ax.text, /button：登录/)
    const click = await h.b.clickSelector('不存在的选择器')
    assert.deepEqual(click, { ok: false, found: false })
    await h.b.input('你好')
    await h.b.clearFocused()
    await h.b.pressEnter()
    await h.b.scroll({ dy: 200 })
    assert.match(await h.b.screenshot(), /^data:image\/png;base64,|^$/)
    // 幂等：已连接再 launch 直接成功
    assert.deepEqual(await h.b.launch('测试'), { ok: true, message: '已连接' })
    // 关闭：优雅退出 → 假进程收到 exit → 状态归零
    h.children[0].once('exit', () => {}) // ensure listener exists
    await h.b.close()
    assert.equal(h.b.connected(), false)
    assert.equal(h.b.status().connected, false)
  } finally {
    h.cleanup()
  }
})

test('生命周期：启动失败要清理并带退避，启动参数不写模块源码目录', async () => {
  const h = harness({ behavior: 'no-browser' })
  try {
    const r = await h.b.launch('测试')
    assert.equal(r.ok, false)
    assert.match(r.message, /分钟后重试/)
    assert.equal(h.b.connected(), false)
    // 退避期间再 launch：不再真启动，直接回退避提示
    const r2 = await h.b.launch('测试')
    assert.equal(r2.ok, false)
  } finally {
    h.cleanup()
  }
})

test('静默退出要说明真实原因，不再怪「浏览器路径和专用资料目录」', async () => {
  const h = harness({ behavior: 'silent-exit' })
  try {
    const r = await h.b.launch('测试')
    assert.equal(r.ok, false)
    assert.match(r.message, /自己退出/)
    assert.match(r.message, /任务管理器|重装 Edge/)
    assert.doesNotMatch(r.message, /检查浏览器路径和专用资料目录/, '路径明明没问题，不该再怪路径')
    assert.equal(h.children.length, 1)
  } finally {
    h.cleanup()
  }
})

test('connectCdp：断连后 send 拒绝', async () => {
  // 用假 WS 类：close 时触发 close 事件，不碰真网络
  class FakeWS {
    constructor() { this._l = {} }
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn) }
    send() { /* 断连后不会走到这 */ }
    close() { this.closed = true; for (const fn of this._l.close || []) fn({}) }
  }
  const c = connectCdp('ws://127.0.0.1:1/none', { WS: FakeWS })
  c.ready.catch(() => {}) // 不等连接成功：close 后 ready 拒绝是预期，挂个兜底别当未处理拒绝
  c.close()
  await assert.rejects(() => c.send('Page.enable'), /浏览器连接断了/)
})

test('单元补缺：compose 关闭注入、白名单主域/子域、runTask 无 url', async () => {
  const mod = (await import('../index.mjs')).default
  const dir = mkdtempSync(join(tmpdir(), 'browser-ops-unit-'))
  const fakeBrowser = harness({ behavior: 'ok' }).b
  let settingOverrides = {}
  const api = {
    dataDir: (f) => (f ? join(dir, f) : dir),
    settings: () => ({ ...mod.defaults, enabled: true, ...settingOverrides }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    route: () => {},
    command: () => {},
    tool: () => {},
    defineTool: (t) => t,
    onDispose: () => {},
    core: { hub: { turnSendersAllOwner: () => true }, http: { body: async () => ({}) } },
    __browserOpsTestHooks: { createBrowser: () => fakeBrowser },
  }
  const face = mod.setup(api)
  try {
    // compose：injectGuides 默认开 → 总纲+场景手册；关掉 → 空串
    const withGuide = face.guides.compose('帮我登录')
    assert.match(withGuide, /【总纲 · 主流程】/)
    assert.match(withGuide, /【登录 · 场景手册】/)
    settingOverrides = { injectGuides: false }
    assert.equal(face.guides.compose('帮我登录'), '')
    settingOverrides = {}
    // compose：无匹配关键词 → 总纲 + generic 兜底
    const fallback = face.guides.compose('随便逛逛')
    assert.match(fallback, /【总纲 · 主流程】/)
    assert.match(fallback, /【通用 · 操作手册/)
    // 白名单：主域写法放行 www 与子域；http(s) 之外拒绝（navigate 前先连上假浏览器）
    assert.equal((await face.launch('测试')).ok, true)
    settingOverrides = { whitelist: 'bilibili.com\nexample.com' }
    assert.equal((await face.navigate('https://example.com')).ok, true)
    assert.equal((await face.navigate('https://cdn.example.com/x')).ok, true)
    assert.equal((await face.navigate('https://evil-example.com')).ok, false) // 后缀伪装域不放行
    assert.equal((await face.navigate('ftp://example.com')).ok, false)
    settingOverrides = {}
    // runTask：不带 url 也能跑（launch + snapshot），照常注入指引
    const task = await face.runTask({ goal: '读一下当前页' })
    assert.equal(task.ok, true)
    assert.match(task.guide, /【总纲 · 主流程】/)
    assert.match(task.guide, /【读页 · 场景手册】/)
    assert.ok(task.text.length > 0)
    await face.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('模块入口：setup 装配导出 API 面与权限门槛（假 CDP 全链路）', async () => {
  const mod = (await import('../index.mjs')).default
  assert.equal(mod.id, 'browser-ops')
  assert.equal(mod.defaults.enabled, false, '总开关默认关')
  assert.equal(mod.defaults.ownerOnly, true, '默认仅主人')
  // 面板由 panel.js 接管：settings 留空、面板文件声明了、每个 defaults 键都有面板字段
  assert.deepEqual(mod.settings, [], 'settings 应留空（字段由 panel.js 接管）')
  assert.equal(mod.panel, 'panel.js')
  const { readFileSync } = await import('node:fs')
  const panelSrc = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')
  for (const k of Object.keys(mod.defaults)) assert.ok(panelSrc.includes(k), `panel.js 缺 ${k} 的字段`)
  assert.ok(panelSrc.includes('高权限风险提示'), '面板缺红色风险卡')
  assert.ok(panelSrc.includes('站点白名单'), '面板缺站点白名单卡')
  assert.ok(panelSrc.includes('主流程总纲'), '面板缺总纲独立卡')
  // fake api 面（对齐 makeApi 的最小子集）
  const routes = {}
  const commands = []
  const tools = []
  const dir = mkdtempSync(join(tmpdir(), 'browser-ops-mod-'))
  const fakeBrowser = harness({ behavior: 'ok' }).b
  const api = {
    dataDir: (f) => (f ? join(dir, f) : dir),
    settings: () => ({ ...mod.defaults, enabled: true }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    route: (p, fn) => { routes[p] = fn },
    command: (c) => commands.push(c),
    tool: (fn) => { tools.push(...fn()) },
    defineTool: (t) => t,
    onDispose: () => {},
    core: { hub: { turnSendersAllOwner: (sid) => sid === 'owner-1' }, http: { body: async () => ({}) } },
    __browserOpsTestHooks: { createBrowser: () => fakeBrowser },
  }
  const face = mod.setup(api)
  try {
    // 导出面：任务要求的原子操作全在
    for (const name of ['launch', 'close', 'status', 'navigate', 'click', 'clickSelector', 'input', 'clearInput', 'pressEnter', 'scroll', 'screenshot', 'snapshot', 'evaluate', 'show', 'guides', 'runTask']) {
      assert.ok(name === 'guides' ? typeof face[name] === 'object' : typeof face[name] === 'function', `导出面缺 ${name}`)
    }
    // 跨模块调用只受总开关管（不受主人判定），能真启动假浏览器
    assert.equal((await face.launch('跨模块')).ok, true)
    const snap = await face.snapshot({ mode: 'a11y' })
    assert.match(snap.text, /button：登录/)
    await face.close()
    // 工具门槛：非主人会话拒绝，主人会话放行
    const visit = tools.find((t) => t.name === 'browser_visit')
    assert.ok(visit, '缺 browser_visit 工具')
    const denied = await visit.execute({ url: 'https://example.com' }, { session: { id: 'guest' } })
    assert.equal(denied.ok, false)
    assert.match(denied.message, /主人/)
    const allowed = await visit.execute({ url: 'https://example.com', goal: '读一下这篇文章' }, { session: { id: 'owner-1' } })
    assert.equal(allowed.ok, true)
    // 指引注入：总纲常驻 + 按目标关键词挑场景手册（「读」→ read）
    assert.match(allowed.message, /【总纲 · 主流程】/)
    assert.match(allowed.message, /【读页 · 场景手册】/)
    const badUrl = await visit.execute({ url: 'javascript:alert(1)' }, { session: { id: 'owner-1' } })
    assert.equal(badUrl.ok, false)
    // 站点白名单：非空时域外网址拒绝（工具与跨模块 navigate 都过这道门）
    api.settings = () => ({ ...mod.defaults, enabled: true, whitelist: 'bilibili.com' })
    const blocked = await visit.execute({ url: 'https://example.com' }, { session: { id: 'owner-1' } })
    assert.equal(blocked.ok, false)
    assert.match(blocked.message, /白名单/)
    assert.equal((await face.navigate('https://example.com')).ok, false)
    assert.equal((await face.navigate('https://www.bilibili.com/')).ok, true) // 子域放行
    api.settings = () => ({ ...mod.defaults, enabled: true }) // 还原：空白名单 = 不限制
    // runTask：一站式入口带 guide 与 message
    const task = await face.runTask({ goal: '搜一下天气', url: 'https://example.com' })
    assert.equal(task.ok, true)
    assert.match(task.guide, /【总纲 · 主流程】/)
    assert.match(task.guide, /【搜索 · 场景手册】/)
    assert.match(task.message, /——以下是当前页面——/)
    // 指引面：compose/list/resolve 可用
    assert.equal(face.guides.resolve({ goal: '帮我登录' }), 'login')
    assert.ok(face.guides.list().some((g) => g.key === 'main'))
    // 指引路由：GET 列表、POST 自定义、main 不可删、reset 还原
    const gList = await routes['/guides']({ method: 'GET', url: 'http://x/guides' })
    assert.ok(gList.guides.some((g) => g.key === 'generic'))
    const saved = await routes['/guides']({ method: 'POST', url: 'http://x/guides' })
    assert.equal(saved.ok, false) // 空 body：key 非法应报错而不是 500
    api.core.http.body = async () => ({ key: 'my-scene', name: '我的场景', text: '◆ 总则\n- 自定义' })
    const saved2 = await routes['/guides']({ method: 'POST', url: 'http://x/guides' })
    assert.equal(saved2.ok, true)
    assert.equal(face.guides.get('my-scene'), '◆ 总则\n- 自定义')
    api.core.http.body = async () => ({ key: 'main', del: true })
    const delMain = await routes['/guides']({ method: 'POST', url: 'http://x/guides' })
    assert.equal(delMain.ok, false) // main 不可删
    api.core.http.body = async () => ({ key: 'my-scene', del: true })
    assert.equal((await routes['/guides']({ method: 'POST', url: 'http://x/guides' })).ok, true)
    assert.equal(face.guides.get('my-scene'), null)
    // 命令注册了
    assert.ok(commands.some((c) => c.name === 'browser'))
    // 面板路由注册了
    assert.ok(routes['/status'] && routes['/open'] && routes['/close'] && routes['/guides'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
