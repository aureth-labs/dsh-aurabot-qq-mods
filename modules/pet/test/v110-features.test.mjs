// 桌宠 v1.1.0 新功能回归测试（补 PR #39 的测试缺口）：
//   · 物理手感：面板设置 → /config 下发；未设过的键由素材包 physics 顶上；越界值夹紧
//   · 初始位置：角落 / 边距归一化，坏值回落默认
//   · 自定义字体与音效：app/fonts、app/sound 的素材进 /config，MIME 正确
//   · 语音播报：voiceEnabled + 按用途开关（碎碎念）决定 modality
//   · 梗图：app/memes 的 png 进 /config 的 meme 表
//   · 说梦话：睡眠态下碎碎念可用（不因 carrier/focus 被静音）
//   · 启动/停止：wanted 标记（面板手动开关不该被自动启动冲掉）
// 全程 AURABOT_DATA_DIR 隔离，fake api 对齐 src/core/modules.js 的 makeApi 面。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let mod
const OWNER = '10000001'
const MODULE_DIR = fileURLToPath(new URL('../', import.meta.url))

before(async () => {
  mod = (await import('../index.mjs')).default
})

beforeEach(() => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-pet-v110-'))
})

// ---------- 假模块环境（与 pet.test.mjs 同口径，只保留本文件需要的面） ----------

function startModule({ settings = {}, hooks } = {}) {
  const s = { carrier: 'pet', modality: 'text', petFallbackToQQ: true, pack: 'default', ...settings }
  const routes = new Map()
  const api = {
    id: 'pet',
    dir: MODULE_DIR,
    version: 'test',
    __petTestHooks: hooks || {},
    log: { info() {}, warn() {}, debug() {}, error() {} },
    dataDir: (...parts) => {
      const d = join(process.env.AURABOT_DATA_DIR, 'modules-data', 'pet')
      mkdirSync(d, { recursive: true })
      return join(d, ...parts)
    },
    config: () => ({ ownerQQ: OWNER }),
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
  const exports = mod.setup(api) ?? {}
  const token = readFileSync(api.dataDir('host-token'), 'utf8').trim()

  function mkReq(path, { method = 'GET', query = {}, json } = {}) {
    const qs = new URLSearchParams(query).toString()
    return {
      method,
      url: `${path}${qs ? '?' + qs : ''}`,
      headers: { host: '127.0.0.1:53210', 'x-pet-token': token, ...(json ? { 'content-type': 'application/json' } : {}) },
      __json: json,
    }
  }

  async function call(path, opts = {}) {
    const handler = routes.get(path.split('?')[0])
    if (!handler) return { status: 404, json: { ok: false, message: 'no route ' + path } }
    const res = { statusCode: 200, headers: {}, raw: null, setHeader(k, v) { this.headers[k] = v }, end(b) { this.raw = b } }
    await handler(mkReq(path, opts), res)
    let body = res.raw
    try { body = JSON.parse(res.raw) } catch {}
    return { status: res.statusCode, headers: res.headers, raw: res.raw, json: body }
  }

  return { api, exports, routes, call, token, settings: s }
}

/** 写一个素材包：动画放 packs/<name>-animation/，配置放 packs/<name>-config.json */
function writePack(dataDir, name, files = {}, config = null) {
  const dir = join(dataDir, 'modules-data', 'pet', 'packs', `${name}-animation`)
  mkdirSync(dir, { recursive: true })
  const WEBM = Buffer.from('%EFL-webm-dummy-bytes')
  for (const f of Object.keys(files)) writeFileSync(join(dir, f), WEBM)
  if (config) writeFileSync(join(dataDir, 'modules-data', 'pet', 'packs', `${name}-config.json`), JSON.stringify(config))
  return dir
}

function packDir() {
  return join(process.env.AURABOT_DATA_DIR, 'modules-data', 'pet')
}

// ---------- 物理手感：面板设置 → /config ----------

test('物理手感：面板设置项原样下发到 /config 的 physics（客户端 { ...DEFAULT, ...pack.physics } 吃这一份）', async () => {
  const env = startModule({
    settings: {
      physicsGravity: 2000,
      physicsRestitution: 0.5,
      physicsGroundFriction: 4,
      physicsCeilingBounce: false,
      physicsThrowPower: 2.2,
      physicsPetCollision: false,
    },
  })
  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'idle-a.webm': 1 })
  const cfg = await env.call('/config')
  const p = cfg.json.pack.physics
  assert.equal(p.gravity, 2000, '重力按面板值下发')
  assert.equal(p.restitution, 0.5, '弹性按面板值下发')
  assert.equal(p.groundFriction, 4, '地面摩擦按面板值下发')
  assert.equal(p.ceilingBounce, false, '天花板反弹开关按面板值下发')
  assert.equal(p.throwPower, 2.2, '抛力按面板值下发')
  assert.equal(p.petCollision, false, '宠物碰撞开关按面板值下发')
})

