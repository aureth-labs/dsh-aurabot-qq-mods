// 浏览器生命周期回归：用假进程和假 CDP 验证清理、锁、退避和来源，不启动真实浏览器。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, symlinkSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowser, connectCdp } from '../lib/browser.mjs'
import { createSite } from '../lib/site.mjs'

let createDouyin
let normalize
before(async () => {
  ;({ createDouyin } = await import('../lib/duty.mjs'))
  ;({ normalize } = globalThis.aurabot.lib('core/config.js'))
})

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function harness({ platform = 'linux', mode = 'timeout', wait, getPort, refuseStop = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dy-browser-'))
  const children = []
  const connections = []
  const kills = []
  const logs = []
  let clock = 1_000_000
  let behavior = mode
  let stubborn = refuseStop
  const browser = createBrowser({
    profileDir: dir,
    browserPath: () => process.execPath,
    now: () => clock,
    platform,
    stopWaitMs: 5,
    stderrWaitMs: 5,
    getPort: getPort || (async () => 18888),
    wait: wait || (async () => {}),
    log: { info: (s) => logs.push(['info', s]), warn: (s) => logs.push(['warn', s]) },
    spawnProcess: (_bin, _args, opts) => {
      const child = new EventEmitter()
      child.pid = 1000 + children.length
      child.stderr = new EventEmitter()
      child.unref = () => {}
      child.kill = (signal) => { kills.push(['child', child.pid, signal]); if (!stubborn) child.emit('exit', 0, signal); return true }
      children.push(child)
      assert.equal(opts.detached, true)
      assert.deepEqual(opts.stdio, ['ignore', 'ignore', 'pipe'])
      if (behavior === 'spawn-error') {
        child.pid = undefined
        queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
      }
      if (behavior === 'stderr-lock') queueMicrotask(() => {
        child.emit('exit', 1, null)
        setTimeout(() => {
          child.stderr.emit('data', 'The profile appears to be in use by another Chromium process')
          child.emit('close', 1, null)
        }, 1)
      })
      return child
    },
    getBrowserJson: async (url) => {
      if (behavior === 'timeout' || behavior === 'spawn-error' || behavior === 'stderr-lock') throw new Error('连接被拒绝')
      if (url.endsWith('/json/list')) return [{ id: '1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1/test' }]
      return { Browser: '假浏览器' }
    },
    connect: () => {
      const c = {
        closed: false,
        ready: behavior === 'cdp-ready-error' ? Promise.reject(new Error('WebSocket 连接失败')) : Promise.resolve(),
        async send(method) {
          if (behavior === 'cdp-command-error' && method === 'Runtime.enable') throw new Error('CDP 初始化失败')
          if (behavior === 'graceful' && method === 'Browser.close') children.at(-1).emit('exit', 0, null)
          return {}
        },
        close() { this.closed = true },
      }
      connections.push(c)
      return c
    },
    killGroup: (pid, signal) => { kills.push(['group', pid, signal]); if (!stubborn) children.find((c) => c.pid === pid)?.emit('exit', 0, signal) },
    killTree: async (pid) => { kills.push(['tree', pid]); if (!stubborn) children.find((c) => c.pid === pid)?.emit('exit', 0, 'SIGKILL'); return true },
  })
  return { dir, browser, children, connections, kills, logs, advance: (ms) => { clock += ms }, setMode: (v) => { behavior = v }, allowStop: () => { stubborn = false } }
}

test('启动超时和 CDP 连接 / 初始化失败时关闭自己启动的进程和连接', async () => {
  for (const platform of ['linux', 'win32']) {
    for (const mode of ['timeout', 'cdp-ready-error', 'cdp-command-error']) {
      const h = harness({ platform, mode })
      const r = await h.browser.open('定时')
      assert.equal(r.ok, false, `${platform} ${mode}`)
      assert.match(r.message, /5 分钟后重试/)
      assert.equal(h.children.length, 1)
      assert.deepEqual(h.kills, [platform === 'win32' ? ['tree', 1000] : ['group', 1000, 'SIGKILL']])
      if (mode.startsWith('cdp')) assert.equal(h.connections[0].closed, true)
      assert.equal(h.browser.connected(), false)
      assert.equal(h.logs.filter(([level]) => level === 'info').length, 1)
      assert.match(h.logs[0][1], /触发来源：定时/)
    }
  }
})

test('spawn 报错或同步抛错也退避，失败期间不会重复启动', async () => {
  const h = harness({ mode: 'spawn-error' })
  assert.match((await h.browser.open()).message, /spawn ENOENT/)
  assert.equal(h.children.length, 1)
  assert.equal(h.kills.length, 0, '进程没有创建成功，不杀其他进程')
  await h.browser.open('登录')
  assert.equal(h.children.length, 1)
  const thrown = createBrowser({
    profileDir: mkdtempSync(join(tmpdir(), 'dy-throw-')), browserPath: () => process.execPath,
    getPort: async () => 18888, spawnProcess: () => { throw new Error('spawn 同步失败') },
  })
  assert.match((await thrown.open()).message, /spawn 同步失败.*5 分钟/)
})

test('失败按 5、10、20、40、60、60 分钟退避；成功后重新从 5 分钟开始', async () => {
  const h = harness()
  for (const [i, minutes] of [5, 10, 20, 40, 60, 60].entries()) {
    const r = await h.browser.open('定时')
    assert.match(r.message, new RegExp(`${minutes} 分钟后重试`))
    assert.equal(h.children.length, i + 1)
    h.advance(minutes * 60_000 - 1)
    const blocked = await h.browser.open('主人要求')
    assert.equal(blocked.ok, false)
    assert.equal(h.children.length, i + 1)
    h.advance(1)
  }
  assert.deepEqual(h.logs.filter(([level]) => level === 'warn').map(([, line]) => Number(line.match(/；(\d+) 分钟/)[1])), [5, 10, 20, 40, 60, 60])
  h.setMode('success')
  assert.equal((await h.browser.open('登录')).ok, true)
  assert.equal(h.browser.connected(), true)
  await h.browser.close()
  h.setMode('timeout')
  assert.match((await h.browser.open('主人要求')).message, /5 分钟后重试/)
  assert.match(h.logs.filter(([level]) => level === 'info').at(-2)[1], /触发来源：登录/)
  assert.match(h.logs.filter(([level]) => level === 'info').at(-1)[1], /触发来源：主人要求/)
})

test('SingletonLock 即使是失效的符号链接也不能删除或启动；旧端口连不上就不接', async () => {
  const h = harness({ mode: 'success' })
  h.setMode('timeout')
  const lock = join(h.dir, 'SingletonLock')
  // Windows 环境没有创建符号链接权限时，用普通锁文件验证；Linux 专门覆盖悬空链接。
  if (process.platform === 'win32') writeFileSync(lock, '其他进程的锁')
  else symlinkSync('another-host-1234', lock)
  writeFileSync(join(h.dir, 'DevToolsActivePort'), '18888\n/devtools/browser/other\n')
  for (const minutes of [5, 10]) {
    const r = await h.browser.open('定时')
    assert.match(r.message, /资料目录被占用.*SingletonLock/)
    assert.match(r.message, new RegExp(`${minutes} 分钟后重试`))
    assert.equal(h.children.length, 0)
    assert.equal(h.kills.length, 0)
    assert.ok(lstatSync(lock))
    h.advance(minutes * 60_000)
  }
  await h.browser.close()
  assert.equal(h.kills.length, 0)
  assert.ok(lstatSync(lock))
  rmSync(lock)
  h.setMode('success')
  assert.equal((await h.browser.open('登录')).ok, true)
  await h.browser.close()
})

test('DSH 重启后接回资料目录里记录的窗口，不新开也不杀进程', async () => {
  const h = harness({ mode: 'success' })
  writeFileSync(join(h.dir, 'SingletonLock'), '上一次留下的窗口')
  writeFileSync(join(h.dir, 'DevToolsActivePort'), '18888\n/devtools/browser/aurabot\n')
  assert.equal((await h.browser.open('定时')).ok, true)
  assert.equal(h.children.length, 0)
  assert.equal(h.browser.connected(), true)
  await h.browser.close()
  assert.equal(h.kills.length, 0)
})

test('进程没有确认退出时不会重新连接或再启动，退出后才允许重试', async () => {
  const h = harness({ mode: 'cdp-command-error', refuseStop: true })
  const failed = await h.browser.open('定时')
  assert.match(failed.message, /无法确认自己启动的浏览器已退出/)
  h.advance(5 * 60_000)
  h.setMode('success')
  const blocked = await h.browser.open('登录')
  assert.match(blocked.message, /无法确认自己启动的浏览器已退出/)
  assert.equal(h.children.length, 1)
  assert.equal(h.connections.length, 1)
  h.advance(10 * 60_000)
  h.allowStop()
  assert.equal((await h.browser.open('主人要求')).ok, true)
  assert.equal(h.children.length, 2)
  await h.browser.close()
})

test('预先发现的目录锁在退避结束后可重试，关闭空闲浏览器不会卡住之后的清理', async () => {
  const h = harness({ mode: 'success' })
  const lock = join(h.dir, 'SingletonLock')
  writeFileSync(lock, 'locked')
  assert.match((await h.browser.open()).message, /5 分钟后重试/)
  rmSync(lock)
  h.advance(5 * 60_000)
  assert.equal((await h.browser.open()).ok, true)
  await h.browser.close()
  await h.browser.close()
  assert.equal((await h.browser.open()).ok, true)
  await h.browser.close()
  assert.equal(h.children.length, 2)
  assert.equal(h.kills.length, 2)
})

test('浏览器报 profile appears to be in use 时明确提示并退避', async () => {
  const h = harness({ mode: 'stderr-lock' })
  const r = await h.browser.open('定时')
  assert.match(r.message, /资料目录被占用.*profile appears to be in use/)
  assert.match(r.message, /5 分钟后重试/)
  assert.equal(h.kills.length, 0, '进程已自行退出，不对其他进程发信号')
  await h.browser.open('登录')
  assert.equal(h.children.length, 1)
})

test('已连上的自有浏览器优先正常关闭，失败时回退到进程树清理', async () => {
  const graceful = harness({ mode: 'graceful' })
  assert.equal((await graceful.browser.open()).ok, true)
  await graceful.browser.close()
  assert.equal(graceful.kills.length, 0)
  assert.equal(graceful.connections[0].closed, true)
  const fallback = harness({ mode: 'success', platform: 'win32' })
  assert.equal((await fallback.browser.open()).ok, true)
  await fallback.browser.close()
  assert.deepEqual(fallback.kills, [['tree', 1000]])
})

test('并发打开共用一次启动；连接断开后只接回自己启动的进程', async () => {
  const gate = deferred()
  const h = harness({ mode: 'success', wait: () => gate.promise })
  const first = h.browser.open('定时')
  const second = h.browser.open('登录')
  await new Promise((r) => setImmediate(r))
  assert.equal(h.children.length, 1)
  gate.resolve()
  assert.equal((await first).ok, true)
  assert.equal((await second).ok, true)
  assert.equal(h.logs.filter(([level]) => level === 'info').length, 1)
  h.connections[0].close()
  assert.equal((await h.browser.open('主人要求')).ok, true)
  assert.equal(h.children.length, 1)
  assert.equal(h.connections.length, 2)
  await h.browser.close()
  assert.equal(h.connections[1].closed, true)
  assert.deepEqual(h.kills, [['group', 1000, 'SIGKILL']])
})

test('启动中关闭会结束进程，端口分配期间关闭不会再 spawn', async () => {
  const gate = deferred()
  const h = harness({ mode: 'success', wait: () => gate.promise })
  const opening = h.browser.open('定时')
  await new Promise((r) => setImmediate(r))
  const closing = h.browser.close()
  gate.resolve()
  assert.equal((await opening).ok, false)
  await closing
  assert.deepEqual(h.kills, [['group', 1000, 'SIGKILL']])
  assert.equal(h.browser.connected(), false)
  assert.equal(h.logs.filter(([level]) => level === 'warn').length, 0, '主动关闭不计作启动失败')

  const port = deferred()
  const delayed = harness({ mode: 'success', getPort: () => port.promise })
  const pending = delayed.browser.open('定时')
  await new Promise((r) => setImmediate(r))
  const stop = delayed.browser.close()
  port.resolve(18888)
  assert.equal((await pending).ok, false)
  await stop
  assert.equal(delayed.children.length, 0)
})

test('同一轮事件循环里先打开再关闭，不会漏掉待启动的进程', async () => {
  const h = harness({ mode: 'success' })
  const opening = h.browser.open('定时')
  const closing = h.browser.close()
  assert.equal((await opening).ok, false)
  await closing
  assert.equal(h.children.length, 0)
  assert.equal(h.kills.length, 0)
  assert.equal(h.browser.connected(), false)
})

test('WebSocket 初始化中关闭会立刻结束等待并清理 CDP 命令', async () => {
  class FakeSocket {
    static last
    listeners = new Map()
    constructor() { FakeSocket.last = this }
    addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]) }
    emit(name, event = {}) { for (const fn of this.listeners.get(name) || []) fn(event) }
    send() {}
    close() { this.emit('close') }
  }
  const waiting = connectCdp('ws://fake', { WS: FakeSocket })
  waiting.close()
  await assert.rejects(waiting.ready, /连接断了/)
  const opened = connectCdp('ws://fake', { WS: FakeSocket })
  FakeSocket.last.emit('open')
  await opened.ready
  const pending = opened.send('Runtime.enable')
  opened.close()
  await assert.rejects(pending, /连接断了/)
})

