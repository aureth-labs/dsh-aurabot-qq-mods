// 从 feat/mobile-app 的 mobile-parity.test.js 迁移；运行方式见模块 README。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Script, createContext, runInContext } from 'node:vm'
import { botIdOf, mobileTtsPort, mobileUploadDir } from '../lib/service.mjs'
import { hostTest, createMobileService, version } from './helpers.mjs'

const webFile = (name) => readFileSync(new URL('../assets/web/' + name, import.meta.url), 'utf8')

hostTest('App 设置协议：实际 TTS 端口、版本和 DSH 会话；退出仅撤销当前设备并落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-parity-'))
  const token = 'phone-one', other = 'phone-two', owner = '10001'
  const devices = [token, other].map((value, i) => ({ id: 'device-' + i, tokenHash: createHash('sha256').update(value).digest('hex') }))
  writeFileSync(join(dir, 'devices.json'), JSON.stringify({ ownerQQ: owner, options: { enabled: true }, devices }))
  const config = { ownerQQ: owner, group: { wakeWords: ['她', '小鱼'] }, voice: { engine: 'gptsovits', gptsovits: { url: 'http://user:secret@127.0.0.1:9880/api?key=private' } } }
  const service = createMobileService({ dir, config: () => config, use: () => null, hub: { sessions: () => ({ 'private:10001': { sessionId: 'dsh-real-id', title: '主人' }, 'system:owner': { sessionId: 'hidden' } }), chatLogDays: () => [], chatLogOf: () => [] } })
  const request = (url, method = 'GET', credential = token) => service.handle({ url, method, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:32180', ...(credential ? { 'x-aurabot-token': credential } : {}) } })
  try {
    assert.deepEqual((await request('/api/mobile/settings')).body, { wakeWord: '她、小鱼', ttsPort: 9880, version })
    assert.deepEqual((await request('/api/mobile/sessions')).body, { sessions: [{ id: 'dsh-real-id', title: '主人', subtitle: 'private:10001' }] })
    const bot = (await request('/api/mobile/bots')).body.bots[0]
    assert.equal(bot.id, botIdOf('private:10001')); assert.equal(bot.ttsPort, 9880)
    assert.ok(!JSON.stringify(bot).includes('secret'))
    config.voice.enabled = false
    assert.equal((await request('/api/mobile/settings')).body.ttsPort, '未配置')
    assert.ok(!('ttsPort' in (await request('/api/mobile/bots')).body.bots[0]))
    await assert.rejects(request('/api/mobile/logout', 'POST', null), { status: 401 })
    await assert.rejects(request('/api/mobile/logout', 'GET'), { status: 405 })
    assert.deepEqual((await request('/api/mobile/logout', 'POST')).body, { ok: true })
    await assert.rejects(request('/api/mobile/settings'), { status: 401 })
    assert.equal((await request('/api/mobile/settings', 'GET', other)).body.version, version)
    const disk = JSON.parse(readFileSync(join(dir, 'devices.json'), 'utf8'))
    assert.deepEqual(disk.devices.map((d) => d.id), ['device-1'])
    assert.ok(!JSON.stringify(disk).includes(other))
  } finally { await service.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

hostTest('证书错误不覆盖已有设置；关闭入口时脚本不可访问', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-parity-tls-'))
  const service = createMobileService({ dir, config: () => ({ ownerQQ: '1' }), use: () => null, hub: { sessions: () => ({}) } })
  try {
    await service.configure({ port: 32181, publicUrl: 'http://localhost:32181' })
    const before = service.status().options
    await assert.rejects(service.configure({ port: 32182, tlsCert: join(dir, 'missing.crt') }), { status: 400, code: 'tls_incomplete' })
    assert.deepEqual(service.status().options, before)
    const cert = join(dir, 'bad.crt'), key = join(dir, 'bad.key')
    writeFileSync(cert, 'not a PEM certificate'); writeFileSync(key, 'not a PEM key')
    await assert.rejects(service.configure({ tlsCert: cert, tlsKey: key }), { status: 400, code: 'invalid_tls' })
    assert.deepEqual(service.status().options, before)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'devices.json'))).options, before)
    for (const path of ['/mobile.js', '/sw.js']) {
      const req = { url: path, method: 'GET', headers: { host: 'localhost:32181' }, socket: { remoteAddress: '127.0.0.1' } }
      await assert.rejects(service.handle(req), { status: 503 })
    }
  } finally { await service.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('TTS 不杜撰端口；上传目录拒绝绝对路径、穿越和 Windows 特殊名字', () => {
  assert.equal(mobileTtsPort({ voice: { engine: 'cosyvoice', cosyvoice: { url: 'http://127.0.0.1:50000' } } }), 50000)
  assert.equal(mobileTtsPort({ voice: { engine: 'http', http: { urlTemplate: 'https://example.com/tts?text={text}' } } }), 443)
  for (const voice of [{ engine: 'edge' }, { engine: 'auto' }, { engine: 'http', http: { urlTemplate: 'file:///private' } }, { enabled: false, engine: 'gptsovits', gptsovits: { url: 'http://localhost:9880' } }]) assert.equal(mobileTtsPort({ voice }), null)
  for (const dir of ['', 'phone/photos', '手机/图片 1']) assert.equal(mobileUploadDir(dir), dir)
  for (const dir of ['../escape', 'a/../b', '/absolute', 'C:/outside', 'a\\b', 'a//b', '.', '..', 'con', 'LPT1.txt', 'a.', 'a ', 'a/aux', 'x'.repeat(161), {}, 42]) assert.throws(() => mobileUploadDir(dir), { status: 400 })
})

// Small DOM/capability harness exercises the shipped browser scripts.
function browser(overrides = {}, fullPage = false) {
  const elements = new Map(), stored = new Map(), navigations = [], events = new Map()
  const element = () => ({ value: '', textContent: '', innerHTML: '', hidden: false, open: false, style: { setProperty() {} }, dataset: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, querySelectorAll: () => [], setPointerCapture() {}, showModal() { this.open = true }, close() { this.open = false } })
  const $ = (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) }
  const context = createContext({ $, URL, URLSearchParams, Map, Set, JSON, Blob, FormData, performance, console,
    setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    window: { isSecureContext: true, MediaRecorder: true }, navigator: {},
    location: { origin: 'https://phone.example', search: '', pathname: '/', assign: (url) => navigations.push(url) }, history: { replaceState() {} },
    document: { hidden: false, getElementById: $, querySelectorAll: () => [], addEventListener() {} }, addEventListener: (name, fn) => events.set(name, fn),
    localStorage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
    store: { get: (key) => stored.get(key) || null, set: (key, value) => value == null ? stored.delete(key) : stored.set(key, value) },
    show() {}, loadBots: async () => {}, openChat: async () => {}, authed: async () => '', setAv() {}, toast() {}, api: async () => ({}), pair: async () => {}, start: async () => {}, logout() {}, renderMsgs() {}, stopPlayback() {}, ...overrides })
  if (fullPage) {
    const inline = [...webFile('index.html').matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1]
    runInContext(inline, context)
  } else runInContext("let token = null, current = null, sessionEpoch = 0, ws = null; const bots = [], unread = new Map(), msgs = new Map(), typing = new Set(); const esc = String; const text = {value:''}", context)
  runInContext(webFile('mobile.js'), context)
  return { context, elements, $, stored, navigations, events }
}

