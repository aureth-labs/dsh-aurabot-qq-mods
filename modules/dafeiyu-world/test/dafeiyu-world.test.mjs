import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { normalizeActions, extractJson } from '../lib/brain.mjs'
import { WorldLink, ACTION_LIST, travelSeconds } from '../lib/link.mjs'
import { readJsonFile, writeJsonFile, appendJsonl } from '../lib/store.mjs'
import { remember } from '../lib/memory.mjs'
import { makeFakeApi, setupModule, tempDataDir } from '../../../test/kit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = pathToFileURL(join(HERE, '..', 'index.mjs')).href

/** 一个只有地名表的最小 link 桩：normalizeActions 只用到 findPlace / findObject / findEntity / perception */
function linkStub({ places = [], objects = [], entities = [], self = { x: 0, z: 0 }, drops = [] } = {}) {
  return {
    perception: { self, places, objects, entities, drops },
    findPlace: (t) => places.find((q) => q.id === t || q.name === t) || null,
    findObject: (id) => objects.find((o) => o.id === id) || null,
    findEntity: (t) => entities.find((e) => e.id === t || e.name === t) || null,
  }
}

/** 起一个关掉「接进世界」的模块实例：只验设置/路由/存档/记忆，不去真连 WebSocket */
function setupOffline({ settings = {}, dataRoot, modules = {}, stubs = {} } = {}) {
  const kit = makeFakeApi({
    id: 'dafeiyu-world',
    dataRoot: dataRoot || tempDataDir('dafeiyu'),
    settings: { enabled: false, ...settings },
    modules,
    // kit 里没有 context / rule 这两个注册口，这里给最小的占位（真实插件里它们只是收下函数）
    stubs: { context: () => '', rule: () => '', ...stubs },
  })
  return { kit }
}

/** 本模块的路由是「返回对象」风格（插件负责序列化），直接调 handler 取返回值 */
async function routeJson(kit, path) {
  const handler = kit.routes.get(path)
  assert.ok(handler, `路由 ${path} 没注册`)
  return await handler({ method: 'GET', url: path, headers: {} })
}

/* ───────────────────────── ① 地图 / 坐标 / 移动边界 ───────────────────────── */

test('坐标越界被夹回世界边界 ±90，非法值不会变成 NaN 发出去', () => {
  const link = linkStub()
  const far = normalizeActions([{ action: 'move_to', x: 200, z: -200 }], link)
  assert.deepEqual(far.dropped, [])
  assert.deepEqual(far.actions[0].params, { x: 90, z: -90 })

  const edge = normalizeActions([{ action: 'move_to', x: 90, z: -90.5 }], link)
  assert.deepEqual(edge.actions[0].params, { x: 90, z: -90 }, '-90.5 收在 -90')

  for (const bad of [NaN, Infinity, 'abc', null]) {
    const r = normalizeActions([{ action: 'move_to', x: bad, z: bad }], link)
    assert.equal(r.actions.length, 0, `${String(bad)} 不该被当成坐标`)
    assert.match(r.dropped.join('|'), /缺坐标或地名/)
  }
})

test('地名优先解析成坐标，未知地名直接丢掉而不是乱走', () => {
  const link = linkStub({ places: [{ id: 'lake', name: '湖边', x: 34, z: -30 }] })
  const byPlace = normalizeActions([{ action: 'move_to', place: '湖边' }], link)
  assert.equal(byPlace.actions.length, 1)
  // 说「去湖边」会被换成这一侧的水岸点（离湖心 26 米的圈上），不会走进水里
  const { x, z } = byPlace.actions[0].params
  const d = Math.hypot(x - 34, z + 30)
  assert.ok(Math.abs(d - 26) < 0.01, `水岸点应在离湖心 26m 的圈上，实际 ${d}`)

  const unknown = normalizeActions([{ action: 'move_to', place: '火星' }], link)
  assert.equal(unknown.actions.length, 0)
  assert.match(unknown.dropped.join('|'), /缺坐标或地名/)
})

test('地名给的坐标越界也会被夹住，物件坐标同样夹', () => {
  const link = linkStub({
    places: [{ id: 'edge', name: '天边', x: 300, z: 300 }],
    objects: [{ id: 'o_tree_1', x: -140, z: 5, dist: 30 }],
  })
  const p = normalizeActions([{ action: 'move_to', place: '天边' }], link)
  assert.deepEqual(p.actions[0].params, { x: 90, z: 90 })

  // mine 太远 -> 先插一条 move_to，坐标同样收在边界内
  const m = normalizeActions([{ action: 'mine', object_id: 'o_tree_1' }], link)
  assert.equal(m.actions.length, 2)
  assert.deepEqual(m.actions[0], { action: 'move_to', params: { x: -90, z: 5 }, say: '' })
  assert.deepEqual(m.actions[1].params, { object_id: 'o_tree_1' })
})

