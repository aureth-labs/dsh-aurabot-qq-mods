// 桌宠「小屋」测试：
//   · /house/manifest：素材未就绪 404；放了 manifest.json 后能取到（JSON）
//   · /asset/house/<file>：一条条精确注册（原始名 + 百分号编码名）；坏令牌 401；严格隔离不回落
//   · /house/state：POST 落盘（night/state/floor/say 截断）+ GET 回读 + emit('house') 事件
//   · houseStatus：文件数 / manifestReady / 开关（petHouseEnabled=false 时 /house/manifest 404）
//   · 客户端模板：CLIENT_FILES 必须带上 house.html / house.js（生成物对账的清单）
// fake api 模式与 pet.test.mjs 同款；全程 AURABOT_DATA_DIR 隔离，不打真网络。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let mod
const MODULE_DIR = fileURLToPath(new URL('../', import.meta.url))

before(async () => {
  mod = (await import('../index.mjs')).default
})

beforeEach(() => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-pet-house-'))
})

// 与 pet.test.mjs 同款的 fake api（只保留本文件用得到的面）
function startModule({ settings = {} } = {}) {
  const s = { carrier: 'pet', modality: 'text', ...settings }
  const routes = new Map()
  const api = {
    id: 'pet',
    dir: MODULE_DIR,
    version: 'test',
    __petTestHooks: {},
    log: { info() {}, warn() {}, debug() {}, error() {} },
    dataDir: (...parts) => {
      const d = join(process.env.AURABOT_DATA_DIR, 'modules-data', 'pet')
      mkdirSync(d, { recursive: true })
      return join(d, ...parts)
    },
    config: () => ({ ownerQQ: '10000001', ...cfgPatch }),
    settings: () => ({ ...s }),
    saveSettings: (patch) => { Object.assign(s, patch); return { ...s } },
    route: (path, handler) => { routes.set(path, handler) },
    every: () => () => {},
    onDispose: () => {},
    has: () => false,
    use: () => null,
    sendText: async () => {},
    core: {
      http: {
        send: (res, code, body) => { res.statusCode = code; res.end(JSON.stringify(body)) },
        query: (req) => { try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams) } catch { return {} } },
        body: async (req) => req.__json ?? {},
      },
    },
  }
  let cfgPatch = {}
  const exports = mod.setup(api) ?? {}
  const token = readFileSync(api.dataDir('host-token'), 'utf8').trim()
  async function call(path, opts = {}) {
    const handler = routes.get(path.split('?')[0])
    if (!handler) return { status: 404, json: { ok: false, message: 'no route ' + path } }
    const qs = new URLSearchParams(opts.query || {}).toString()
    const r = {
      method: opts.method || 'GET',
      url: `${path}${qs ? '?' + qs : ''}`,
      headers: { host: '127.0.0.1:53210', ...(opts.token === null ? {} : { 'x-pet-token': opts.token ?? token }), ...(opts.json ? { 'content-type': 'application/json' } : {}) },
      __json: opts.json,
    }
    const res = { statusCode: 200, headers: {}, raw: null, setHeader(k, v) { this.headers[k] = v }, end(b) { this.raw = b } }
    await handler(r, res)
    let body = res.raw
    try { body = JSON.parse(res.raw) } catch {}
    return { status: res.statusCode, headers: res.headers, raw: res.raw, json: body }
  }
  return {
    api, exports, call, token,
    /** 模拟客户端长轮询：对齐水位；wantEvents=true 时取一次增量。 */
    connect: async ({ wantEvents = false, since } = {}) => {
      const first = await call('/events', { query: { wait: '0', client: 'pet-test' } })
      if (!wantEvents) return { cursor: first.json.cursor, events: [] }
      const r = await call('/events', { query: { since: String(since ?? first.json.cursor), wait: '0', client: 'pet-test' } })
      return { cursor: first.json.cursor, events: r.json.events }
    },
    setConfig: (patch) => { cfgPatch = { ...cfgPatch, ...patch } },
    houseDir: (...p) => api.dataDir('house', ...p),
  }
}

const MANIFEST = JSON.stringify({ world: { w: 1672, h: 941 }, poses: { sofa: { frames: [] } } })

test('小屋：素材未就绪时 /house/manifest 404；放入后可取到 JSON', async () => {
  const env = startModule()
  const none = await env.call('/house/manifest')
  assert.equal(none.status, 404, '没放素材：404（客户端显示「素材未就绪」，不白屏）')

  mkdirSync(env.houseDir(), { recursive: true })
  writeFileSync(env.houseDir('manifest.json'), MANIFEST)
  const ok = await env.call('/house/manifest')
  assert.equal(ok.status, 200)
  assert.equal(ok.json.world.w, 1672)
})