function dutyHarness() {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'dy-duty-lifecycle-'))
  const cfg = normalize({ enabled: true, douyin: { enabled: true, autoBrowse: true, ownerDm: false, perRun: 1 } })
  cfg.speakUp.awakeFrom = 0
  cfg.speakUp.awakeTo = 24
  const attempts = []
  let closes = 0
  let isOpen = false
  let clock = 1_000_000
  const fake = {
    open: async (from, canStart) => { attempts.push([from, canStart()]); if (!canStart()) return { ok: false, message: '抖音已关闭' }; isOpen = true; return { ok: true } },
    connected: () => isOpen,
    close: async () => { closes++; isOpen = false },
    evaluate: async (expression) => {
      if (expression === 'location.href') return 'https://www.douyin.com/'
      if (expression.includes('/aweme/v1/web/user/profile/self/')) return { status: 200, text: JSON.stringify({ status_code: 0, user: { sec_uid: 'MS4wSELF', nickname: '她' } }) }
      if (expression.includes('/aweme/v1/web/tab/feed/')) return { status: 200, text: JSON.stringify({ status_code: 0, aweme_list: [] }) }
      return ''
    },
  }
  const dy = createDouyin({ getConfig: () => cfg, browser: fake, hub: {}, now: () => clock, log: { info() {}, warn() {}, debug() {} } })
  return { cfg, dy, attempts, closes: () => closes, advance: (ms) => { clock += ms } }
}

