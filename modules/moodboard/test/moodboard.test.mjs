// 心情看板（moodboard）测试：聚合数据、单模块故障隔离、页面自回 HTML。
// 全部走 fake api，不打真网络、不写任何数据目录。

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

let mod

before(async () => {
  mod = (await import('../index.mjs')).default
})

/** 造一个 fake api：routes 收集 api.route 注册的接口，use 按传入的导出表返回。 */
function fakeApi(exports = {}, settings = { refresh: 5 }) {
  const routes = new Map()
  return {
    routes,
    settings: () => settings,
    use: (id) => exports[id] ?? null,
    core: {
      http: {
        // 记录 send 的调用，模拟响应
        sent: null,
        send(res, code, body, type) { this.sent = { code, body, type } },
      },
    },
    route(path, handler) { routes.set(path, handler) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  }
}

function makeRes() {
  return { done: null, end(body) { this.done = body } }
}

test('module.json 与入口的 id/version 一致；capabilities 与扫描口径一致（页面 fetch 轮询 + api.core）', async () => {
  const { fileURLToPath } = await import('node:url')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'module.json')
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(meta.id, mod.id)
  assert.equal(meta.version, mod.version)
  // network：看板页用 fetch 轮询本机接口（不访问外网）；plugin-internals：用 api.core.http 回 HTML；
  // process：/open 用 rundll32（系统默认浏览器）打开看板
  assert.deepEqual([...meta.capabilities].sort(), ['network', 'plugin-internals', 'process'])
})

test('/state 聚合三块数据：心情 + 目的引擎 + 记忆', async () => {
  const api = fakeApi({
    mood: {
      state: () => ({
        value: 72, label: '心情不错', reason: '被主人夸了', at: Date.now(),
        history: [{ at: Date.now() - 60000, from: 66, to: 72, reason: '被主人夸了' }],
      }),
    },
    purpose: {
      // status()（summarizePurposeState）才是带驱力/心情向量的那份；state() 是薄摘要
      status: () => ({
        drives: { play: 0.8, connect: 0.6, care: 0.1 },
        moods: { curious: 0.5, bored: 0.2 },
        lastEmotion: 'excited', lastEmotionLabel: '兴奋', lastEmotionText: '挺兴奋的',
        lastPurpose: '想分享新学会的东西', lastOutcome: 'sent',
        nextFireAt: Date.now() + 3600000, nextFireText: '一小时后',
      }),
      state: () => ({ countToday: 3, lastOutcome: 'sent' }),
    },
    memory: {
      insights: () => [{ key: 'qq:123', name: '主人', list: [{ id: 'a', text: '累的时候不想多聊', at: 1 }, '纯字符串也认'] }],
      styles: () => ({ 'qq:123': ['喜欢被吐槽'], self: ['语气轻快'] }),
    },
  })
  mod.setup(api)
  const state = await api.routes.get('/state')()
  assert.equal(state.ok, true)
  assert.equal(state.mood.value, 72)
  assert.equal(state.mood.history.length, 1)
  assert.equal(state.purpose.drives.play, 0.8)
  assert.equal(state.purpose.moods.curious, 0.5)
  assert.equal(state.purpose.lastEmotionText, '挺兴奋的')
  assert.equal(state.purpose.nextFireText, '一小时后')
  assert.equal(state.memory.insights[0].name, '主人')
  assert.equal(state.memory.styles.self[0], '语气轻快')
  // 中文标签带上，页面不用各自维护
  assert.equal(state.labels.needs.play, '玩')
  assert.equal(state.labels.emotions.curious, '好奇')
})

test('某个模块没在跑/抛错时：那一块置空，整页数据照常返回', async () => {
  const api = fakeApi({
    mood: { state: () => { throw new Error('boom') } },
    purpose: { state: () => null },
  })
  mod.setup(api)
  const state = await api.routes.get('/state')()
  assert.equal(state.ok, true)
  assert.equal(state.mood, null, '心情模块抛错 → 整块置空')
  assert.equal(state.purpose, null)
  assert.deepEqual(state.memory.insights, [])
  assert.deepEqual(state.memory.styles, {})
})

test('目的引擎只有薄摘要 state()（没 status）时：回落用它，缺的字段置空', async () => {
  const api = fakeApi({
    purpose: { state: () => ({ countToday: 1, lastOutcome: 'silent', lastPurpose: '想找主人说话' }) },
  })
  mod.setup(api)
  const state = await api.routes.get('/state')()
  assert.equal(state.ok, true)
  assert.equal(state.purpose.lastPurpose, '想找主人说话')
  assert.deepEqual(state.purpose.drives, {})
  assert.deepEqual(state.purpose.moods, {})
})