test('WorldLink.findPlace 认得地名别名，找不到就返回 null', () => {
  const link = new WorldLink({ url: 'ws://127.0.0.1:1' })
  link.perception = {
    places: [], zones: [],
    town: { name: '肥鱼小镇', center: { x: 0, z: 56 }, plaza: { x: 0, z: 56 } },
    shop: { x: 12, z: 56 },
  }
  assert.deepEqual(link.findPlace('湖边'), { id: 'lake', name: '湖边', x: 34, z: -30 })
  assert.deepEqual(link.findPlace('杂货铺'), { id: 'shop', name: '杂货铺', x: 12, z: 56 })
  assert.deepEqual(link.findPlace('广场'), { id: 'plaza', name: '小镇广场', x: 0, z: 56 })
  assert.equal(link.findPlace('火星'), null)
  assert.equal(link.findPlace(''), null)

  // 感知里有同名地标时以服务端给的为准
  link.perception.places = [{ id: 'lake', name: '湖边', x: 31, z: -28, dist: 12 }]
  assert.deepEqual(link.findPlace('湖边'), { id: 'lake', name: '湖边', x: 31, z: -28, dist: 12 })
})

test('travelSeconds 有下限、按 1.15 m/s 算、不会被负距离算成负数', () => {
  assert.equal(travelSeconds(0, 0, 0, 0), 0.6)
  assert.ok(Math.abs(travelSeconds(0, 0, 11.5, 0) - 10) < 1e-9)
  assert.ok(Math.abs(travelSeconds(0, 0, -90, 0) - 90 / 1.15) < 1e-9)
  assert.equal(travelSeconds(5, 5, 5, 5), 0.6, '原地不动也有 0.6 秒下限')
})

test('动作名单是全的，服务端支持的 25 个动作都在', () => {
  assert.equal(ACTION_LIST.length, 25)
  for (const a of ['move_to', 'say', 'mine', 'build', 'fish', 'door', 'invite', 'sleep']) {
    assert.ok(ACTION_LIST.includes(a), a)
  }
})

/* ───────────────────────── ② 存档读写失败时降级 ───────────────────────── */

test('存档读：文件不存在 / JSON 坏掉 / 不是对象，都退回 fallback 且不抛', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.deepEqual(readJsonFile(join(dir, 'none.json'), { a: 1 }), { a: 1 })

  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{ "profileId": "x", ')
  const errors = []
  assert.deepEqual(readJsonFile(broken, {}, (e) => errors.push(e)), {})
  assert.equal(errors.length, 1, '解析失败要把错误交给回调（模块里写进 debug 日志）')

  writeFileSync(join(dir, 'array.json'), '["nope"]')
  assert.deepEqual(readJsonFile(join(dir, 'array.json'), {}), {})

  assert.deepEqual(readJsonFile('', {}), {})
})

test('存档写：目录不存在会自动建，写不进去（路径是目录 / 空路径）只返回 false', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-store-w-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const nested = join(dir, 'modules-data', 'dafeiyu-world', 'profile.json')
  assert.equal(writeJsonFile(nested, { profileId: 'p_1', token: 't' }), true)
  assert.deepEqual(readJsonFile(nested), { profileId: 'p_1', token: 't' })

  const asDir = join(dir, 'as-dir')
  mkdirSync(asDir, { recursive: true })
  assert.equal(writeJsonFile(asDir, { a: 1 }), false, '目标是目录时写入失败')
  assert.equal(writeJsonFile('', { a: 1 }), false)

  assert.equal(appendJsonl(join(dir, 'log', 'activities.jsonl'), { t: 1 }), true)
  assert.equal(appendJsonl(join(dir, 'log'), { t: 2 }), false, '目标是目录时追加失败')
  assert.equal(appendJsonl('', { t: 3 }), false)
})