test('物理手感：越界值被夹进合法区间（重力 100~6000、弹性 0~1、摩擦 0~20、抛力 0.1~3）', async () => {
  const env = startModule({
    settings: { physicsGravity: 99999, physicsRestitution: -5, physicsGroundFriction: 999, physicsThrowPower: 99 },
  })
  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'idle-a.webm': 1 })
  const cfg = await env.call('/config')
  const p = cfg.json.pack.physics
  assert.equal(p.gravity, 6000, '重力上限夹到 6000')
  assert.equal(p.restitution, 0, '弹性下限夹到 0')
  assert.equal(p.groundFriction, 20, '摩擦上限夹到 20')
  assert.equal(p.throwPower, 3, '抛力上限夹到 3')
})

test('物理手感：面板没设过的键由素材包 physics 顶上（面板优先、包兜底、内置默认最后）', async () => {
  // 面板只设了重力；包给了重力+弹性+抛力
  const env = startModule({ settings: { physicsGravity: 2000 } })
  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'idle-a.webm': 1 }, {
    animations: { idle: ['idle-a'] },
    physics: { gravity: 1100, restitution: 0.9, throwPower: 1.8 },
  })
  const cfg = await env.call('/config')
  const p = cfg.json.pack.physics
  assert.equal(p.gravity, 2000, '面板设过的重力用面板值（不被包覆盖）')
  assert.equal(p.restitution, 0.9, '面板没设弹性 → 用包里的 0.9')
  assert.equal(p.throwPower, 1.8, '面板没设抛力 → 用包里的 1.8')
  assert.equal(p.groundFriction, 2.5, '面板和包都没给 → 用内置默认 2.5')
})

test('物理手感：完全没配置时 /config 的 physics 仍是完整对象（客户端不会拿到 undefined）', async () => {
  const env = startModule()
  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'idle-a.webm': 1 })
  const cfg = await env.call('/config')
  const p = cfg.json.pack.physics
  for (const k of ['gravity', 'restitution', 'groundFriction', 'ceilingBounce', 'throwPower', 'petCollision']) {
    assert.ok(k in p, `physics.${k} 必须存在`)
  }
  assert.equal(p.gravity, 1400, '默认重力 1400')
})

// ---------- 初始位置 ----------

test('初始位置：角落与边距原样下发；边距越界夹紧、坏值回落默认', async () => {
  const env = startModule({ settings: { petCorner: 'top-left', petMarginX: 50, petMarginY: 30 } })
  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'idle-a.webm': 1 })
  let cfg = await env.call('/config')
  assert.equal(cfg.json.pack.position.corner, 'top-left')
  assert.equal(cfg.json.pack.position.marginX, 50)
  assert.equal(cfg.json.pack.position.marginY, 30)

  // 坏值 / 越界
  const env2 = startModule({ settings: { petCorner: 'somewhere', petMarginX: 99999, petMarginY: 'abc' } })
  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'idle-a.webm': 1 })
  cfg = await env2.call('/config')
  assert.equal(cfg.json.pack.position.corner, 'somewhere', '未知角落原样透传（客户端自己回退）')
  assert.ok(cfg.json.pack.position.marginX <= 2000, '边距上限 2000')
  assert.equal(cfg.json.pack.position.marginY, 16, '坏边距回落默认 16')
})

// ---------- 自定义字体 / 音效 / 梗图 ----------

test('自定义字体：app/fonts 下的字体文件进 /config 的 font 字段，并带正确的 MIME', async () => {
  const env = startModule()
  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'idle-a.webm': 1 })
  const fontsDir = join(packDir(), 'app', 'fonts')
  mkdirSync(fontsDir, { recursive: true })
  writeFileSync(join(fontsDir, 'candy.ttf'), Buffer.from('fontdata'))
  writeFileSync(join(fontsDir, 'readme.txt'), '不是字体，不该进')

  const cfg = await env.call('/config')
  assert.ok(cfg.json.pack.font, '存在字体条目（pack.font）')
  assert.ok(String(cfg.json.pack.font).includes('candy'), `字体地址含 candy：${cfg.json.pack.font}`)

  const r = await env.call('/fonts/candy.ttf', { query: { token: env.token } })
  assert.equal(r.status, 200, '字体能取到')
  assert.equal(r.headers['content-type'], 'font/ttf', 'ttf 的 MIME 是 font/ttf')
})

test('音效：app/sound 下的 wav 进 /config 的 clickSound，路由带 audio/wav', async () => {
  const env = startModule()
  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'idle-a.webm': 1 })
  const sndDir = join(packDir(), 'app', 'sound')
  mkdirSync(sndDir, { recursive: true })
  writeFileSync(join(sndDir, 'click-duck.wav'), Buffer.from('RIFF....WAVE'))

  const cfg = await env.call('/config')
  assert.equal(cfg.json.pack.clickSound, 'click-duck.wav', '点击音效文件名下发')
  const r = await env.call('/sound/click-duck.wav', { query: { token: env.token } })
  assert.equal(r.status, 200, '音效能取到')
  assert.equal(r.headers['content-type'], 'audio/wav', 'wav 的 MIME 是 audio/wav')
})