test('浏览器扫码解析 JSON/URL；换服务器仅导航，不把旧 token 发往新来源', () => {
  const b = browser()
  assert.equal(runInContext("parsePairing('{\"url\":\"https://other.example\",\"code\":\"abc\"}').url", b.context), 'https://other.example')
  assert.equal(runInContext("parsePairing('https://other.example/?code=abc').code", b.context), 'abc')
  for (const value of ['javascript:alert(1)', 'https://x.example/', '{"url":"https://x.example","code":""}', 'https://user:secret@x.example/?code=abc']) assert.throws(() => runInContext(`parsePairing(${JSON.stringify(value)})`, b.context))
  runInContext("token = 'old-secret'; goToServer('https://other.example:32180', 'new-code')", b.context)
  assert.equal(b.navigations[0], 'https://other.example:32180/?code=new-code')
  assert.ok(!b.navigations[0].includes('old-secret'))
})

test('HTTP 保留录音入口并提示主人配置 HTTPS；不尝试申请麦克风', async () => {
  let requests = 0
  const b = browser({ window: { isSecureContext: false }, navigator: { mediaDevices: { getUserMedia: () => { requests++; throw new Error('must not request') } } } })
  runInContext("current = {id:'bot'}; token = 'token'", b.context)
  await b.$('micBtn').onpointerdown({ preventDefault() {}, pointerId: 1 })
  assert.equal(requests, 0)
  assert.match(b.$('recordInfo').textContent, /HTTPS/)
  assert.match(b.$('recordInfo').textContent, /证书/)
  assert.equal(b.$('micBtn').hidden, false)
  assert.match(b.$('notificationInfo').textContent, /HTTPS/)
})

test('麦克风授权期间松手，权限返回后释放轨道，不启动录音或上传', async () => {
  let resolvePermission, stopped = 0, constructed = 0
  const permission = new Promise((resolve) => { resolvePermission = resolve })
  const b = browser({ navigator: { mediaDevices: { getUserMedia: () => permission } }, MediaRecorder: class { constructor() { constructed++ } } })
  runInContext("current = {id:'original'}; token = 'token'", b.context)
  const pending = b.$('micBtn').onpointerdown({ preventDefault() {}, pointerId: 7 })
  b.$('micBtn').onpointerup({ pointerId: 7 })
  resolvePermission({ getTracks: () => [{ stop() { stopped++ } }] })
  await pending
  assert.equal(stopped, 1); assert.equal(constructed, 0)
  assert.equal(runInContext('recording', b.context), null)
})