test('模块上线：档案文件坏掉 / 数据目录都拿不到，setup 也不炸、路由照常回状态', async () => {
  // 情况一：profile.json 是坏 JSON
  const rootA = tempDataDir('dafeiyu-bad-profile')
  mkdirSync(join(rootA, 'modules-data', 'dafeiyu-world'), { recursive: true })
  writeFileSync(join(rootA, 'modules-data', 'dafeiyu-world', 'profile.json'), '{"profileId": "p_9", "token": ')
  const a = setupOffline({ dataRoot: rootA })
  const { exports: ex } = await setupModule(ENTRY, a.kit.api)
  const st = await routeJson(a.kit, '/status')
  assert.equal(st.ok, true, '坏档案也要能回状态')
  assert.equal(st.profileId, '')
  assert.equal(ex.status().connected, false)
  a.kit.cleanup()

  // 情况二：dataDir 直接抛（权限 / 盘满 / 路径非法）
  // 这里让「接进世界」开着，才会真的去读档案；WebSocket 用桩顶掉，别真连网。
  const realWS = globalThis.WebSocket
  globalThis.WebSocket = class {
    constructor() { this.readyState = 0 }
    send() {}
    close() {}
  }
  try {
    const b = setupOffline({
      settings: { enabled: true, wsUrl: 'ws://127.0.0.1:1' },
      stubs: { dataDir: () => { throw new Error('EACCES: 数据目录不可写') } },
    })
    await setupModule(ENTRY, b.kit.api)
    const st2 = await routeJson(b.kit, '/status')
    assert.equal(st2.ok, true, '数据目录拿不到也要能回状态')
    assert.equal(st2.profileId, '')
    assert.ok(b.kit.logs.some(([lvl, msg]) => lvl === 'debug' && /数据目录不可用/.test(msg)), '挂了要留一条 debug 日志')
    b.kit.cleanup()
  } finally {
    globalThis.WebSocket = realWS
  }
})

/* ───────────────────────── ③ memory 可选依赖关掉时 ───────────────────────── */

test('remember：没装 / 没有 addEvent / addEvent 自己抛，都安静地返回 false', () => {
  const errs = []
  assert.equal(remember(null, { text: 'x' }), false)
  assert.equal(remember(undefined, { text: 'x' }), false)
  assert.equal(remember({}, { text: 'x' }), false)
  assert.equal(remember({ addEvent: 'not-a-function' }, { text: 'x' }), false)

  const boom = { addEvent: () => { throw new Error('记忆库坏了') } }
  assert.equal(remember(boom, { text: 'x' }, (e) => errs.push(e)), false)
  assert.equal(errs.length, 1)

  const calls = []
  const ok = { addEvent: (ev) => calls.push(ev) }
  assert.equal(remember(ok, { text: '和 泡泡 牵了手', tags: ['开放世界'], importance: 2 }), true)
  assert.deepEqual(calls[0], { text: '和 泡泡 牵了手', tags: ['开放世界'], importance: 2 })
})

test('依赖关掉时模块照常启动：不主动取 memory、工具和命令都在、没连上时给的是人话', async () => {
  const c = setupOffline({ modules: {} })
  let useCalls = 0
  const realUse = c.kit.api.use
  c.kit.api.use = (id) => { useCalls += 1; return realUse(id) }

  const { exports: ex } = await setupModule(ENTRY, c.kit.api)
  assert.equal(useCalls, 0, '启动阶段不该去 api.use("memory")')

  const defs = c.kit.toolDefs()
  assert.deepEqual(defs.map((d) => d.name).sort(), ['world_act', 'world_look'])
  assert.equal(c.kit.commands.length, 1)
  assert.equal(c.kit.commands[0].name, '世界')

  const look = await c.kit.runTool('world_look')
  assert.equal(look.ok, false)
  assert.match(look.message, /没连上开放世界/)

  const act = await c.kit.runTool('world_act', { action: 'move_to', x: 0, z: 56 })
  assert.equal(act.ok, false)
  assert.match(act.message, /没连上开放世界/)

  assert.equal(typeof ex.suggest, 'function')
  assert.equal(typeof ex.look, 'function')
  ex.dispose()
  c.kit.cleanup()
})

test('extractJson 能从围栏 / 带话的回复里抠出动作数组', () => {
  assert.deepEqual(extractJson('```json\n[{"action":"idle"}]\n```'), [{ action: 'idle' }])
  assert.deepEqual(extractJson('[{"action":"say","say":"嗨"}]'), [{ action: 'say', say: '嗨' }])
  assert.deepEqual(extractJson('{"actions":[{"action":"idle"}]}'), [{ action: 'idle' }])
  assert.equal(extractJson('今天天气不错'), null)
})