test('定时、主人操作、登录分别传递来源；关闭开关时保护登录，超时后关闭', async () => {
  const h = dutyHarness()
  await h.dy.tick()
  assert.deepEqual(h.attempts[0], ['定时', true])
  await h.dy.watch('7000000000000000001')
  assert.deepEqual(h.attempts[1], ['主人要求', true])
  h.cfg.douyin.enabled = false
  await h.dy.loginStep(true)
  assert.deepEqual(h.attempts[2], ['登录', true])
  await h.dy.tick()
  assert.equal(h.closes(), 0)
  assert.equal(h.dy.state().browserOpen, true)
  h.advance(5 * 60_000 - 1)
  await h.dy.tick()
  assert.equal(h.closes(), 0)
  h.advance(1)
  await h.dy.tick()
  assert.equal(h.closes(), 1)
  assert.equal(h.dy.state().browserOpen, false)
  await h.dy.tick()
  assert.equal(h.attempts.length, 3)
  await h.dy.account(true)
  assert.deepEqual(h.attempts[3], ['登录', true])
  h.dy.dispose()
  await new Promise((r) => setImmediate(r))
  assert.equal(h.closes(), 3, '模块卸载也会清理')
})

test('定时启动中关开关并开始登录，取消定时启动后会用登录来源重试', async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'dy-login-handoff-'))
  const cfg = normalize({ enabled: true, douyin: { enabled: true, autoBrowse: true, ownerDm: false, perRun: 1 } })
  cfg.speakUp.awakeFrom = 0
  cfg.speakUp.awakeTo = 24
  const gate = deferred()
  const h = harness({ mode: 'success', wait: () => gate.promise })
  const dy = createDouyin({ getConfig: () => cfg, browser: h.browser, hub: {}, log: { info() {}, warn() {}, debug() {} } })
  const scheduled = dy.tick()
  await new Promise((r) => setImmediate(r))
  cfg.douyin.enabled = false
  const login = dy.loginStep(true)
  await dy.tick()
  gate.resolve()
  await scheduled
  await login
  assert.equal(h.children.length, 2)
  assert.deepEqual(h.kills, [['group', 1000, 'SIGKILL']])
  assert.equal(h.browser.connected(), true)
  await h.browser.close()
})