test('HTTPS 录音按捕获的目标上传并释放麦克风；取消时不上传', async () => {
  let clock = 0, stopped = 0, completion
  const uploads = []
  class Recorder {
    static isTypeSupported = () => true
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm' }
    start() { this.state = 'recording' }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['audio']) }); completion = this.onstop() }
  }
  const b = browser({ navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped++ } }] }) } }, MediaRecorder: Recorder, performance: { now: () => clock }, api: async (path, options) => { uploads.push(options.body) } })
  runInContext("current = {id:'original'}; token = 'token'", b.context)
  await b.$('micBtn').onpointerdown({ preventDefault() {}, pointerId: 7 })
  clock = 1200
  b.$('micBtn').onpointerup({ pointerId: 7 }); await completion
  assert.equal(uploads.length, 1); assert.equal(uploads[0].get('botId'), 'original')
  assert.equal(uploads[0].get('durationMs'), '1200'); assert.equal(stopped, 1)
  await b.$('micBtn').onpointerdown({ preventDefault() {}, pointerId: 8 })
  runInContext('cancelRecording()', b.context); await completion
  assert.equal(uploads.length, 1); assert.equal(stopped, 2)
})

test('实际页面脚本共同加载；切换 Bot 后草稿分别恢复，发送清空原会话草稿', async () => {
  const b = browser({}, true)
  runInContext("bots = [{id:'one',name:'一'}, {id:'two',name:'二'}]; api = async () => ({messages:[]})", b.context)
  await runInContext("openChat('one')", b.context)
  b.$('text').value = '第一份草稿'; b.$('text').oninput()
  await runInContext("openChat('two')", b.context)
  assert.equal(b.$('text').value, '')
  b.$('text').value = '第二份草稿'; b.$('text').oninput()
  await runInContext("openChat('one')", b.context)
  assert.equal(b.$('text').value, '第一份草稿')
  await b.$('composer').onsubmit({ preventDefault() {} })
  assert.equal(b.stored.has('aurabot.draft.one'), false)
  assert.equal(b.stored.get('aurabot.draft.two'), '第二份草稿')
})

test('实际页面的旧回放和重复帧不增加未读；后台新消息通知点击可路由', async () => {
  const notifications = [], opened = []
  class Notification {
    static permission = 'granted'
    constructor(title, options) { this.title = title; this.options = options; notifications.push(this) }
    close() { this.closed = true }
  }
  const b = browser({ window: { isSecureContext: true, Notification, focus: () => opened.push('focus') }, Notification }, true)
  runInContext("var routedBot = null; bots = [{id:'one',name:'她'}]; token = 'valid'; document.hidden = true; openNotificationChat = async (id) => { routedBot = id }", b.context)
  const old = { id: 'old', botId: 'one', kind: 'text', text: '旧回放', at: 1, mine: false }
  b.context.inputMessage = old
  runInContext('push(inputMessage)', b.context)
  assert.equal(runInContext("unread.get('one') || 0", b.context), 0)
  const next = { ...old, id: 'new', text: '新消息', at: Date.now() + 1000 }
  b.context.inputMessage = next
  runInContext('push(inputMessage); push(inputMessage)', b.context)
  await Promise.resolve()
  assert.equal(runInContext("unread.get('one')", b.context), 1)
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].title, '她'); assert.equal(notifications[0].options.body, '新消息')
  notifications[0].onclick()
  assert.equal(b.context.routedBot, 'one'); assert.deepEqual(opened, ['focus'])
})

test('通知 worker 点击已有窗口聚焦并直达对应 Bot，无窗口则打开同源地址', async () => {
  for (const hasWindow of [true, false]) {
    const listeners = {}, calls = []
    const client = { url: 'https://phone.example/', focus: async () => calls.push('focus'), postMessage: (message) => calls.push(message) }
    const self = { location: { origin: 'https://phone.example' }, addEventListener: (event, fn) => { listeners[event] = fn }, clients: { matchAll: async () => hasWindow ? [client] : [], openWindow: async (url) => calls.push(url), claim: async () => {} }, skipWaiting: async () => {} }
    runInContext(webFile('sw.js'), createContext({ self, URL }))
    let done, closed = false
    listeners.notificationclick({ notification: { data: { botId: 'c_abc' }, close() { closed = true } }, waitUntil: (promise) => { done = promise } })
    await done
    assert.equal(closed, true)
    if (hasWindow) { assert.equal(calls[0], 'focus'); assert.equal(calls[1].type, 'open-chat'); assert.equal(calls[1].botId, 'c_abc') }
    else assert.equal(calls[0], 'https://phone.example/?botId=c_abc')
    assert.ok(!listeners.fetch, 'worker 不拦截或缓存聊天接口')
  }
})

test('网页脚本可解析，静态引用与面板均为模块发布文件', () => {
  const html = webFile('index.html')
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1])
  new Script(webFile('mobile.js')); new Script(webFile('sw.js'))
  const service = readFileSync(new URL('../lib/service.mjs', import.meta.url), 'utf8')
  for (const file of ['index.html', 'mobile.js', 'sw.js']) assert.ok(service.includes('../assets/web/' + file))
  new Function('React', 'h', 'ui', 'call', readFileSync(new URL('../panel.js', import.meta.url), 'utf8'))
})