test('小屋：/asset/house/<file> 精确注册（原始名+编码名）；坏令牌 401；严格隔离', async () => {
  const env = startModule()
  mkdirSync(env.houseDir(), { recursive: true })
  writeFileSync(env.houseDir('day.jpg'), Buffer.from('fakejpg'))
  writeFileSync(env.houseDir('姿势 图.png'), Buffer.from('fakepng'))
  env.exports.ensureHouseRoutes() // 启动后新放的素材，靠刷新补注册（120s tick / /config 同款入口）

  const day = await env.call('/asset/house/day.jpg', { query: { token: env.token } })
  assert.equal(day.status, 200)
  assert.equal(day.headers['content-type'], 'image/jpeg')
  assert.equal(String(day.raw), 'fakejpg', '字节原样返回（fake res 里可能是 Buffer 也可能是串）')

  const enc = await env.call('/asset/house/' + encodeURIComponent('姿势 图.png'), { query: { token: env.token } })
  assert.equal(enc.status, 200, '百分号编码名也注册了')
  assert.equal(enc.headers['content-type'], 'image/png')

  const bad = await env.call('/asset/house/day.jpg', { token: null, query: { token: 'deadbeef'.repeat(6) } })
  assert.equal(bad.status, 401, 'query token 校验（素材 URL 带不了自定义头）')

  const noToken = await env.call('/asset/house/day.jpg', { token: null })
  assert.equal(noToken.status, 401, '没带令牌也 401（回环也不免检）')
})

test('小屋：/house/state POST 落盘 + GET 回读 + emit(\'house\')；say 截断', async () => {
  const env = startModule()
  const first = await env.connect({ wantEvents: true })
  const r = await env.call('/house/state', {
    method: 'POST',
    json: { night: true, state: 'sofa', floor: 1, say: 'x'.repeat(500) },
  })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.state.night, true)
  assert.equal(r.json.state.lastSay.length <= 200, true, '超长台词截断到 200')

  const back = await env.call('/house/state')
  assert.equal(back.json.ok, true)
  assert.equal(back.json.state.state, 'sofa')
  assert.ok(back.json.state.lastSayAt > 0)

  const ev = await env.connect({ wantEvents: true, since: first.cursor })
  assert.ok(ev.events.some((e) => e.type === 'house'), '状态变更经事件总线广播（行为大脑三期消费）')

  const floor = await env.call('/house/state', { method: 'POST', json: { floor: 2 } })
  assert.equal(floor.json.state.floor, 2)
  const badFloor = await env.call('/house/state', { method: 'POST', json: { floor: 9 } })
  assert.equal(badFloor.json.state.floor, 1, '楼层只认 1/2')
})

test('小屋：houseStatus 汇报素材与开关；petHouseEnabled=false 时 /house/manifest 404', async () => {
  const env = startModule()
  assert.equal(env.exports.houseStatus().enabled, true, '默认开启')
  assert.equal(env.exports.houseStatus().manifestReady, false)

  mkdirSync(env.houseDir(), { recursive: true })
  writeFileSync(env.houseDir('manifest.json'), MANIFEST)
  const st = env.exports.houseStatus()
  assert.equal(st.manifestReady, true)
  assert.equal(st.files >= 1, true)

  env.setConfig({ petHouseEnabled: false })
  assert.equal(env.exports.houseStatus().enabled, false)
  const off = await env.call('/house/manifest')
  assert.equal(off.status, 404, '开关关掉：入口 404（素材路由仍守着不外泄内容）')
  const stateOff = await env.call('/house/state')
  assert.equal(stateOff.status, 200, '状态读写不因开关中断（行为大脑仍可读）')
})

test('小屋：客户端模板清单包含 house.html / house.js（生成物对账）', async () => {
  const env = startModule()
  const cs = env.exports.clientStatus()
  const names = (cs.files || []).map((f) => f.name)
  assert.ok(names.includes('house.html'), 'house.html 进 CLIENT_FILES')
  assert.ok(names.includes('house.js'), 'house.js 进 CLIENT_FILES')
})

test('小屋（三期）：enter_house 行为动作进表；behaviorEmit 可下发', async () => {
  const env = startModule()
  const acts = env.exports.behaviorActionsForTest()
  const eh = acts.find((a) => a.action === 'enter_house')
  assert.ok(eh, 'enter_house 在动作表里')
  assert.ok(eh.say, 'enter_house 有默认台词（每个动作都要顶气泡的铁律）')
  assert.ok(/key/.test(eh.params), '参数说明里写清 key 取值')

  const first = await env.connect({ wantEvents: true })
  await env.exports.behaviorEmit({ action: 'enter_house', params: { key: 'sleep' }, playbackId: 'p1' })
  const ev = await env.connect({ wantEvents: true, since: first.cursor })
  const b = ev.events.find((e) => e.type === 'behavior')
  assert.ok(b, 'behavior 事件已下发')
  assert.equal(b.action, 'enter_house')
  assert.equal(b.params.key, 'sleep')
})