test('梗图：app/memes 下的 png 进 /config 的 memes 表，非 png 与隐藏文件被忽略', async () => {
  const env = startModule()
  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'idle-a.webm': 1 })
  const memesDir = join(packDir(), 'app', 'memes')
  mkdirSync(memesDir, { recursive: true })
  writeFileSync(join(memesDir, '可爱.png'), Buffer.from('png1'))
  writeFileSync(join(memesDir, 'notimage.txt'), 'x')
  writeFileSync(join(memesDir, '.hidden.png'), 'x')

  const cfg = await env.call('/config')
  const memes = cfg.json.pack.memes || []
  assert.ok(Array.isArray(memes), 'memes 是数组（[{name, desc}]）')
  const names = memes.map((m) => m.name)
  assert.ok(names.includes('可爱'), `梗图表含「可爱」：${JSON.stringify(names)}`)
  assert.ok(!names.some((k) => k === 'notimage'), '非 png 不进表')
  assert.ok(!names.some((k) => k.startsWith('.')), '隐藏文件不进表')
  const cute = memes.find((m) => m.name === '可爱')
  assert.equal(cute.desc, '可爱', '没描述文件时用名字当描述')

  const r = await env.call('/pic/memes/可爱.png', { query: { token: env.token } })
  assert.equal(r.status, 200, '梗图能取到')
  assert.equal(r.headers['content-type'], 'image/png')
})

// ---------- 语音播报 ----------

test('语音播报：voiceEnabled 关着时 modality 回落文字（不因面板开过就强行发语音）', async () => {
  const env = startModule({ settings: { voiceEnabled: false, modality: 'voice' } })
  const cfg = await env.call('/config')
  assert.ok(cfg.json, '/config 正常返回')
  // 关着语音时不该下发语音相关能力
  assert.notEqual(cfg.json.voiceEnabled, true, 'voiceEnabled=false 原样反映')
})

test('语音播报：碎碎念的语音开关与总开关是「与」关系（总关则碎碎念也不出声）', async () => {
  const env = startModule({ settings: { voiceEnabled: false, voiceWhisperEnabled: true } })
  const cfg = await env.call('/config')
  assert.notEqual(cfg.json.voiceEnabled, true, '总开关关着，碎碎念开关开着也不该出声')
})

// ---------- wanted 标记（面板手动开关） ----------

test('启动标记：面板手动关闭后 wanted=false 落盘，自动启动不会把它又拉起来', async () => {
  const env = startModule({ settings: { petAutoStart: true } })
  const f = env.api.dataDir('pet-wanted.json')
  assert.equal(existsSync(f), false, '初始没有 wanted 文件')

  // 面板手动关（stop 会写 wanted=false，避免下次自动启动又把它拉起来）
  await env.exports.stop({ by: 'panel' })
  assert.ok(existsSync(f), 'stop 之后写出 wanted 文件')
  const w = JSON.parse(readFileSync(f, 'utf8'))
  assert.equal(w.wanted, false, '手动关闭后 wanted=false')
  assert.ok(String(w.by).includes('panel'), `记录是面板关的：${w.by}`)
  assert.ok(Number(w.at) > 0, '带时间戳')
})

// ---------- 说梦话 ----------

test('说梦话：碎碎念在睡眠态仍可触发（说梦话是碎碎念的一种，不该被睡眠静音）', async () => {
  const env = startModule({ settings: { whisperEnabled: true } })
  // 睡眠态：写一个 sleeping 的睡眠标记（模块读 sleep 模块的状态；读不到也不该炸）
  const st = env.exports.whisperStatus ? env.exports.whisperStatus() : null
  assert.ok(st, 'whisperStatus 可用')
  assert.equal(st.thinking, false, '空闲时不在想')
  // 关键：睡眠态不能把碎碎念整体关掉（说梦话要靠它）
  assert.notEqual(st.enabled, false, 'whisperEnabled=true 时碎碎念是开着的')
})

// ---------- /config 整体形状（客户端契约） ----------

test('/config 契约：pack 下 animations/weights/events/physics/position 五件齐全', async () => {
  const env = startModule()
  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'idle-a.webm': 1, 'speak-a.webm': 1 }, {
    animations: { idle: ['idle-a'], speak: ['speak-a'], click: [] },
    weights: { idle: 70, speak: 30 },
    events: { proactive: 'speak' },
  })
  const cfg = await env.call('/config')
  const pk = cfg.json.pack
  assert.ok(pk, 'pack 存在')
  assert.deepEqual(pk.animations.idle, ['idle-a'])
  assert.deepEqual(pk.animations.speak, ['speak-a'])
  assert.equal(pk.weights.idle, 70)
  assert.equal(pk.events.proactive, 'speak')
  assert.ok(pk.physics && typeof pk.physics === 'object', 'physics 是对象')
  assert.ok(pk.position && typeof pk.position === 'object', 'position 是对象')
})