test('登录动作进行中和最近五分钟保护浏览器；轮询、显示窗口会刷新保护期', async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'dy-login-grace-'))
  const cfg = normalize({ enabled: true, douyin: { enabled: false } })
  const gate = deferred(), started = deferred()
  let clock = 1000, closes = 0
  const site = {
    connected: () => true, close: async () => { closes++ },
    loginStart: async () => { started.resolve(); return gate.promise },
    loginPoll: async () => ({ ok: true, loggedIn: true, me: { secUid: 'me', nickname: '她' } }),
    ensure: async () => ({ ok: true }), show: async () => {},
  }
  const dy = createDouyin({ getConfig: () => cfg, site, hub: {}, now: () => clock, log: { warn() {} } })
  const pending = dy.loginStep(true)
  await started.promise
  clock += 10 * 60_000
  await dy.tick()
  assert.equal(closes, 0)
  gate.resolve({ ok: true, loggedIn: false, shot: 'QR' })
  await pending
  clock += 4 * 60_000
  await dy.loginStep(false)
  clock += 4 * 60_000
  assert.equal((await dy.showWindow(true)).ok, true)
  clock += 5 * 60_000 - 1
  await dy.tick()
  assert.equal(closes, 0)
  clock++
  await dy.tick()
  assert.equal(closes, 1)
})

