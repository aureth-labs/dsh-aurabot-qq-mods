// modules/starmap/test/starmap.test.mjs —— 星图单测
// 覆盖：数据整理（长期记忆 / 摘要 / 小档案 / 会话枢纽、去重、700 上限、连线剪枝、正文）、
//       布局契约（星体尺寸、页面配色覆盖所有 type、页面只请求同源相对接口）、
//       面板与路由（panel.js 解析、/page /graph /node /health、15 秒缓存）。
// 不碰真实记忆库，也不联网。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildGraph, clean, fmt, typeOf, sizeOf, MAX_NODES, SIZE } from '../lib/graph.mjs'
import mod, { resetCache, DEFAULTS } from '../index.mjs'

const DIR = fileURLToPath(new URL('..', import.meta.url))
const read = (name) => readFileSync(join(DIR, name), 'utf8')

/** 假 memory 模块：只实现星图用到的四个方法。 */
function memory({ items = [], gists = [], profiles = [], people = [] } = {}) {
  return {
    list: () => items,
    gists: () => gists,
    profiles: () => profiles,
    personaOverview: () => people,
  }
}

const DAY = 1767225600000 // 2026-01-01

const owner = { qq: '10001', alias: '老爹' }

function sample() {
  return memory({
    people: [owner],
    profiles: [{ qq: '10001', alias: '老爹', text: '不爱吃香菜，喜欢晚上散步。', at: DAY }],
    items: [
      { id: 'm1', text: '今天去江边散步，风很大。', at: DAY, hits: 4, importance: 0.8, source: 'diary', about: '10001', aboutName: '老爹', related: ['m2'] },
      { id: 'm2', text: '记一下：周六要早起。', at: DAY, hits: 0, source: 'import', about: '10001' },
    ],
    gists: [{ id: 'g1', text: '这周聊了很多关于散步的事。', at: DAY, about: '10001' }],
  })
}

/** 假 api：记下注册的路由，send 只收集参数。 */
function fakeApi({ mem, dir = DIR, settings = { enabled: true, scope: 'all' }, ownerQQ = '10001' } = {}) {
  const routes = new Map()
  const store = { ...settings }
  const api = {
    dir,
    core: { http: { send: (res, status, body, type) => { res.status = status; res.body = String(body); res.type = type } } },
    use: (id) => (id === 'memory' ? mem : null),
    route: (path, handler) => routes.set(path, handler),
    settings: () => ({ ...store }),
    saveSettings: (patch) => Object.assign(store, patch),
    config: () => ({ ownerQQ }),
  }
  return { api, routes, store }
}