test('驱力 9 维、心情 10 种情绪的中文标签全量带上；页面按全量渲染（0 也出条）', async () => {
  const api = fakeApi({
    purpose: { status: () => ({ drives: { play: 0.5 }, moods: { content: 0.45 } }) },
  })
  mod.setup(api)
  const state = await api.routes.get('/state')()
  assert.equal(Object.keys(state.labels.needs).length, 9, '9 维驱力标签')
  assert.equal(Object.keys(state.labels.emotions).length, 10, '10 种情绪标签')
  // 页面不再有「还没有数据」的空分支：标签在，渲染就全量出条
  const res = makeRes()
  await api.routes.get('/board')({}, res)
  const html = String(api.core.http.sent.body)
  assert.ok(!html.includes('还没有驱力数据'))
  assert.ok(!html.includes('还没有心情向量数据'))
  assert.ok(html.includes("s.labels.needs"), '驱力按标签全量遍历渲染')
  assert.ok(html.includes("s.labels.emotions"), '心情按标签全量遍历渲染')
})

test('/open 用系统默认浏览器打开：Windows 走 rundll32，地址从 Host 头拼', async () => {
  const calls = []
  const api = fakeApi({})
  api.__moodboardTestHooks = {
    run: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} } },
    platform: 'win32',
  }
  mod.setup(api)
  const r = await api.routes.get('/open')({ headers: { host: '127.0.0.1:65156' } })
  assert.equal(r.ok, true)
  assert.equal(r.url, 'http://127.0.0.1:65156/aurabot/api/ext/moodboard/board')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'rundll32')
  assert.equal(calls[0].args[0], 'url.dll,FileProtocolHandler')
  assert.equal(calls[0].args[1], r.url, '完整 URL 走 argv，不经 shell（& 不被截断）')
})

test('/open 拿不到 Host 时拒绝；darwin/linux 用 open/xdg-open', async () => {
  const calls = []
  const api = fakeApi({})
  api.__moodboardTestHooks = {
    run: (cmd, args) => { calls.push({ cmd }); return { on() {}, unref() {} } },
    platform: 'darwin',
  }
  mod.setup(api)
  const r = await api.routes.get('/open')({ headers: {} })
  assert.equal(r.ok, false, '没有 Host 头 → 拒绝，不瞎猜地址')
  assert.deepEqual(calls, [], '拒绝时不起任何进程')
  const r2 = await api.routes.get('/open')({ headers: { host: 'localhost:65156' } })
  assert.equal(r2.ok, true)
  assert.equal(calls[0].cmd, 'open', 'macOS 用 open')
  api.__moodboardTestHooks.platform = 'linux'
  await api.routes.get('/open')({ headers: { host: 'localhost:65156' } })
  assert.equal(calls[1].cmd, 'xdg-open', 'Linux 用 xdg-open')
})

test('/board 自己写 res 回 HTML：text/html、含接口路径与刷新间隔，不再返回值', async () => {
  const api = fakeApi({}, { refresh: 9 })
  mod.setup(api)
  const res = makeRes()
  const ret = await api.routes.get('/board')({}, res)
  assert.equal(ret, undefined, '自己回响应时不返回值（宿主不再包 JSON）')
  assert.equal(api.core.http.sent.code, 200)
  assert.match(api.core.http.sent.type, /text\/html/)
  assert.match(String(api.core.http.sent.body), /\/aurabot\/api\/ext\/moodboard\/state/)
  assert.match(String(api.core.http.sent.body), /REFRESH = 9 \* 1000/)
})

test('刷新间隔设置被钳制：0 与超大都落回安全范围', async () => {
  const api = fakeApi({}, { refresh: 0 })
  mod.setup(api)
  const res = makeRes()
  await api.routes.get('/board')({}, res)
  assert.match(String(api.core.http.sent.body), /REFRESH = 5 \* 1000/, '非法值回落默认 5 秒')
  const api2 = fakeApi({}, { refresh: 99999 })
  mod.setup(api2)
  const res2 = makeRes()
  await api2.routes.get('/board')({}, res2)
  assert.match(String(api2.core.http.sent.body), /REFRESH = 120 \* 1000/, '上限 120 秒')
})