test('扫码后仍有验证或探测失败时不宣告登录完成', async () => {
  let why = '请完成安全验证', selfCalls = 0
  const site = createSite({ browser: {
    connected: () => true, open: async () => ({ ok: true }),
    evaluate: async (expression) => {
      if (expression === 'location.href') return 'https://www.douyin.com/'
      if (expression.includes('captcha_container')) {
        if (why instanceof Error) throw why
        return why
      }
      if (expression.includes('/aweme/v1/web/user/profile/self/')) {
        selfCalls++
        return { status: 200, text: JSON.stringify({ status_code: 0, user: { sec_uid: 'me', nickname: '她' } }) }
      }
      return null
    },
    screenshot: async () => 'data:image/png;base64,QR',
  } })
  assert.equal((await site.loginPoll()).loggedIn, false)
  assert.equal(selfCalls, 0)
  assert.equal((await site.loginStart()).loggedIn, false)
  assert.equal(selfCalls, 1)
  why = new Error('探测失败')
  await assert.rejects(site.loginPoll(), /探测失败/)
  assert.equal(selfCalls, 1)
  why = ''
  assert.equal((await site.loginPoll()).loggedIn, true)
  assert.equal(selfCalls, 2)
})

test('定时启动中关闭开关会取消启动并清理自有进程，之后的 tick 不再启动', async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'dy-duty-cancel-'))
  const cfg = normalize({ enabled: true, douyin: { enabled: true, autoBrowse: true, ownerDm: false, perRun: 1 } })
  cfg.speakUp.awakeFrom = 0
  cfg.speakUp.awakeTo = 24
  const gate = deferred()
  const h = harness({ mode: 'success', wait: () => gate.promise })
  const dy = createDouyin({ getConfig: () => cfg, browser: h.browser, hub: {}, log: { info() {}, warn() {}, debug() {} } })
  const starting = dy.tick()
  await new Promise((r) => setImmediate(r))
  assert.equal(h.children.length, 1)
  cfg.douyin.enabled = false
  const closing = dy.tick()
  gate.resolve()
  await Promise.all([starting, closing])
  assert.deepEqual(h.kills, [['group', 1000, 'SIGKILL']])
  assert.equal(dy.state().browserOpen, false)
  await dy.tick()
  assert.equal(h.children.length, 1)
})