describe('数据', () => {
  test('长期记忆变成 item 节点，带正文、来源和尺寸', () => {
    const g = buildGraph(sample())
    const item = g.nodes.find((n) => n.id === 'item:m1')
    assert.ok(item, '缺 item:m1')
    assert.equal(item.type, 'daily')
    assert.equal(item.uses, 4)
    assert.equal(item.session, '老爹')
    assert.match(item.created, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(item.chars, '今天去江边散步，风很大。'.length)
    assert.ok(item.size > SIZE.itemBase, '被想起过的记忆要比默认大')
    assert.equal(g.texts.get('item:m1').label, '今天去江边散步，风很大。')
    assert.match(g.texts.get('item:m1').text, /diary/)
  })

  test('每日摘要变成 gist 节点，固定尺寸', () => {
    const g = buildGraph(sample())
    const gist = g.nodes.find((n) => n.id === 'gist:g1')
    assert.ok(gist)
    assert.equal(gist.type, 'daily')
    assert.equal(gist.size, SIZE.gist)
    assert.equal(gist.uses, 0)
    assert.match(g.texts.get('gist:g1').text, /聊了很多关于散步/)
  })

  test('人物小档案变成 project 节点，并连到会话枢纽', () => {
    const g = buildGraph(sample())
    const profile = g.nodes.find((n) => n.id === 'profile:10001')
    const subject = g.nodes.find((n) => n.id === 'subject:10001')
    assert.equal(profile.type, 'project')
    assert.equal(profile.size, SIZE.profile)
    assert.equal(profile.label, '档案 · 老爹')
    assert.equal(subject.type, 'session')
    assert.equal(subject.size, SIZE.session)
    assert.equal(subject.label, '老爹')
    const link = g.links.find((l) => l.source === 'subject:10001' && l.target === 'profile:10001')
    assert.deepEqual(link, { source: 'subject:10001', target: 'profile:10001', weight: 1, kind: 'type' })
  })

  test('记忆之间的 related 连线保留，weight 比会话连线小', () => {
    const g = buildGraph(sample())
    const rel = g.links.find((l) => l.source === 'item:m1' && l.target === 'item:m2')
    assert.equal(rel.kind, 'related')
    assert.ok(rel.weight < 0.8)
  })

  test('没有 memory 模块、或者记忆是空的，都给空结果', () => {
    for (const g of [buildGraph(null), buildGraph(memory())]) {
      assert.deepEqual(g.nodes, [])
      assert.deepEqual(g.links, [])
      assert.equal(g.texts.size, 0)
    }
  })

  test('缺正文的记忆、没有 qq 的档案会被跳过', () => {
    const g = buildGraph(memory({
      items: [{ id: 'a', text: '' }, { id: 'b', text: '有正文' }],
      gists: [{ id: 'x', text: '  ' }],
      profiles: [{ qq: '', text: '没有 qq' }],
      people: [{ qq: '' }],
    }))
    assert.deepEqual(g.nodes.map((n) => n.id), ['item:b'])
  })

  test('同一个 id 只算一个节点', () => {
    const g = buildGraph(memory({ items: [{ id: 'a', text: '一' }, { id: 'a', text: '二' }] }))
    assert.equal(g.nodes.length, 1)
    assert.equal(g.nodes[0].label, '一')
  })

  test(`节点最多 ${MAX_NODES} 个`, () => {
    const items = Array.from({ length: MAX_NODES + 40 }, (_, i) => ({ id: 'x' + i, text: '记忆 ' + i }))
    const g = buildGraph(memory({ items }))
    assert.equal(g.nodes.length, MAX_NODES)
    assert.equal(g.links.length, 0)
  })

  test('连到不存在节点的连线会被剪掉', () => {
    const g = buildGraph(memory({ items: [{ id: 'a', text: '甲', related: ['missing'] }] }))
    assert.deepEqual(g.links, [])
  })

  test('所有连线两端都是已有节点', () => {
    const g = buildGraph(sample())
    const ids = new Set(g.nodes.map((n) => n.id))
    for (const l of g.links) {
      assert.ok(ids.has(l.source), `连线起点不存在：${l.source}`)
      assert.ok(ids.has(l.target), `连线终点不存在：${l.target}`)
      assert.notEqual(l.source, l.target)
    }
  })

  test('clean / fmt / typeOf 的小规矩', () => {
    assert.equal(clean('  今天 \n 风很大  '), '今天 风很大')
    assert.equal(clean('abcdef', 3), 'abc')
    assert.equal(clean(undefined), '')
    assert.equal(fmt(0), '')
    assert.equal(fmt(undefined), '')
    assert.match(fmt(DAY), /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(typeOf({ source: 'diary' }), 'daily')
    assert.equal(typeOf({ source: 'event' }), 'daily')
    assert.equal(typeOf({ kind: 'seen' }), 'daily')
    assert.equal(typeOf({ source: 'gist' }), 'daily')
    assert.equal(typeOf({ source: 'import' }), 'reference')
    assert.equal(typeOf({}), 'reference')
  })
})

describe('布局', () => {
  test('星体尺寸有上下限，被想起越多越大', () => {
    const min = sizeOf({ hits: 0, importance: 0 })
    const mid = sizeOf({ hits: 10 })
    const max = sizeOf({ hits: 100000, importance: 1 })
    assert.ok(min >= SIZE.itemBase)
    assert.ok(mid > min)
    assert.equal(max, SIZE.itemBase + 5 + 2.2)
    assert.ok(sizeOf({ hits: 100000, importance: 1 }) > sizeOf({ hits: 100000, importance: 0.2 }))
  })

  test('每个节点都给页面留了画得下的字段', () => {
    const g = buildGraph(sample())
    for (const n of g.nodes) {
      assert.equal(typeof n.id, 'string')
      assert.ok(n.label.length > 0 && n.label.length <= 44, `${n.id} 的 label 长度不对：${n.label}`)
      assert.ok(Number.isFinite(n.size) && n.size >= SIZE.itemBase && n.size <= SIZE.itemBase + 5 + 2.2, `${n.id} 的 size 不对：${n.size}`)
      assert.ok(Number.isFinite(n.uses) && n.uses >= 0)
      assert.ok(Number.isFinite(n.chars) && n.chars >= 0)
      assert.ok(['daily', 'reference', 'project', 'session'].includes(n.type), `${n.id} 的类型不认识：${n.type}`)
    }
  })

  test('页面配色覆盖服务端会发的所有 type', () => {
    const page = read('assets/map.html')
    const block = page.match(/const TYPE_TINT = \{([\s\S]*?)\}/)
    assert.ok(block, '页面里找不到 TYPE_TINT')
    const tints = new Set([...block[1].matchAll(/(\w+):\s*\[/g)].map((m) => m[1]))
    const g = buildGraph(sample())
    for (const type of new Set(g.nodes.map((n) => n.type))) assert.ok(tints.has(type), `页面没有给 ${type} 配颜色`)
    const cn = page.match(/const TYPE_CN = \{([\s\S]*?)\}/)
    assert.ok(cn, '页面里找不到 TYPE_CN')
    const names = new Set([...cn[1].matchAll(/(\w+):\s*'/g)].map((m) => m[1]))
    for (const type of new Set(g.nodes.map((n) => n.type))) assert.ok(names.has(type), `页面没有给 ${type} 配中文名`)
  })

  test('页面只请求同源相对接口，没有外联资源', () => {
    const page = read('assets/map.html')
    assert.equal(/https?:\/\//.test(page), false, '页面里不该出现外网地址')
    assert.equal(/<script[^>]+src=/i.test(page), false, '页面不该引外部脚本')
    assert.equal(/<link[^>]+href=/i.test(page), false, '页面不该引外部样式')
    const urls = [...page.matchAll(/fetch\('([^']*)'/g)].map((m) => m[1])
    assert.deepEqual(urls, ['graph', 'node?id='])
  })
})

describe('面板与路由', () => {
  test('panel.js 能按插件的方式解析，iframe 指向 /page', () => {
    const source = read('panel.js')
    assert.doesNotThrow(() => new Function(source)) // 插件是 new Function(body) 跑的
    assert.match(source, /\/aurabot\/api\/ext\/starmap\/page/)
  })

  test('setup 注册 /page /graph /node /health', () => {
    const { api, routes } = fakeApi({ mem: sample() })
    mod.setup(api)
    assert.deepEqual([...routes.keys()].sort(), ['/graph', '/health', '/node', '/page', '/settings'])
  })

  test('/page?v=map 以 text/html 返回渲染页', async () => {
    resetCache()
    const { api, routes } = fakeApi({ mem: sample() })
    mod.setup(api)
    const res = {}
    await routes.get('/page')({ url: '/page?v=map' }, res)
    assert.equal(res.status, 200)
    assert.match(res.type, /^text\/html/)
    assert.match(res.body, /id="cv"/)
    assert.match(res.body, /fetch\('graph'/)
  })

  test('/page?v=galaxy 返回云图页', async () => {
    resetCache()
    const { api, routes } = fakeApi({ mem: sample() })
    mod.setup(api)
    const res = {}
    await routes.get('/page')({ url: '/page?v=galaxy' }, res)
    assert.equal(res.status, 200)
    assert.match(res.type, /^text\/html/)
    assert.match(res.body, /id="cv"/)
    assert.match(res.body, /fetch\('graph'/)
  })

  test('/page 不带 v 返回外壳（选择界面）', async () => {
    resetCache()
    const { api, routes } = fakeApi({ mem: sample() })
    mod.setup(api)
    const res = {}
    await routes.get('/page')({ url: '/page' }, res)
    assert.equal(res.status, 200)
    assert.match(res.type, /^text\/html/)
    assert.match(res.body, /id="fMap"/, '外壳要有两个 iframe')
    assert.match(res.body, /data-view="galaxy"/)
  })

  test('/page 读不到页面文件时给 500，不抛异常', async () => {
    const { api, routes } = fakeApi({ mem: sample(), dir: join(DIR, 'no-such-dir') })
    mod.setup(api)
    const res = {}
    await routes.get('/page')({ url: '/page' }, res)
    assert.equal(res.status, 500)
    assert.match(res.type, /^text\/plain/)
  })

  test('/settings 读设置；写设置要同源，写完开关能生效', async () => {
    resetCache()
    const { api, routes, store } = fakeApi({ mem: sample(), settings: {} })
    // fakeApi 默认没给 body 通道，这里补一个，模拟面板 POST
    api.core.http.body = async (req) => req.__body || {}
    mod.setup(api)

    const read0 = await routes.get('/settings')({ url: '/settings', method: 'GET' })
    assert.equal(read0.ok, true)
    assert.equal(read0.enabled, false, '默认必须是关的')

    // 跨站写 → 拒
    const evil = await routes.get('/settings')({
      url: '/settings', method: 'POST',
      headers: { origin: 'https://evil.example' },
      __body: { enabled: true },
    })
    assert.equal(evil.ok, false)
    assert.equal(evil.denied, true)
    assert.equal(store.enabled, undefined, '被拒的请求不能改到设置')

    // 同源写 → 生效
    const save = await routes.get('/settings')({
      url: '/settings', method: 'POST',
      headers: { origin: 'http://127.0.0.1:6180' },
      __body: { enabled: true, scope: 'owner' },
    })
    assert.equal(save.ok, true)
    assert.equal(save.enabled, true)
    assert.equal(save.scope, 'owner')
    assert.equal(store.enabled, true)

    // 开关打开后 /graph 就能读了
    const g = await routes.get('/graph')({ url: '/graph' })
    assert.equal(g.ok, true)
    assert.ok(g.nodes.length > 0)
  })

  test('/settings 只接受认识的字段', async () => {
    resetCache()
    const { api, routes } = fakeApi({ mem: sample(), settings: {} })
    api.core.http.body = async () => ({ nonsense: 1, scope: 'hack' })
    mod.setup(api)
    const r = await routes.get('/settings')({
      url: '/settings', method: 'POST',
      headers: { origin: 'http://127.0.0.1:6180' },
    })
    assert.equal(r.ok, false, '不认识的字段不该被写进去')
  })

  test('/graph 返回节点、连线和数量，并且 15 秒内走缓存', async () => {
    resetCache()
    let reads = 0
    const mem = sample()
    const items = mem.list()
    const counting = { ...mem, list: () => { reads++; return items } }
    const { api, routes } = fakeApi({ mem: counting })
    mod.setup(api)
    const first = await routes.get('/graph')({ url: '/graph' })
    const second = await routes.get('/graph')({ url: '/graph' })
    assert.equal(first.ok, true)
    assert.equal(first.count, first.nodes.length)
    assert.equal(reads, 1, '第二次应该读缓存')
    assert.deepEqual(second, first)
  })

  test('/node 按 id 取正文，缺 id / 找不到都给错误', async () => {
    resetCache()
    const { api, routes } = fakeApi({ mem: sample() })
    mod.setup(api)
    const node = routes.get('/node')
    const hit = await node({ url: '/node?id=' + encodeURIComponent('item:m1') })
    assert.equal(hit.ok, true)
    assert.match(hit.text, /江边散步/)
    assert.equal(hit.name, '今天去江边散步，风很大。')
    assert.deepEqual(await node({ url: '/node' }), { ok: false, error: 'missing id' })
    assert.deepEqual(await node({ url: '/node?id=item:nope' }), { ok: false, error: 'not found' })
  })

  test('/health 报来源和数量', async () => {
    resetCache()
    const { api, routes } = fakeApi({ mem: sample() })
    mod.setup(api)
    const health = await routes.get('/health')({ url: '/health' })
    assert.equal(health.ok, true)
    assert.equal(health.source, 'aurabot-memory')
    assert.equal(health.nodes, 5)
    assert.equal(health.links, 5)
  })

  // ── 隐私闸：默认关、跨站拒、作用域过滤 ────────────────────────
  test('默认关闭：没在面板打开时，/graph 拒绝返回记忆', async () => {
    resetCache()
    const { api, routes } = fakeApi({ mem: sample(), settings: {} })   // 空 = 走 DEFAULTS
    mod.setup(api)
    const r = await routes.get('/graph')({ url: '/graph' })
    assert.equal(r.ok, false)
    assert.equal(r.closed, true)
    assert.equal(r.nodes, undefined, '关着的时候一个节点都不能吐')
  })

  test('默认关闭：/node 也拿不到正文', async () => {
    resetCache()
    const { api, routes } = fakeApi({ mem: sample(), settings: {} })
    mod.setup(api)
    const r = await routes.get('/node')({ url: '/node?id=' + encodeURIComponent('item:m1') })
    assert.equal(r.ok, false)
    assert.equal(r.closed, true)
    assert.equal(r.text, undefined)
  })

  test('跨站请求被拒：恶意的 Origin 拿不到数据', async () => {
    resetCache()
    const { api, routes } = fakeApi({ mem: sample() })
    mod.setup(api)
    const r = await routes.get('/graph')({ url: '/graph', headers: { origin: 'https://evil.example' } })
    assert.equal(r.ok, false)
    assert.equal(r.denied, true)
    assert.equal(r.nodes, undefined)
  })

  test('跨站请求被拒：Sec-Fetch-Site 是 cross-site 也不行', async () => {
    resetCache()
    const { api, routes } = fakeApi({ mem: sample() })
    mod.setup(api)
    const r = await routes.get('/node')({ url: '/node', headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(r.ok, false)
    assert.equal(r.denied, true)
  })

  test('同源请求正常通过（面板自己不能被挡）', async () => {
    resetCache()
    const { api, routes } = fakeApi({ mem: sample() })
    mod.setup(api)
    const r = await routes.get('/graph')({ url: '/graph', headers: { origin: 'http://127.0.0.1:6180' } })
    assert.equal(r.ok, true)
    assert.ok(r.nodes.length > 0)
  })

  test('作用域 owner：别人的记忆、摘要、档案都滤掉，自己的留着', async () => {
    resetCache()
    const mem = memory({
      people: [{ qq: '10001' }, { qq: '20002' }],
      profiles: [
        { qq: '10001', text: '主人档案', at: DAY },
        { qq: '20002', text: '别人的档案', at: DAY },
      ],
      items: [
        { id: 'mine', text: '她自己写的日记', at: DAY, source: 'diary' },          // 无归属 → 留
        { id: 'ok', text: '关于主人的事', at: DAY, about: '10001' },               // 主人 → 留
        { id: 'other', text: '群友的私事', at: DAY, about: '20002' },              // 别人 → 滤
      ],
      gists: [
        { id: 'g1', text: '关于群友的摘要', at: DAY, about: '20002' },
        { id: 'g2', text: '关于主人的摘要', at: DAY, about: '10001' },
      ],
    })
    const { api, routes } = fakeApi({ mem, settings: { enabled: true, scope: 'owner' } })
    mod.setup(api)
    const g = await routes.get('/graph')({ url: '/graph' })
    const ids = g.nodes.map((n) => n.id)
    assert.ok(ids.includes('item:mine'), '她自己写的要留')
    assert.ok(ids.includes('item:ok'), '主人相关的要留')
    assert.ok(ids.includes('gist:g2'), '主人的摘要要留')
    assert.ok(!ids.includes('item:other'), '别人的记忆必须滤掉')
    assert.ok(!ids.includes('gist:g1'), '别人的摘要必须滤掉')
    assert.ok(!ids.includes('profile:20002'), '别人的档案必须滤掉')
    assert.ok(!ids.includes('subject:20002'), '别人的会话枢纽也要滤掉')
    assert.equal(g.scope, 'owner')
  })

  test('作用域 all：显式打开全量时才返回全部', async () => {
    resetCache()
    const mem = memory({
      profiles: [{ qq: '20002', text: '别人的档案', at: DAY }],
      items: [{ id: 'other', text: '群友的私事', at: DAY, about: '20002' }],
    })
    const { api, routes } = fakeApi({ mem, settings: { enabled: true, scope: 'all' } })
    mod.setup(api)
    const g = await routes.get('/graph')({ url: '/graph' })
    const ids = g.nodes.map((n) => n.id)
    assert.ok(ids.includes('item:other'))
    assert.ok(ids.includes('profile:20002'))
    assert.equal(g.scope, 'all')
  })

  test('切换作用域会让缓存失效', async () => {
    resetCache()
    const { api, routes, store } = fakeApi({ mem: sample(), settings: { enabled: true, scope: 'owner' } })
    mod.setup(api)
    const a = await routes.get('/graph')({ url: '/graph' })
    assert.equal(a.scope, 'owner')
    store.scope = 'all'
    const b = await routes.get('/graph')({ url: '/graph' })
    assert.equal(b.scope, 'all', '改 scope 后不能还吃旧缓存')
  })

  test('DEFAULTS 是关闭的（装好不等于已经公开）', () => {
    assert.equal(DEFAULTS.enabled, false)
    assert.equal(DEFAULTS.scope, 'owner')
  })

  test('外壳页：两个 iframe，分别指向 ?v=map 和 ?v=galaxy', () => {
    const shell = read('assets/page.html')
    assert.match(shell, /<iframe[^>]*id="fMap"/, '缺 fMap')
    assert.match(shell, /<iframe[^>]*id="fGalaxy"/, '缺 fGalaxy')
    assert.match(shell, /'\?v=' \+ view/, 'iframe 应该用 ?v= 加载引擎')
    assert.match(shell, /starmap\.view/, '选择要存在 localStorage')
    assert.match(shell, /data-view="map"/)
    assert.match(shell, /data-view="galaxy"/)
    assert.ok(!/id="cv"/.test(shell), '外壳自己不该有 canvas')
  })

  test('两个引擎页都只请求同源相对接口', () => {
    for (const name of ['assets/map.html', 'assets/galaxy.html']) {
      const html = read(name)
      assert.match(html, /fetch\(['"]graph['"]/, name + ' 应该请求相对 graph')
      assert.ok(!/https?:\/\//.test(html.replace(/https?:\/\/[^"'\s]*w3\.org[^"'\s]*/g, '')), name + ' 不该请求外部地址')
    }
  })

  test('入口元数据和 module.json 对得上', () => {
    const manifest = JSON.parse(read('module.json'))
    for (const key of ['id', 'name', 'version', 'api', 'description']) assert.equal(mod[key], manifest[key], `${key} 不一致`)
  })
})