test('定时私信启动也标记为定时；忙碌时关闭开关仍先关闭浏览器', async () => {
  const h = dutyHarness()
  h.cfg.douyin.owner = { input: 'me', confirmedInput: 'me', secUid: 'MS4wME', uid: '123', nickname: '主人' }
  h.cfg.douyin.ownerDm = true
  await h.dy.tick()
  assert.deepEqual(h.attempts[0], ['定时', true])

  const gate = deferred()
  const busySite = {
    ensure: () => gate.promise, connected: () => true,
    close: async () => { busySite.closed = true },
  }
  const dy = createDouyin({ getConfig: () => h.cfg, site: busySite, hub: {}, log: { info() {}, warn() {}, debug() {} } })
  h.cfg.douyin.ownerDm = false
  const running = dy.run()
  h.cfg.douyin.enabled = false
  await dy.tick()
  assert.equal(busySite.closed, true)
  gate.resolve({ ok: false, message: '关闭了' })
  assert.equal((await running).ok, false)
})

test('ego 模式：open 走共享实例，show(true) 把窗口带到前台而不是空操作', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dy-ego-show-'))
  writeFileSync(join(dir, 'browser.json'), JSON.stringify({ port: 19999 }))
  const oldEnv = process.env.EGO_LINUX_STATE_DIR
  process.env.EGO_LINUX_STATE_DIR = dir
  const oldFetch = globalThis.fetch
  const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const closed = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/json/version')) return json({ Browser: '假 ego' })
    if (u.includes('/json/new')) return json({ id: 'ego-tab', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:19999/devtools/page/ego-tab' })
    if (u.includes('/json/close/')) { closed.push(u.split('/').pop()); return json({ OK: true }) }
    return json([])
  }
  t.after(() => {
    globalThis.fetch = oldFetch
    if (oldEnv === undefined) delete process.env.EGO_LINUX_STATE_DIR
    else process.env.EGO_LINUX_STATE_DIR = oldEnv
    rmSync(dir, { recursive: true, force: true })
  })

  const sent = []
  const browser = createBrowser({
    profileDir: join(dir, 'unused-profile'),
    useEgo: () => true,
    getPort: async () => { throw new Error('ego 模式不该分配端口') },
    spawnProcess: () => { throw new Error('ego 模式不该 spawn 专用浏览器') },
    connect: () => ({
      closed: false,
      ready: Promise.resolve(),
      async send(method, params) { sent.push([method, params]); return {} },
      close() { this.closed = true },
    }),
  })
  assert.equal((await browser.open('登录')).ok, true)
  assert.ok(sent.some(([m]) => m === 'Network.enable'), 'ego 模式要开 Network（等接口回执用）')

  // 回归点：这里曾是 `if (egoTarget) return` 的空操作。面板「显示浏览器窗口」点了
  // 没任何反应，主人没法在共享窗口里扫码 / 过安全验证，登录永远完不成，
  // 模块就一直报「抖音还没登录」，看起来像「开了侧边浏览器却不使用侧边浏览器」。
  sent.length = 0
  await browser.show(true)
  // 「显示」= 把共享窗口从屏幕外 (-2400,-2400) 挪回屏幕内 + 带到前台 + 切到本模块标签页
  assert.deepEqual(sent.map(([m]) => m),
    ['Browser.getWindowForTarget', 'Browser.setWindowBounds', 'Browser.setWindowBounds', 'Page.bringToFront'],
    '「显示」= 挪回屏幕内（normal + 80,60）+ bringToFront')
  assert.deepEqual(sent[1][1], { windowId: undefined, bounds: { windowState: 'normal' } })

  sent.length = 0
  await browser.show(false)
  // 「收起」= 把窗口挪回屏幕外（不杀进程、不关别人标签页）
  assert.deepEqual(sent.map(([m]) => m),
    ['Browser.getWindowForTarget', 'Browser.setWindowBounds'],
    '「收起」= 挪回屏幕外 (-2400,-2400)')
  assert.deepEqual(sent[1][1], { windowId: undefined, bounds: { left: -2400, top: -2400 } })

  await browser.close()
  assert.deepEqual(closed, ['ego-tab'], 'close 只关自己认领的标签页，不碰别人的')
})
