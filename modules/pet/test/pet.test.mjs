// 桌宠模块（pet）测试：
//   · 载体互斥不双发 / 离线回落 QQ（petFallbackToQQ）
//   · 心跳在线判定（轮询 /events 刷新 presence，60s TTL）
//   · focus.json 开关（含坏文件 fail-open）与 force 绕过
//   · TTS 产物即刻转存进 pet 数据目录（voice-cache 24h 清理不能直接指给客户端）
//   · P2 动画点播：事件带 anim + playbackId，POST /playback 回执
//   · P1/P4 形象包：packs 扫描、/config 包视图、/asset 严格隔离（404 不回落）、/pack 切换
//   · P3 拖拽物理移植（physics.js 纯函数：弹簧/软钳速/抛体积分/松手初速/挤压）
// 全程 AURABOT_DATA_DIR 隔离，fake api 模仿 modules.js 的 makeApi 面，不引入新依赖。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'

let mod
const OWNER = '10000001'
const MODULE_DIR = fileURLToPath(new URL('../', import.meta.url))

before(async () => {
  mod = (await import('../index.mjs')).default
})

beforeEach(() => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-pet-'))
})

// ---------- 假模块环境（对齐 src/core/modules.js 的 makeApi 面） ----------

function startModule({ settings = {}, hooks } = {}) {
  const s = { carrier: 'pet', modality: 'text', petFallbackToQQ: true, pack: 'default', ...settings }
  const routes = new Map()
  const sentToQQ = []
  let voiceFile = ''
  const api = {
    id: 'pet',
    dir: MODULE_DIR,
    version: 'test',
    __petTestHooks: hooks || {}, // 测试注入 fake spawn/kill：不打真网络、不真启动 Electron
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
    has: (id) => (id === 'mood' && moodValue != null) || (id === 'voice' && Boolean(voiceFile)),
    use: (id) => (id === 'mood' ? { current: () => moodValue } : id === 'voice' ? { speak: async () => ({ file: voiceFile, engine: 'fake' }) } : null),
    sendText: async (chatId, text) => { sentToQQ.push({ chatId, text }) },
    core: {
      http: {
        send: (res, code, body) => { res.statusCode = code; res.end(JSON.stringify(body)) },
        query: (req) => { try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams) } catch { return {} } },
        body: async (req) => req.__json ?? {},
      },
    },
  }
  let moodValue = 75 // happy
  let memItems = []
  let memAdds = []       // 对话框测试：memory.add 的写入记录（看 about/tags 归属）
  let memHintCalls = []  // 对话框测试：recallHint 的调用记录（看合成的私聊上下文）
  let memHintText = ''   // recallHint 的固定返回（setMemHint 配）
  let thinkReply = ''
  let thinkHold = null // 非空时 think 挂着不返回（测"上一句还在想"的并发闸）
  const thinkCalls = []
  api.use = (id) => (id === 'mood' ? { current: () => moodValue }
    : id === 'voice' ? { speak: async () => ({ file: voiceFile, engine: 'fake' }) }
      : id === 'memory' ? {
          list: (q) => (q ? memItems.filter((m) => String(m.text).includes(q)) : memItems.slice()),
          add: (o) => { memAdds.push({ ...(o || {}) }); return { id: 'm' + memAdds.length } },
          recallHint: (chat, q, prev) => { memHintCalls.push({ chat: { ...chat }, q, prev }); return memHintText },
        }
        : null)
  api.has = (id) => (id === 'mood') || (id === 'voice' && Boolean(voiceFile)) || (id === 'memory' && memItems.length > 0)
  // 对齐 modules.js 的 api.think：后台系统回合（工作区里能看到这条会话的思考过程）
  api.think = async (prompt, opts = {}) => {
    thinkCalls.push({ prompt, title: opts.title, noTools: opts.noTools, key: opts.key })
    if (thinkHold) await thinkHold
    return thinkReply
  }
  const exports = mod.setup(api) ?? {}
  const token = readFileSync(api.dataDir('host-token'), 'utf8').trim()

  function req(path, { method = 'GET', query = {}, token: tk = token, json, headers = {}, socket } = {}) {
    const qs = new URLSearchParams(query).toString()
    const r = {
      method,
      url: `${path}${qs ? '?' + qs : ''}`,
      headers: { host: '127.0.0.1:53210', ...(tk ? { 'x-pet-token': tk } : {}), ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
      __json: json,
    }
    // 模拟真实连接的来源地址。不传 = 进程内直调（socket 缺省，模块按本机处理）。
    // 传 '203.0.113.9' 这类地址 = 模拟从外网直连进来；传 '127.0.0.1' = 模拟本机/反代接入。
    if (socket) r.socket = { remoteAddress: socket }
    return r
  }
  async function call(path, opts = {}) {
    const handler = routes.get(path.split('?')[0])
    if (!handler) return { status: 404, json: { ok: false, message: 'no route ' + path } } // 精确匹配：没注册的子路径就是 404
    const res = { statusCode: 200, headers: {}, raw: null, setHeader(k, v) { this.headers[k] = v }, end(b) { this.raw = b } }
    await handler(req(path, opts), res)
    let body = res.raw
    try { body = JSON.parse(res.raw) } catch {}
    return { status: res.statusCode, headers: res.headers, raw: res.raw, json: body }
  }
  /** 模拟一个客户端连上长轮询：刷新心跳并对齐水位；wantEvents=true 时再取一次增量。 */
  async function connect({ wantEvents = false, since } = {}) {
    const first = await call('/events', { query: { wait: '0', client: 'pet-test' } })
    assert.equal(first.json.ok, true)
    if (!wantEvents) return { cursor: first.json.cursor, events: [] }
    const r = await call('/events', { query: { since: String(since ?? first.json.cursor), wait: '0', client: 'pet-test' } })
    return { cursor: first.json.cursor, events: r.json.events }
  }
  return {
    api, exports, routes, call, connect, token, sentToQQ,
    setVoiceFile: (f) => { voiceFile = f }, setMood: (v) => { moodValue = v },
    setMemory: (list) => { memItems = list }, setThinkReply: (t) => { thinkReply = t },
    holdThink: (p) => { thinkHold = p }, thinkCalls,
    memAdds, memHintCalls, setMemHint: (t) => { memHintText = t },
  }
}

// ---------- P0：发现文件 / 鉴权 / 端口漂移 ----------

test('P0：host.json + host-token 落盘；端口从 Host 头学习并重写', async () => {
  const env = startModule()
  const hostFile = env.api.dataDir('host.json')
  assert.ok(existsSync(hostFile))
  const h1 = JSON.parse(readFileSync(hostFile, 'utf8'))
  assert.equal(h1.version, 1)
  assert.equal(h1.api, '/aurabot/api')
  assert.equal(h1.token, env.token, 'host.json 里的 token 与 host-token 一致')
  assert.equal(h1.baseUrl, null, '端口未注入时写 null（客户端 readHost 对 null 等待，不再写假 :0 造成自举死锁）')
  assert.equal(env.exports.status().portReady, false, 'status 报「端口未就绪」')

  const bad = await env.call('/status', { token: 'deadbeef'.repeat(6) })
  assert.equal(bad.status, 401, '坏令牌 401')
  const ok = await env.call('/status')
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.portReady, true, '第一次请求（带 Host 头）后端口即就绪（学习路径）')

  const h2 = JSON.parse(readFileSync(hostFile, 'utf8'))
  assert.ok(h2.baseUrl.endsWith(':53210'), `第一次请求后从 Host 头学到真实端口：${h2.baseUrl}`)
})

test('端口注入：setWebPort 写对 host.json；非法端口拒绝；Host 头学习仍能纠正漂移', async () => {
  const env = startModule()
  const hostFile = env.api.dataDir('host.json')
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, null, '注入前：null')

  assert.equal(env.exports.setWebPort(0), false, '非法端口拒绝')
  assert.equal(env.exports.setWebPort('abc'), false, '非数字拒绝')
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, null, '非法注入不写文件')

  assert.equal(env.exports.setWebPort(53211), true)
  const h = JSON.parse(readFileSync(hostFile, 'utf8'))
  assert.equal(h.baseUrl, 'http://127.0.0.1:53211', '注入后 host.json 立刻就绪')
  assert.equal(env.exports.status().portReady, true)
  assert.equal(env.exports.status().port, 53211)

  // 漂移纠正：宿主重启换了端口（注入的是旧的），客户端带新端口来请求 → Host 学习覆盖
  await env.call('/status', { headers: { host: '127.0.0.1:53299' } })
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, 'http://127.0.0.1:53299', 'Host 头学习仍能纠正漂移')
  assert.equal(env.exports.setWebPort(53211), true, '重复注入同端口幂等')
})

test('P0：心跳在线判定——连过 /events 即在线；没连过的实例是离线', async () => {
  const env = startModule()
  assert.equal(env.exports.online().online, false, '没人轮询：离线')
  await env.connect()
  const on = env.exports.online()
  assert.equal(on.online, true)
  assert.equal(on.clients, 1)
  const offline = startModule()
  assert.equal(offline.exports.online().online, false, '另一个数据目录的实例不受影响')
})

// ---------- 载体互斥 / 回落 ----------

test('互斥：carrier=qq 时 dispatch 不推气泡也不代发 QQ；carrier=pet 且在线只推气泡不双发', async () => {
  const qq = startModule({ settings: { carrier: 'qq' } })
  const r1 = await qq.exports.dispatch({ text: '在吗' })
  assert.equal(r1.via, 'qq')
  assert.equal(r1.reason, 'carrier-qq')
  assert.equal(qq.sentToQQ.length, 0, 'carrier=qq：桌宠不代发')
  const { cursor } = await qq.connect()
  const got = await qq.connect({ wantEvents: true, since: cursor })
  assert.equal(got.events.filter((e) => e.type === 'proactive').length, 0, '没推气泡')

  const pet = startModule({ settings: { carrier: 'pet' } })
  await pet.connect()
  const r2 = await pet.exports.dispatch({ text: '想你了' })
  assert.equal(r2.ok, true)
  assert.equal(r2.via, 'pet')
  assert.equal(pet.sentToQQ.length, 0, '桌宠在线：绝不双发 QQ')
  assert.equal(r2.message.type, 'proactive')
  assert.equal(r2.message.mood, 'happy', 'mood 由 api.use(\'mood\').current() 映射')
})

test('情绪画像：dispatch 带 emotion/emotionProfile → 消息透传（坏值钳制，没带为 null）', async () => {
  const pet = startModule({ settings: { carrier: 'pet' } })
  await pet.connect()
  const r = await pet.exports.dispatch({
    text: '看到新插件好想试！',
    emotion: 'excited',
    emotionProfile: { valence: 5, arousal: 2 }, // 越界值应被钳进 [-1,1]/[0,1]
  })
  assert.equal(r.ok, true)
  assert.equal(r.message.emotion, 'excited')
  assert.deepEqual(r.message.emotionProfile, { valence: 1, arousal: 1 }, '越界画像被钳制')
  // 没带画像 → null；带了坏对象也 null（不炸投递）
  const r2 = await pet.exports.dispatch({ text: '普通气泡', emotionProfile: { valence: 'x' } })
  assert.equal(r2.message.emotion, '')
  assert.equal(r2.message.emotionProfile, null)
  // /events 轮询拿到的 proactive 事件同样带画像（客户端辉光靠它）
  await pet.connect()
  const ev = await pet.connect({ wantEvents: true, since: 0 })
  const withEmo = ev.events.filter((e) => e.type === 'proactive' && e.emotion === 'excited')
  assert.ok(withEmo.length >= 1, '事件流里的 proactive 带情绪画像')
  assert.deepEqual(withEmo[0].emotionProfile, { valence: 1, arousal: 1 })
})

test('回落：pet 离线且 petFallbackToQQ → 发一次 QQ 私聊；关回落则不发', async () => {
  const env = startModule({ settings: { carrier: 'pet', petFallbackToQQ: true } })
  const r = await env.exports.dispatch({ text: '主人吃了吗' })
  assert.equal(r.via, 'qq')
  assert.equal(r.fallback, true)
  assert.deepEqual(env.sentToQQ, [{ chatId: `private:${OWNER}`, text: '主人吃了吗' }], '只发一次 QQ，无双发')

  const env2 = startModule({ settings: { carrier: 'pet', petFallbackToQQ: false } })
  const r2 = await env2.exports.dispatch({ text: '在吗' })
  assert.equal(r2.ok, false)
  assert.equal(r2.reason, 'pet-offline')
  assert.equal(env2.sentToQQ.length, 0)
})

// ---------- focus ----------

test('focus：开专注拦自动轮次（不回落）；force 可绕；坏 focus.json 按关闭（fail-open）', async () => {
  const env = startModule()
  await env.connect()
  await env.call('/focus', { method: 'POST', json: { enabled: true, source: 'test' } })
  const r = await env.exports.dispatch({ text: '想跟你说件事' })
  assert.equal(r.reason, 'focus')
  assert.equal(env.sentToQQ.length, 0, '专注：不发也不回落')
  const f = JSON.parse(readFileSync(env.api.dataDir('focus.json'), 'utf8'))
  assert.equal(f.enabled, true)
  assert.equal(f.source, 'test')

  const forced = await env.call('/bubble', { method: 'POST', json: { text: '面板测试', force: true } })
  assert.equal(forced.json.ok, true, 'force（面板手动测试）绕过专注')

  writeFileSync(env.api.dataDir('focus.json'), '{ 坏掉的 json')
  assert.equal(env.exports.focus(), false, '坏文件按关闭')
  const r2 = await env.exports.dispatch({ text: '又到点了' })
  assert.equal(r2.via, 'pet', '坏 focus.json：fail-open，照常投递')
})

// ---------- TTS 转存 ----------

test('TTS：voice 产物即刻转存 pet/voice/<sha1>.wav，audio.url 走 /audio/ 且不含 voice-cache', async () => {
  const env = startModule({ settings: { carrier: 'pet', modality: 'voice' } })
  const fakeWav = join(process.env.AURABOT_DATA_DIR, 'voice-cache', 'tmp.wav')
  mkdirSync(dirname(fakeWav), { recursive: true })
  writeFileSync(fakeWav, Buffer.from('RIFF....WAVEfmt fake audio bytes'))
  env.setVoiceFile(fakeWav)
  await env.connect()
  const r = await env.exports.dispatch({ text: '用声音说想你' })
  assert.equal(r.via, 'pet')
  const audio = r.message.audio
  assert.ok(audio, 'voice 模式给出音频')
  assert.match(audio.url, /^\/aurabot\/api\/audio\/[a-f0-9]{40}\.wav\?token=/)
  assert.ok(!audio.url.includes('voice-cache'), '不能直接指 voice-cache（24h 清理会 404）')
  const stored = env.api.dataDir('voice', `${audio.key}.wav`)
  assert.ok(existsSync(stored), `转存文件在 pet 数据目录：${stored}`)
  const buf = readFileSync(stored)
  const { createHash } = await import('node:crypto')
  assert.equal(createHash('sha1').update(buf).digest('hex'), audio.key, '内容寻址命名')
  const audioRes = await env.call(`/audio/${audio.key}.wav`, { query: { token: env.token } })
  assert.equal(audioRes.status, 200)
  assert.equal(audioRes.headers['content-type'], 'audio/wav')
  assert.equal(audioRes.headers['cache-control'], 'private, max-age=86400')
})

// ---------- P2：anim 点播 + playbackId 回执 ----------

test('P2：事件可选带 anim + playbackId；客户端 POST /playback 回执被登记', async () => {
  const env = startModule()
  const { cursor } = await env.connect() // 先对齐水位，再触发点播
  const r = await env.call('/bubble', { method: 'POST', json: { text: '看我的动作', anim: 'wave' } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.message.anim, 'wave')
  assert.match(r.json.message.playbackId, /^[a-f0-9]{8}$/)
  const got = await env.connect({ wantEvents: true, since: cursor })
  const ev = got.events.find((e) => e.type === 'proactive')
  assert.equal(ev.anim, 'wave')
  assert.equal(ev.playbackId, r.json.message.playbackId, '事件里的回执号一致')

  const noAnim = await env.call('/bubble', { method: 'POST', json: { text: '不带动画' } })
  assert.equal(noAnim.json.message.anim, undefined, '不带 anim 就没有该字段（可选字段，purpose 不用改）')
  assert.equal(noAnim.json.message.playbackId, undefined)

  const ack = await env.call('/playback', { method: 'POST', json: { playbackId: r.json.message.playbackId, anim: 'wave', status: 'played' } })
  assert.equal(ack.json.ok, true)
  const hist = await env.call('/history')
  assert.ok(hist.json.playbacks.some((p) => p.playbackId === r.json.message.playbackId), '回执进了 /history')
  const st = env.exports.status()
  assert.equal(st.playbackCount, 1)
})

// ---------- P1/P4：形象包与素材路由 ----------

function writePack(dataDir, name, files, config) {
  const dir = join(dataDir, 'modules-data', 'pet', 'packs', `${name}-animation`)
  mkdirSync(dir, { recursive: true })
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body)
  if (config) writeFileSync(join(dataDir, 'modules-data', 'pet', 'packs', `${name}-config.json`), JSON.stringify(config))
  return dir
}
const WEBM = Buffer.from('%EFL-webm-dummy-bytes')

test('P1/P4：packs 扫描、/config 包视图、/asset 严格隔离（404 不回落）、/pack 切换', async () => {
  const env = startModule()
  const dd = process.env.AURABOT_DATA_DIR
  writePack(dd, 'default', { 'idle-a.webm': WEBM, 'speak-a.webm': WEBM }, {
    animations: { idle: ['idle-a'], speak: ['speak-a'], click: [] },
    weights: { idle: 70, speak: 30 },
    events: { proactive: 'speak' },
    physics: { gravity: 1200 },
  })
  writePack(dd, 'fish', { 'fish-idle.webm': WEBM }, { animations: { idle: ['fish-idle'] } })

  const packs = await env.call('/packs')
  assert.equal(packs.json.ok, true)
  assert.deepEqual(packs.json.packs.map((p) => p.name).sort(), ['default', 'fish'])
  assert.equal(packs.json.active, 'default', 'settings.pack=default 命中')

  const cfg = await env.call('/config')
  assert.equal(cfg.json.pack.name, 'default')
  assert.deepEqual(cfg.json.pack.animations.idle, ['idle-a'])
  assert.equal(cfg.json.pack.physics.gravity, 1200, 'pack 配置的物理参数透传（P3 参数可覆盖）')

  const asset = await env.call('/asset/default/idle-a.webm', { query: { token: env.token } })
  assert.equal(asset.status, 200)
  assert.equal(asset.headers['content-type'], 'video/webm')
  assert.ok(Buffer.isBuffer(asset.raw) || Buffer.isBuffer(Buffer.from(asset.raw)), '素材二进制原样返回')

  assert.equal((await env.call('/asset/default/missing.webm', { query: { token: env.token } })).status, 404, '包内缺文件 404')
  assert.equal((await env.call('/asset/default/speak-a.webm', { query: { token: env.token } })).status, 200)
  assert.equal((await env.call('/asset/fish/speak-a.webm', { query: { token: env.token } })).status, 404, '严格隔离：fish 没有的素材 404，绝不回落 default')
  assert.equal((await env.call('/asset/default/..%2F..%2Fhost.json', { query: { token: env.token } })).status, 404, '路径穿越不注册路由 → 404')
  assert.equal((await env.call('/asset/nobody/x.webm', { query: { token: env.token } })).status, 404, '不存在的包 404')

  const sel = await env.call('/pack', { method: 'POST', json: { name: 'fish' } })
  assert.equal(sel.json.ok, true)
  const cfg2 = await env.call('/config')
  assert.equal(cfg2.json.pack.name, 'fish', '切换生效')
  assert.deepEqual(cfg2.json.pack.animations.idle, ['fish-idle'])
  assert.equal((await env.call('/pack', { method: 'POST', json: { name: 'ghost' } })).status, 404, '切到不存在的包 404')
})

test('P1：没放任何素材时 /config 的 pack 为 null（客户端回静态形象，不报错）', async () => {
  const env = startModule()
  const cfg = await env.call('/config')
  assert.equal(cfg.json.pack, null)
})

test('人物大小：/config 与 /status 都带 scale；坏值回落 1，越界钳到 0.5~2', async () => {
  // 正常值透传（/config 给客户端整窗缩放，/status 给面板显示滑条）
  const env = startModule({ settings: { petScale: 1.5 } })
  assert.equal((await env.call('/config')).json.scale, 1.5, '/config 下发 scale 给客户端')
  assert.equal((await env.call('/status')).json.scale, 1.5, '/status 带给面板')
  assert.equal(env.exports.status().scale, 1.5, '模块对外 status()（面板走这条）也带 scale')
  // 越界钳制 + 坏值回落 1（原始大小，别把桌宠缩没）
  assert.equal((await startModule({ settings: { petScale: 9 } }).call('/config')).json.scale, 2, '超过 2 钳到 2')
  assert.equal((await startModule({ settings: { petScale: 0.1 } }).call('/config')).json.scale, 0.5, '低于 0.5 钳到 0.5')
  assert.equal((await startModule({ settings: { petScale: 'abc' } }).call('/config')).json.scale, 1, '坏值回落 1')
  assert.equal((await startModule({}).call('/config')).json.scale, 1, '没配 = 默认 1')
})

test('松手落地开关：/config 与 /status 都带 releaseLand；缺省当开（保持原物理行为）', async () => {
  // 默认开：客户端松手后照旧按甩出速度抛出去落地
  const env = startModule({})
  assert.equal((await env.call('/config')).json.releaseLand, true, '没配 = 默认开')
  assert.equal((await env.call('/status')).json.releaseLand, true, '/status 带给面板')
  assert.equal(env.exports.status().releaseLand, true, '模块对外 status()（面板走这条）也带 releaseLand')
  // 显式关：下发 false，客户端松手就停在原地（不抛也不落）；坏值一律当开（别让配置坏了把抛掷弄丢）
  assert.equal((await startModule({ settings: { petReleaseLand: false } }).call('/config')).json.releaseLand, false, '关掉后 /config 下发 false')
  assert.equal((await startModule({ settings: { petReleaseLand: 'abc' } }).call('/config')).json.releaseLand, true, '坏值回落开')
})

// ---------- 默认素材包自动下载（「大肥鱼」素材不进插件 git，装完从素材仓库自动落位） ----------

test('素材包自动下载：缺包 + 配了地址 + fetchZip 注入 → 落位 packs/default-animation/；archive zip 的单层顶层目录 + 素材文件夹自动剥', async () => {
  // 模拟素材仓库的真实结构：archive zip 自带 <仓库名>-<分支>/ 顶层目录，素材再放一层 pet-pack/ 文件夹
  const fakeZip = tinyZip([
    ['dsh-aurabot-qq-mods-main/', Buffer.alloc(0)],
    ['dsh-aurabot-qq-mods-main/README.md', Buffer.from('# 素材仓库')],
    ['dsh-aurabot-qq-mods-main/pet-pack/', Buffer.alloc(0)],
    ['dsh-aurabot-qq-mods-main/pet-pack/default-config.json', Buffer.from(JSON.stringify({ pools: { idle: ['anim-001'] } }))],
    ['dsh-aurabot-qq-mods-main/pet-pack/default-manifest.json', Buffer.from('{}')],
    ['dsh-aurabot-qq-mods-main/pet-pack/default-animation/anim-001.webm', WEBM],
    ['dsh-aurabot-qq-mods-main/pet-pack/default-animation/anim-002.webm', WEBM],
  ])
  let requestedUrl = ''
  const env = startModule({
    settings: { petPackUrl: 'https://gitee.com/x/dsh-aurabot-qq-mods/archive/refs/heads/main.zip' },
    hooks: {
      fetchZip: async (url) => {
        requestedUrl = url
        return { ok: true, arrayBuffer: async () => fakeZip.buffer.slice(fakeZip.byteOffset, fakeZip.byteOffset + fakeZip.byteLength) }
      },
    },
  })
  const r = await env.call('/packs/fetch-default', { method: 'POST', json: {} })
  assert.equal(r.status, 200, `应下载成功：${r.json && r.json.message}`)
  assert.equal(r.json.ok, true)
  assert.match(requestedUrl, /dsh-aurabot-qq-mods/, '用的就是面板配置的素材包地址')
  assert.equal(r.json.count, 2, '落位 2 个动画')
  const dd = process.env.AURABOT_DATA_DIR
  assert.ok(existsSync(join(dd, 'modules-data', 'pet', 'packs', 'default-config.json')), 'config 一并落位')
  assert.ok(existsSync(join(dd, 'modules-data', 'pet', 'packs', 'default-animation', 'anim-001.webm')))
  assert.ok(!existsSync(env.api.dataDir('packs-download.zip')), '临时 zip 用完清理')
  assert.ok(!existsSync(env.api.dataDir('packs-staging')), '暂存目录用完清理')
  const packs = await env.call('/packs')
  const def = packs.json.packs.find((p) => p.name === 'default')
  assert.ok(def, '/packs 能扫到 default 包')
  assert.equal(def.anims.length, 2, '扫描看到落位的动画')
})

test('素材包：素材文件夹名字随意（大肥鱼/ 这种中文名也认）——只认「哪一层里有 default-animation/」', async () => {
  const fakeZip = tinyZip([
    ['dsh-aurabot-qq-mods-main/', Buffer.alloc(0)],
    ['dsh-aurabot-qq-mods-main/大肥鱼/', Buffer.alloc(0)],
    ['dsh-aurabot-qq-mods-main/大肥鱼/default-config.json', Buffer.from('{}')],
    ['dsh-aurabot-qq-mods-main/大肥鱼/default-animation/anim-001.webm', WEBM],
  ])
  const env = startModule({
    settings: { petPackUrl: 'https://example.com/mods.zip' },
    hooks: { fetchZip: async () => ({ ok: true, arrayBuffer: async () => fakeZip.buffer.slice(fakeZip.byteOffset, fakeZip.byteOffset + fakeZip.byteLength) }) },
  })
  const r = await env.call('/packs/fetch-default', { method: 'POST', json: {} })
  assert.equal(r.json.ok, true, `任意文件夹名也要能落位：${r.json.message}`)
  assert.equal(r.json.count, 1)
  assert.ok(existsSync(join(process.env.AURABOT_DATA_DIR, 'modules-data', 'pet', 'packs', 'default-animation', 'anim-001.webm')))
})

test('素材包：没配下载地址 → 明确报错不炸；包已就位 → 非 force 直接跳过（every 兜底轮询不重复下载）', async () => {
  const env = startModule() // fake settings 没有 petPackUrl = 没配地址
  const r = await env.call('/packs/fetch-default', { method: 'POST', json: {} })
  assert.equal(r.status, 502)
  assert.equal(r.json.ok, false)
  assert.match(r.json.message, /下载地址/, '提示去面板配置地址，而不是抛错')

  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'anim-001.webm': WEBM }, { pools: {} })
  const skip = await env.exports.ensureDefaultPack(false)
  assert.equal(skip.ok, true)
  assert.equal(skip.skipped, true, '包已就位时非 force 调用跳过')
  assert.ok(!existsSync(env.api.dataDir('packs-staging')), '不留下暂存目录')
})

test('素材包：status().packInfo 给面板用（地址 / 是否就位 / 动画数 / 包列表）', async () => {
  const env = startModule({ settings: { petPackUrl: 'https://example.com/pet-pack.zip' } })
  const empty = env.exports.status().packInfo
  assert.equal(empty.url, 'https://example.com/pet-pack.zip')
  assert.equal(empty.hasDefault, false)
  assert.equal(empty.defaultAnims, 0)
  assert.deepEqual(empty.packs, [])
  assert.equal(empty.downloading, false)

  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'anim-001.webm': WEBM, 'anim-002.webm': WEBM }, { pools: {} })
  const filled = env.exports.status().packInfo
  assert.equal(filled.hasDefault, true, '包就位后 hasDefault=true（面板显示「已就位」）')
  assert.equal(filled.defaultAnims, 2)
  assert.deepEqual(filled.packs, ['default'])
})

test('素材包：下载炸了（HTTP 404）→ ok:false 带原因，packs/ 不被污染', async () => {
  const env = startModule({
    settings: { petPackUrl: 'https://example.com/bad.zip' },
    hooks: { fetchZip: async () => ({ ok: false, status: 404 }) },
  })
  const r = await env.call('/packs/fetch-default', { method: 'POST', json: {} })
  assert.equal(r.status, 502)
  assert.equal(r.json.ok, false)
  assert.match(r.json.message, /素材包下载失败/)
  assert.match(r.json.message, /404/)
  assert.ok(!existsSync(join(process.env.AURABOT_DATA_DIR, 'modules-data', 'pet', 'packs', 'default-animation', 'anim-001.webm')), '失败不落位')
})

// ---------- 客户端安装（面板 download） ----------

test('download()：把 pet-client 模板生成到数据目录 app/（含 physics.js / preload.js）', async () => {
  const env = startModule()
  const r = await env.exports.download()
  assert.equal(r.ok, true)
  for (const f of ['main.js', 'preload.js', 'index.html', 'physics.js', 'packmeta.js', 'behavior.js', 'README.md']) {
    assert.ok(existsSync(join(r.dir, f)), `${f} 已生成`)
  }
  const host = JSON.parse(readFileSync(join(dirname(r.dir), 'host.json'), 'utf8'))
  assert.ok(host.token, 'app 目录上一级的 host.json 已就绪（客户端起来即可发现插件）')
})

test('/client/install：返回的 files 清单包含 behavior.js（行为层文件必须随客户端生成，否则整体降级）', async () => {
  const env = startModule()
  const r = await env.call('/client/install', { method: 'POST', json: {} })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.ok(Array.isArray(r.json.files) && r.json.files.includes('behavior.js'), `files 含 behavior.js：${JSON.stringify(r.json.files)}`)
  assert.ok(existsSync(join(r.json.dir, 'behavior.js')), 'behavior.js 已生成到数据目录 app/')
})

// ---------- 客户端生成物对账（治「旧壳」：app/ 缺 behavior.js 时行为层静默失效） ----------

test('clientStatus：没生成过 → installed=false、healthy=false', async () => {
  const env = startModule()
  const st = env.exports.clientStatus()
  assert.equal(st.installed, false)
  assert.equal(st.healthy, false)
  assert.match(st.message, /还没生成/)
})

test('clientStatus：生成后 healthy，且 app/ 里留下签名凭据', async () => {
  const env = startModule()
  await env.call('/client/install', { method: 'POST', json: {} })
  const st = env.exports.clientStatus()
  assert.equal(st.installed, true)
  assert.equal(st.healthy, true, st.message)
  assert.ok(st.sig && st.sig === st.generatedSig, `模板签名应与生成凭据一致：${st.sig} / ${st.generatedSig}`)
  assert.ok(existsSync(join(env.api.dataDir('app'), 'client-stamp.json')), '生成时写了 client-stamp.json')
})

test('clientStatus：缺 behavior.js（典型旧壳）→ missing 点名、healthy=false', async () => {
  const env = startModule()
  await env.call('/client/install', { method: 'POST', json: {} })
  unlinkSync(join(env.api.dataDir('app'), 'behavior.js'))
  const st = env.exports.clientStatus()
  assert.equal(st.healthy, false)
  assert.deepEqual(st.missing, ['behavior.js'])
  assert.match(st.message, /behavior\.js/)
})

test('clientStatus：模板比生成物新（签名不一致）→ outdated、healthy=false', async () => {
  const env = startModule()
  await env.call('/client/install', { method: 'POST', json: {} })
  writeFileSync(join(env.api.dataDir('app'), 'client-stamp.json'), JSON.stringify({ sig: 'oldoldold123', at: 1 }))
  const st = env.exports.clientStatus()
  assert.equal(st.outdated, true)
  assert.equal(st.healthy, false)
  assert.match(st.message, /更新|重新生成/)
})

test('clientStatus：手改 app/main.js → changed 点名，但不谎报「跑不起来」', async () => {
  const env = startModule()
  await env.call('/client/install', { method: 'POST', json: {} })
  const p = join(env.api.dataDir('app'), 'main.js')
  writeFileSync(p, readFileSync(p, 'utf8') + '\n// 手改一行\n')
  const st = env.exports.clientStatus()
  assert.deepEqual(st.changed, ['main.js'])
  assert.equal(st.healthy, true) // 内容不同 ≠ 缺文件：只是提醒「重新生成会覆盖」
})

test('/status：带 client 对账字段（面板「桌宠」卡据此提示）', async () => {
  const env = startModule()
  await env.call('/client/install', { method: 'POST', json: {} })
  const r = await env.call('/status')
  assert.equal(r.json.client.installed, true)
  assert.equal(r.json.client.healthy, true)
})

// ---------- Electron 三键（面板「安装 Electron / 启动桌宠 / 停止桌宠」） ----------

const ELECTRON_REL = process.platform === 'win32' ? join('dist', 'electron.exe')
  : process.platform === 'darwin' ? join('dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  : join('dist', 'electron')
// 官方 zip 里 payload 相对**压缩包根**的位置（没有 dist/ 前缀；macOS 是 Electron.app 目录）
const ZIP_EXE_REL = process.platform === 'win32' ? 'electron.exe'
  : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
  : 'electron'

/** 假 spawn：记录调用、按脚本制造 exe / 返回退出码，绝不打真网络、不真启动。 */
function fakeSpawn({ exit = 0, makeExe } = {}) {
  const calls = []
  const spawn = (cmd, args, opts = {}) => {
    const call = { cmd, args, opts, env: opts.env || {} }
    calls.push(call)
    if (makeExe) makeExe()
    return {
      pid: 42424,
      stdout: { on() {} }, stderr: { on() {} },
      on(event, fn) { if (event === 'close') setTimeout(() => fn(exit), 5) },
      kill() {}, unref() {},
    }
  }
  return { spawn, calls }
}

/**
 * 给 Electron 安装的 fetchZip 注入套上「SHASUMS256.txt 分发」：
 * 旧测试只认 zip 请求；现在 electronInstallZip 会先拉 SHASUMS256.txt（官方→镜像）。
 * 这个包装按 URL 分发：SHASUMS 请求返回「用真实 zip 内容算出的 sha256 清单」
 * （所以 sha256 校验天然通过），zip 请求原样走旧注入。
 */
function withElectronSums(fetchZip) {
  const plat = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
  const zipName = `electron-v45.1.0-${plat}-${process.arch}.zip`
  return async (url) => {
    if (!/SHASUMS256/.test(String(url))) return fetchZip(url)
    // 先向旧注入要 zip 内容来算 hash（zip 与清单在测试里同源，天然匹配）
    const res = await fetchZip(url)
    const buf = Buffer.from(await res.arrayBuffer())
    const sha = createHash('sha256').update(buf).digest('hex')
    const text = `${sha}  ${zipName}\n`
    const out = Buffer.from(text, 'utf8')
    return { ok: true, arrayBuffer: async () => out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) }
  }
}

test('Electron 安装：走 node + npm-cli.js（不经 shell）、注入 ELECTRON_MIRROR 镜像；已装则跳过', async () => {
  const env = startModule()
  const appDir = env.api.dataDir('app')
  const exe = join(appDir, 'node_modules', 'electron', ELECTRON_REL)
  await env.exports.download() // 先有 app/main.js

  // 假 npm-cli：不依赖真机 npm 安装位置（钩子可覆盖 npmCli 路径）
  const fakeCli = join(process.env.AURABOT_DATA_DIR, 'npm-cli.js')
  writeFileSync(fakeCli, '// fake npm-cli')
  const { spawn, calls } = fakeSpawn({ exit: 0, makeExe: () => { mkdirSync(dirname(exe), { recursive: true }); writeFileSync(exe, 'fake electron') } })
  // 换一个带 hooks 的实例（hooks 在 setup 时读）：重新起一个同数据目录的模块实例
  const env2 = startModule({ hooks: { spawn, npmCli: fakeCli } })
  const r = await env2.exports.electronInstall()
  assert.equal(r.ok, true, `安装成功：${r.message}`)
  assert.equal(calls.length, 1, '只 spawn 了一次 npm')
  const c = calls[0]
  assert.equal(c.cmd, process.execPath, '直接用当前 node 跑 npm-cli.js（Windows 上 spawn npm.cmd 无 shell 会被拒）')
  assert.ok(c.args[0].endsWith('npm-cli.js'), `第一个参数是 npm-cli.js：${c.args[0]}`)
  assert.deepEqual(c.args.slice(1), ['install', '-D', 'electron'])
  assert.equal(c.opts.cwd, appDir, '在 app 目录里装')
  assert.equal(c.env.ELECTRON_MIRROR, 'https://npmmirror.com/mirrors/electron/', '必须注入 npmmirror 镜像（直连 github release 会 fetch failed）')
  assert.ok(!('shell' in c.opts) || !c.opts.shell, '不经 shell 拼接')
  assert.ok(existsSync(exe))

  const again = await env2.exports.electronInstall()
  assert.equal(again.alreadyInstalled, true, '已装（electron.exe 在）则跳过')
  assert.equal(calls.length, 1, '跳过时不再 spawn')
})

test('Electron 安装失败路径：npm 非零退出 → 自动回退 zip 直装；两条都挂才 ok:false；没生成客户端先拦', async () => {
  const fakeCli = join(process.env.AURABOT_DATA_DIR, 'npm-cli.js')
  writeFileSync(fakeCli, '// fake npm-cli')
  const env = startModule({
    hooks: {
      spawn: fakeSpawn({ exit: 1 }).spawn,
      npmCli: fakeCli,
      fetchZip: async () => { throw new Error('ECONNREFUSED 模拟断网') }, // 回退也失败，别打真网络
    },
  })
  const r0 = await env.exports.electronInstall()
  assert.equal(r0.ok, false, '还没生成客户端：先拦下，不 spawn')
  await env.exports.download()
  const r = await env.exports.electronInstall()
  assert.equal(r.ok, false)
  assert.equal(r.exitCode, 1)
  assert.match(r.message, /npm 安装失败/)
  assert.match(r.message, /zip 直装也没成/, 'npm 失败会先自动回退 zip 直装，两条都挂才报错')
})

test('Electron 安装：npm 失败但 zip 直装成功 → 整体 ok:true，并在消息里说明已回退', async () => {
  const fakeCli = join(process.env.AURABOT_DATA_DIR, 'npm-cli.js')
  writeFileSync(fakeCli, '// fake npm-cli')
  const env0 = startModule()
  const appDir = env0.api.dataDir('app')
  await env0.exports.download() // 先生成客户端（app/main.js + package.json）
  const exe = join(appDir, 'node_modules', 'electron', ELECTRON_REL)
  const fakeZip = tinyZip([
    ['dist/', Buffer.alloc(0)],
    [ELECTRON_REL.split('\\').join('/'), Buffer.from('fake electron')],
  ])
  const env = startModule({
    hooks: {
      spawn: fakeSpawn({ exit: 1 }).spawn, // npm 必失败
      npmCli: fakeCli,
      fetchZip: withElectronSums(async () => ({ ok: true, arrayBuffer: async () => fakeZip.buffer.slice(fakeZip.byteOffset, fakeZip.byteOffset + fakeZip.byteLength) })),
    },
  })
  const r = await env.exports.electronInstall()
  assert.equal(r.ok, true, `回退成功应算装好了：${r.message}`)
  assert.match(r.message, /已自动改用 zip 直装/, '告诉用户为什么换了条路')
  assert.match(r.message, /npm 安装失败/, '保留 npm 的失败原因')
  assert.ok(existsSync(exe), 'zip 解压出来的 electron.exe 在位')
})

test('Electron 镜像可配：electronMirror 同时作用于 zip 直装 URL 与 npm 的 ELECTRON_MIRROR（末尾自动补 /）', async () => {
  // ① zip 直装：没有 npm-cli 时用配置的镜像拼版本路径。
  //    现在安装前还会拉 SHASUMS256.txt（官方 → 镜像）：官方注入 502、镜像注入成功（返回合法清单），
  //    这样校验能过、zip 也会继续请求——两个 URL 都能断言落在配置的镜像上。
  const requestedUrls = []
  const FAKE_SHA = 'f'.repeat(64)
  const zipped = startModule({
    settings: { electronMirror: 'https://example.com/em' }, // 故意不写结尾斜杠
    hooks: {
      npmCli: '',
      fetchZip: async (url) => {
        requestedUrls.push(url)
        if (/SHASUMS256/.test(url)) {
          if (/github\.com/.test(url)) return { ok: false, status: 502 } // 官方挂 → 降级镜像清单
          const plat = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
          const text = `${FAKE_SHA}  electron-v45.1.0-${plat}-${process.arch}.zip\n`
          return { ok: true, arrayBuffer: async () => Buffer.from(text, 'utf8') }
        }
        return { ok: false, status: 502 } // zip 本身还是给失败，这个测试只看 URL
      },
    },
  })
  await zipped.exports.download()
  const zr = await zipped.exports.electronInstall()
  assert.equal(zr.ok, false, '下载失败（注入的 502）')
  assert.ok(requestedUrls.some((u) => /^https:\/\/example\.com\/em\/\d+\.\d+\.\d+\/electron-v/.test(u)), '用面板配的镜像拼 zip URL，且自动补了斜杠')
  assert.ok(requestedUrls.some((u) => /^https:\/\/example\.com\/em\/\d+\.\d+\.\d+\/SHASUMS256\.txt$/.test(u)), '镜像 SHASUMS256.txt 也走同一镜像')
  assert.ok(requestedUrls.some((u) => /github\.com\/electron\/electron\/releases/.test(u)), '官方 SHASUMS 优先尝试（镜像整体被篡改时兜得住）')

  // ② npm 路径：ELECTRON_MIRROR 环境变量同源
  const fakeCli = join(process.env.AURABOT_DATA_DIR, 'npm-cli.js')
  writeFileSync(fakeCli, '// fake npm-cli')
  const { spawn, calls } = fakeSpawn({ exit: 1 })
  const env = startModule({ settings: { electronMirror: 'https://example.com/em/' }, hooks: { spawn, npmCli: fakeCli, fetchZip: async () => ({ ok: false, status: 502 }) } })
  await env.exports.electronInstall()
  assert.equal(calls[0].env.ELECTRON_MIRROR, 'https://example.com/em/', 'npm 安装也走同一个镜像')
})

test('安全：明文 http 的下载地址一律拒绝（只放行本机回环），防止中间人换包', async () => {
  // 配一个明文镜像 → 连 fetchZip 都不该被调用就直接失败。
  // 走 ensureDefaultPack（素材包下载入口）而不是 electronInstall：后者会先检查客户端是否已生成，
  // 那道前置检查会先返回，测不到下载闸。
  let fetched = ''
  const env = startModule({
    settings: { petPackUrl: 'http://evil.example.com/pet.zip' },
    hooks: {
      fetchZip: async (url) => { fetched = url; return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } },
    },
  })
  const r = await env.exports.ensureDefaultPack(true)
  assert.equal(r.ok, false, '明文素材包地址必须拒绝')
  assert.equal(fetched, '', '明文地址根本不该发起请求（先拦后下）')
  assert.match(String(r.message || ''), /明文|https/i, '错误信息说明要 https')
})

test('安全：下载内容超过大小上限直接拒绝，不落盘不执行', async () => {
  const env = startModule({
    settings: { petPackUrl: 'https://example.com/pet.zip' },
    hooks: {
      // 声称长度超过上限（模拟被塞了超大响应）
      fetchZip: async () => ({
        ok: true,
        headers: { get: () => String(600 * 1024 * 1024) }, // 600MB > 512MB 上限
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    },
  })
  const r = await env.exports.ensureDefaultPack(true)
  assert.equal(r.ok, false, '超大响应必须失败')
  assert.match(String(r.message || ''), /过大|上限/i, '错误信息说明是大小问题')
})

/**
 * 手工拼一个最小合法 zip：顺带走真解压器，不引第三方依赖。
 * entries: `[name, data]` 或 `[name, data, { method, mode }]`
 *   · method：0=存储（默认）/ 8=deflate（官方 electron zip 用的就是 deflate）
 *   · mode：Unix st_mode，写进 externalAttr 高 16 位（0o100644 普通文件、0o120777 符号链接）。
 *     **不传就是 0**——那是 DOS 属性，不是真实 zip 的长相；关键用例要显式给 mode，
 *     否则「把普通文件误判成符号链接」这类 bug 测不出来（历史上就漏过一次）。
 */
function tinyZip(entries) {
  const chunks = []
  const central = []
  let off = 0
  for (const [name, raw, opts = {}] of entries) {
    const nameBuf = Buffer.from(name)
    const method = opts.method || 0
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    const body = method === 8 ? deflateRawSync(data) : data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18) // csize（压缩后）
    local.writeUInt32LE(data.length, 22) // usize（原始）
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, body)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(body.length, 20) // csize
    cd.writeUInt32LE(data.length, 24) // usize
    cd.writeUInt16LE(nameBuf.length, 28)
    if (opts.mode) cd.writeUInt32LE((opts.mode << 16) >>> 0, 38) // externalAttr 高 16 位 = Unix st_mode
    cd.writeUInt32LE(off, 42) // 局部头偏移
    central.push(cd, nameBuf)
    off += 30 + nameBuf.length + body.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(off, 16)
  return Buffer.concat([...chunks, cdBuf, eocd])
}

/** 官方 electron zip 的样子：payload 直接在压缩包根（没有 dist/ 前缀），deflate 压缩，带 Unix 权限位。 */
function officialZipEntries(exeRelNoDist = ZIP_EXE_REL, prefix = '') {
  return [
    [prefix + exeRelNoDist, Buffer.from('fake electron'), { method: 8, mode: 0o100755 }],
    [prefix + 'resources/default_app.asar', Buffer.from('asar'), { method: 8, mode: 0o100644 }],
    [prefix + 'locales/zh-CN.pak', Buffer.from('pak'), { method: 8, mode: 0o100644 }],
    [prefix + 'vk_swiftshader.dll', Buffer.from('dll'), { method: 8, mode: 0o100644 }],
  ]
}

test('Electron 兜底直装：没有 npm-cli（DSH 运行时/裸机）→ 镜像直下官方 zip + 纯 JS 解压，落到 electron/dist/', async () => {
  const env = startModule()
  const appDir = env.api.dataDir('app')
  await env.exports.download() // 先有 app/main.js
  const pkgRoot = join(appDir, 'node_modules', 'electron')
  const exe = join(appDir, 'node_modules', 'electron', ELECTRON_REL)

  let requestedUrl = ''
  const fakeZip = tinyZip(officialZipEntries())
  // 换一个带 hooks 的实例（hooks 在 setup 时读）；npmCli: '' = 强制没有 npm（逼出 zip 直装路径），
  // fetchZip 钩子替代真下载，不打真网络。SHASUMS 分发由 withElectronSums 包一层。
  const env2 = startModule({
    hooks: {
      npmCli: '',
      fetchZip: withElectronSums(async (url) => {
        requestedUrl = url
        return { ok: true, arrayBuffer: async () => fakeZip.buffer.slice(fakeZip.byteOffset, fakeZip.byteOffset + fakeZip.byteLength) }
      }),
    },
  })
  const r = await env2.exports.electronInstall()
  assert.equal(r.ok, true, `zip 直装应成功：${r.message}`)
  assert.match(requestedUrl, /^https:\/\/npmmirror\.com\/mirrors\/electron\//, '下载必须走 npmmirror 镜像')
  assert.match(requestedUrl, /electron-v\d+\.\d+\.\d+-/, 'URL 带具体版本号（来自 app/package.json）')
  // 官方 zip 的 payload 在压缩包根，必须落到 node_modules/electron/dist/（electronExe() 只认这个布局）
  assert.ok(existsSync(exe), '解压后 electron.exe 在 node_modules/electron/dist/ 下')
  assert.equal(readFileSync(exe, 'utf8'), 'fake electron', 'deflate 条目解压内容正确')
  assert.ok(existsSync(join(pkgRoot, 'dist', 'resources', 'default_app.asar')), '整包一起进 dist/，不是只挑 exe')
  assert.ok(!existsSync(join(pkgRoot, 'resources')), '别再把扁平内容摊在 electron/ 根目录')
  assert.equal(readFileSync(join(pkgRoot, 'path.txt'), 'utf8').trim(), ZIP_EXE_REL, 'path.txt 与 npm 包约定一致')
  assert.ok(!existsSync(join(pkgRoot, '.unzip')), '临时解压目录清理干净')
  assert.ok(!existsSync(join(appDir, 'electron.zip')), '装完清理临时 zip')
  assert.match(r.message, /无需 npm/)

  const again = await env2.exports.electronInstall()
  assert.equal(again.alreadyInstalled, true, '已装则跳过')
})

test('Electron 兜底直装：镜像 zip 外面套了一层目录（electron-v45-win32-x64/…）也能认出 payload', async () => {
  const env = startModule()
  const appDir = env.api.dataDir('app')
  await env.exports.download()
  const exe = join(appDir, 'node_modules', 'electron', ELECTRON_REL)
  const fakeZip = tinyZip(officialZipEntries(ZIP_EXE_REL, `electron-v45.1.0-${process.platform}-${process.arch}/`))
  const env2 = startModule({
    hooks: {
      npmCli: '',
      fetchZip: withElectronSums(async () => ({ ok: true, arrayBuffer: async () => fakeZip.buffer.slice(fakeZip.byteOffset, fakeZip.byteOffset + fakeZip.byteLength) })),
    },
  })
  const r = await env2.exports.electronInstall()
  assert.equal(r.ok, true, `套了一层目录也要能装：${r.message}`)
  assert.ok(existsSync(exe), '依然落在 electron/dist/ 下')
})

test('zip 解压：Unix 普通文件不因权限位被误判成符号链接（0o100644 最高位也是 1）；真符号链接条目仍跳过', async () => {
  const env = startModule()
  const appDir = env.api.dataDir('app')
  await env.exports.download()
  const pkgRoot = join(appDir, 'node_modules', 'electron')
  const exe = join(appDir, 'node_modules', 'electron', ELECTRON_REL)
  const entries = officialZipEntries() // 普通文件带 0o100644/0o100755 权限位
  entries.push(['link-to-exe', Buffer.from(ZIP_EXE_REL), { method: 0, mode: 0o120777 }]) // S_IFLNK 符号链接
  const fakeZip = tinyZip(entries)
  const env2 = startModule({
    hooks: {
      npmCli: '',
      fetchZip: withElectronSums(async () => ({ ok: true, arrayBuffer: async () => fakeZip.buffer.slice(fakeZip.byteOffset, fakeZip.byteOffset + fakeZip.byteLength) })),
    },
  })
  const r = await env2.exports.electronInstall()
  assert.equal(r.ok, true, `应装成功：${r.message}`)
  assert.ok(existsSync(exe), 'electron.exe 解出来了')
  assert.ok(existsSync(join(pkgRoot, 'dist', 'resources', 'default_app.asar')), '普通文件（0o100644）必须照常解出来，不能被当符号链接跳过')
  assert.ok(existsSync(join(pkgRoot, 'dist', 'locales', 'zh-CN.pak')), '普通文件同样照常解出')
  assert.ok(!existsSync(join(pkgRoot, 'dist', 'link-to-exe')), '符号链接条目跳过（不落地成普通文件）')
})

test('Electron 宿主 asar 补丁：解压/清理必须走 original-fs，否则写 resources/default_app.asar 会被拦成 Invalid package', async () => {
  // 真机踩过的坑：DSH 跑在 Electron 里，主进程 node:fs 对任何 `.asar` 路径都先当「asar 包」打开，
  // 官方 electron zip 里的 resources/default_app.asar 一写就抛 `Invalid package <path>`（纯 Node 不复现）。
  // 这里注入「未打补丁」的假 fsRaw：只要 .asar 的写入/删除都经过它，就证明解压绕开了 asar 补丁。
  const env = startModule()
  const appDir = env.api.dataDir('app')
  await env.exports.download() // 先有 app/main.js
  const pkgRoot = join(appDir, 'node_modules', 'electron')
  const exe = join(appDir, 'node_modules', 'electron', ELECTRON_REL)
  const fakeZip = tinyZip(officialZipEntries())
  const rawWrites = []
  const rawRemoves = []
  const fsRaw = {
    writeFileSync: (p, data) => { rawWrites.push(String(p)); writeFileSync(p, data) },
    chmodSync: () => {},
    cpSync: (from, to, opts) => cpSync(from, to, opts),
    rmSync: (p, opts) => { rawRemoves.push(String(p)); rmSync(p, opts) },
  }
  const env2 = startModule({
    hooks: {
      npmCli: '',
      fsRaw,
      fetchZip: withElectronSums(async () => ({ ok: true, arrayBuffer: async () => fakeZip.buffer.slice(fakeZip.byteOffset, fakeZip.byteOffset + fakeZip.byteLength) })),
    },
  })
  const r = await env2.exports.electronInstall()
  assert.equal(r.ok, true, `走原始 fs 应能装成功：${r.message}`)
  assert.ok(existsSync(exe), '可执行文件落到 dist/')
  assert.ok(
    rawWrites.some((p) => p.endsWith('default_app.asar')),
    'resources/default_app.asar 必须用 original-fs 写（用 node:fs 在 Electron 宿主里会抛 Invalid package）',
  )
  // 可执行文件名平台相关（win electron.exe / linux electron / mac Electron.app/…），按实际 payload 相对路径断言
  assert.ok(rawWrites.some((p) => p.endsWith(ZIP_EXE_REL)), '可执行文件同样走原始 fs')
  assert.ok(rawRemoves.some((p) => p.endsWith('.unzip')), '暂存目录清理也走原始 fs（里面还有 .asar，node:fs 删不动）')
  assert.ok(!existsSync(join(pkgRoot, '.unzip')), '临时解压目录清理干净')
})

test('Electron 兜底直装失败：镜像给的不是 zip（HTML 错误页/断流）→ 报「不是有效的 zip」，不误报平台不匹配', async () => {
  const env = startModule()
  await env.exports.download()
  const html = Buffer.from('<html><body>502 Bad Gateway</body></html>')
  const env2 = startModule({
    hooks: {
      npmCli: '',
      // SHASUMS 由 withElectronSums 用同一份 HTML 的 hash 生成（模拟「镜像把 zip 和清单一起给」），
      // 于是 sha256 校验通过、在解压时暴露「根本不是 zip」
      fetchZip: withElectronSums(async () => ({ ok: true, arrayBuffer: async () => html.buffer.slice(html.byteOffset, html.byteOffset + html.byteLength) })),
    },
  })
  const r = await env2.exports.electronInstall()
  assert.equal(r.ok, false)
  assert.match(r.message, /不是有效的 zip/)
  assert.doesNotMatch(r.message, /平台/)
})

test('Electron 兜底直装失败：下载炸了 → ok:false 带原因（不再出现「找不到 npm-cli.js」死路提示）', async () => {
  const env = startModule({ hooks: { npmCli: '', fetchZip: async () => { throw new Error('ECONNREFUSED 模拟断网') } } })
  await env.exports.download()
  const r = await env.exports.electronInstall()
  assert.equal(r.ok, false)
  assert.match(r.message, /zip 直装失败/)
  assert.match(r.message, /ECONNREFUSED/)
  assert.doesNotMatch(r.message, /找不到 npm-cli\.js/, '报错不再是一条死路提示')
})

test('安全：SHASUMS256 官方与镜像都拿不到 → 中止安装，绝不装没验过签的运行时', async () => {
  // 下载注入：SHASUMS 请求一律 404（官方 + 镜像都拉不到清单），zip 请求不会被走到
  const zipRequested = []
  const env = startModule({
    hooks: {
      npmCli: '',
      fetchZip: async (url) => {
        if (/SHASUMS256/.test(String(url))) return { ok: false, status: 404 }
        zipRequested.push(url)
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }
      },
    },
  })
  await env.exports.download()
  const r = await env.exports.electronInstall()
  assert.equal(r.ok, false, '清单拿不到必须中止')
  assert.match(String(r.message || ''), /SHASUMS256|校验清单/, '错误信息说明是校验清单的问题')
  assert.equal(zipRequested.length, 0, '清单没拿到就绝不能开始下 zip')
})

test('安全：zip 与 SHASUMS256 校验不符 → 拒绝安装且不落盘（复审 2 补：sha 失配回归）', async () => {
  // 模拟「镜像上 zip 被换了包，但清单是真的」：清单返回官方真 hash，zip 给的是别的内容。
  // sha256 对不上必须在解压/落盘前被拦。
  const fakeZip = tinyZip(officialZipEntries())
  const REAL_SHA = createHash('sha256').update(fakeZip).digest('hex')
  const zipRequested = []
  const env = startModule({
    hooks: {
      npmCli: '',
      fetchZip: async (url) => {
        if (/SHASUMS256/.test(String(url))) {
          const plat = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
          const text = `${REAL_SHA}  electron-v45.1.0-${plat}-${process.arch}.zip\n`
          const out = Buffer.from(text, 'utf8')
          return { ok: true, arrayBuffer: async () => out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) }
        }
        zipRequested.push(url)
        // 「被换过的包」：内容与清单不符
        return { ok: true, arrayBuffer: async () => Buffer.from('TAMPERED PAYLOAD').buffer.slice(0, 17) }
      },
    },
  })
  await env.exports.download()
  const exe = join(env.api.dataDir('app'), 'node_modules', 'electron', ELECTRON_REL)
  const r = await env.exports.electronInstall()
  assert.equal(r.ok, false, 'sha 失配必须拒绝安装')
  assert.match(String(r.message || ''), /sha256|篡改/i, '错误信息说明是完整性校验失败')
  assert.ok(!existsSync(exe), '被换的包绝不落地成 electron 运行时')
})

test('启动桌宠：分离进程 + 清 ELECTRON_RUN_AS_NODE；心跳活着提示已在跑；stop 杀记录的 pid', async () => {
  const killed = []
  const { spawn, calls } = fakeSpawn()
  const env = startModule({ hooks: { spawn, kill: (pid) => { killed.push(pid); return true } } })
  const appDir = env.api.dataDir('app')
  const exe = join(appDir, 'node_modules', 'electron', ELECTRON_REL)
  await env.exports.download()
  mkdirSync(dirname(exe), { recursive: true })
  writeFileSync(exe, 'fake electron')

  const prevRunAsNode = process.env.ELECTRON_RUN_AS_NODE
  process.env.ELECTRON_RUN_AS_NODE = '1' // 真机 DSH 环境必带；不清掉 Electron 会以纯 Node 模式启动即崩
  try {
    const r = await env.exports.launch()
    assert.equal(r.ok, true, `启动成功：${r.message}`)
    assert.equal(r.pid, 42424)
    assert.equal(calls.length, 1)
    const c = calls[0]
    assert.equal(c.cmd, exe, '启动的是 app/node_modules/electron 里的 electron.exe')
    assert.deepEqual(c.args, ['main.js'])
    assert.equal(c.opts.cwd, appDir)
    assert.equal(c.opts.detached, true, '分离进程（插件重启不带走桌宠）')
    assert.equal(c.opts.env.ELECTRON_RUN_AS_NODE, undefined, '子进程环境必须清掉 ELECTRON_RUN_AS_NODE')
    const proc = JSON.parse(readFileSync(env.api.dataDir('process.json'), 'utf8'))
    assert.equal(proc.pid, 42424, 'pid 记进 process.json（stop 用）')

    // 心跳活着 → 提示已在跑，不重复启动
    await env.connect()
    const again = await env.exports.launch()
    assert.equal(again.alreadyRunning, true, '心跳活着提示已在跑')
    assert.equal(calls.length, 1)

    // 停止：杀记录的 pid、清 process.json
    const s = await env.exports.stop()
    assert.equal(s.ok, true)
    assert.deepEqual(killed, [42424])
    assert.equal(existsSync(env.api.dataDir('process.json')), false, '记录已清理')

    // 进程本来就不在（ESRCH）：按已停止处理并清记录，不让面板卡「停不掉」
    mkdirSync(dirname(exe), { recursive: true })
    const env2 = startModule({ hooks: { spawn, kill: () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e } } })
    await env2.exports.download()
    writeFileSync(exe, 'fake electron')
    await env2.exports.launch()
    const s2 = await env2.exports.stop()
    assert.equal(s2.ok, true, 'ESRCH = 本来就不在，算停止成功')
    assert.match(s2.message, /已经不在/)
  } finally {
    if (prevRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = prevRunAsNode
  }
})

test('启动失败路径：Electron 没装 / main.js 不见 → 明确报错不 spawn', async () => {
  const { spawn, calls } = fakeSpawn()
  const env = startModule({ hooks: { spawn } })
  const r1 = await env.exports.launch()
  assert.equal(r1.ok, false, 'Electron 没装')
  assert.match(r1.message, /安装/)
  await env.exports.download()
  const appDir = env.api.dataDir('app')
  const exe = join(appDir, 'node_modules', 'electron', ELECTRON_REL)
  mkdirSync(dirname(exe), { recursive: true })
  writeFileSync(exe, 'fake electron')
  unlinkSync(join(appDir, 'main.js'))
  const r2 = await env.exports.launch()
  assert.equal(r2.ok, false, 'main.js 不见了')
  assert.match(r2.message, /main\.js/)
  assert.equal(calls.length, 0, '两条失败路径都没 spawn')
})

// ---------- P3：拖拽物理移植（dsh-pet MIT 物理模块的去 TS 单文件版） ----------

function loadPhysics() {
  const code = readFileSync(join(MODULE_DIR, 'pet-client', 'physics.js'), 'utf8')
  const m = { exports: {} }
  new Function('module', 'exports', code)(m, m.exports) // UMD：以 CommonJS 形态求值
  return m.exports
}

test('P3 物理：软钳速单调渐近；弹簧收敛；挤压曲线端点正确', () => {
  const P = loadPhysics()
  // softClampSpeed：单调、渐近不超过 MAX 上限
  let prev = 0
  for (const s of [200, 800, 2000, 6000, 60000]) {
    const c = P.softClampSpeed(s)
    assert.ok(c > prev, `单调：${s} → ${c}`)
    assert.ok(c < 3600 + 1e-6)
    prev = c
  }
  assert.ok(Math.abs(P.softClampSpeed(1e9) - 3600) < 1e-6, '渐近 = 软上限')
  // springStep：朝 target 收敛（过阻尼不越过）
  let v = 0, x = 0
  for (let i = 0; i < 600; i++) { v = P.springStep(v, x, 100, 1 / 120); x += v * (1 / 120) }
  assert.ok(Math.abs(x - 100) < 1, `弹簧收敛到目标（x=${x.toFixed(2)}）`)
  // squash：轻落 ≤0.8、重砸吃满下压、曲线两端
  assert.equal(P.landingSquash(0), 0.8)
  assert.equal(P.landingSquash(5000), 0.55)
  assert.equal(P.squashScale(0, 0.55), 1)
  assert.equal(P.squashScale(1, 0.55), 1)
  assert.ok(P.squashScale(0.2, 0.55) < 1, '下压段压缩')
  assert.ok(P.squashScale(0.8, 0.55) > 1, '回弹段过冲')
})

test('P3 物理：抛体落地反弹、atRest 判定、松手初速方向与温柔放下', () => {
  const P = loadPhysics()
  const b = P.throwBounds({ W: 1920, H: 1080, size: 280, sideAllow: 30 })
  // 自由落体到地面：vy 变号（restitution 反弹），最终 atRest
  let st = { x: 500, y: 0, vx: 0, vy: 0 }
  let bounced = false
  for (let i = 0; i < 2000 && !st.atRest; i++) {
    st = P.throwStep(st, 1 / 60, b, P.DEFAULT_PHYSICS)
    if (st.bounced) bounced = true
  }
  assert.ok(bounced, '落地反弹过')
  assert.ok(st.atRest, '最终静止')
  assert.equal(st.y, b.maxY)
  assert.equal(st.vy, 0)
  // 侧壁反弹：vx 反向且按恢复系数缩水
  const hit = P.throwStep({ x: b.maxX - 1, y: b.maxY, vx: 1000, vy: 0 }, 1 / 60, b, P.DEFAULT_PHYSICS)
  assert.ok(hit.vx < 0, '右壁反弹 vx 翻负')
  assert.ok(Math.abs(hit.vx) <= 1000 * P.DEFAULT_PHYSICS.restitution + 1e-6)
  // 松手初速：快速向右甩 → vx>0、软钳上限内；停顿后松手 → null（温柔放下）
  const now = Date.now()
  const trail = []
  for (let i = 0; i < 8; i++) trail.push({ t: now - 100 + i * 10, x: i * 40, y: i * 5 })
  const v = P.estimateReleaseVelocity(trail, now, P.DEFAULT_PHYSICS)
  assert.ok(v && v.vx > 0, `向右甩出正 vx（vx=${v && v.vx.toFixed(0)}）`)
  assert.ok(Math.hypot(v.vx, v.vy) <= 3600)
  assert.equal(P.estimateReleaseVelocity([{ t: now - 500, x: 0, y: 0 }, { t: now - 490, x: 300, y: 0 }], now, P.DEFAULT_PHYSICS), null, '停顿超过 150ms：温柔放下')
  // 参数可被 pack 配置覆盖：重力减半 → 同 dt 下落得更慢
  const half = { ...P.DEFAULT_PHYSICS, gravity: 700 }
  const a = P.throwStep({ x: 0, y: 0, vx: 0, vy: 0 }, 0.1, b, half)
  const c = P.throwStep({ x: 0, y: 0, vx: 0, vy: 0 }, 0.1, b, P.DEFAULT_PHYSICS)
  assert.ok(a.y < c.y, 'pack physics.gravity 生效')
})

test('P3 物理：抛掷边界按可见身体盒算（不再落出屏幕）+ 任意甩法 60fps 必在有限帧内静止', () => {
  const P = loadPhysics()
  const W = 1920
  const H = 1040
  // 与 index.html 的 #stage 一致：窗口 280×430，1:1 素材身体 240×240，距窗口底 16px
  const body = { width: 240, height: 240, offsetX: 20, offsetY: 430 - 16 - 240 }
  const b = P.throwBounds({ W, H, bodyW: body.width, bodyH: body.height, offsetX: body.offsetX, offsetY: body.offsetY, sideAllow: 19 })
  // 历史 bug：用 宽×9/16 当身体高 → 静止点在屏幕外 183px，桌宠一扔就"消失"
  assert.equal(b.maxY + body.offsetY + body.height, H, '静止时可见身体底边正好贴屏幕底')
  assert.ok(b.minY + body.offsetY <= 1, '允许身体顶到屏幕顶')
  for (const [vx, vy] of [[-1500, -900], [2200, -300], [-2200, 200], [0, 3600], [300, -600]]) {
    let st = { x: 1200, y: 300, vx, vy }
    let frames = 0
    while (!st.atRest && frames < 1200) {
      st = P.throwStep(st, 1 / 60, b, P.DEFAULT_PHYSICS)
      frames++
      assert.ok(Number.isFinite(st.x) && Number.isFinite(st.y), `坐标不能是 NaN（会让 setPosition 抛错、桌宠卡死）：${vx},${vy}`)
      assert.ok(st.x >= b.minX - 1e-6 && st.x <= b.maxX + 1e-6, `x 不越界：${vx},${vy} 第${frames}帧`)
      assert.ok(st.y >= b.minY - 1e-6 && st.y <= b.maxY + 1e-6, `y 不越界：${vx},${vy} 第${frames}帧`)
    }
    assert.ok(st.atRest, `甩出 (${vx},${vy}) 必须在 20s（1200 帧）内静止，实际 ${frames} 帧`)
    assert.equal(st.y, b.maxY, '最终落在地面')
  }
})

// ---------- 右键「动作」菜单与点播地址表（回归：菜单 106 段只建了 26 个地址 → 点了没反应） ----------

function loadPackMetaLib() {
  const code = readFileSync(join(MODULE_DIR, 'pet-client', 'packmeta.js'), 'utf8')
  const m = { exports: {} }
  new Function('module', 'exports', code)(m, m.exports) // UMD：以 CommonJS 形态求值
  return m.exports
}

test('packmeta：knownAnims 合并「三个池 ∪ 包目录里的 webm」（菜单项不能只在池里）', () => {
  const M = loadPackMetaLib()
  const pools = { idle: ['anim-001', 'anim-002'], speak: ['anim-003'], click: ['anim-004'] }
  const files = ['anim-001.webm', 'anim-002.webm', 'anim-003.webm', 'anim-004.webm', 'anim-090.webm', 'notes.txt']
  const names = M.knownAnims(pools, files)
  assert.deepEqual(names, ['anim-001', 'anim-002', 'anim-003', 'anim-004', 'anim-090'], '池外的 anim-090 也必须进名单，非 webm 忽略')
  assert.deepEqual(M.namesFromFiles(['a.webm', 'b.WEBM', 'c.png']), ['a', 'b'])
  // 地址表：空的 url（端口未知）不能占位，否则渲染页会拿空 src 去 play
  const map = M.animUrlMap(names, (n) => (n === 'anim-002' ? '' : `http://h/asset/${n}.webm?token=t`))
  assert.equal(Object.keys(map).length, 4)
  assert.equal(map['anim-002'], undefined)
})

test('packmeta：resolveMenu 把配置里的中文原名映射成素材 id，未知项跳过、无 menu 回落三个池', () => {
  const M = loadPackMetaLib()
  const manifest = { 三球抛接: 'anim-001', 下五子棋: 'anim-002', 中秋赏月吃月饼: 'anim-004' }
  const cfg = { menu: [{ label: '才艺', anims: ['三球抛接', '下五子棋', '不存在的动画'] }, { label: '节日', anims: ['中秋赏月吃月饼'] }, { label: '空分类', anims: [] }] }
  const cats = M.resolveMenu(cfg, manifest, { idle: ['anim-001'], speak: [], click: [] })
  assert.deepEqual(cats, [
    { label: '才艺', items: [{ label: '三球抛接', id: 'anim-001' }, { label: '下五子棋', id: 'anim-002' }] },
    { label: '节日', items: [{ label: '中秋赏月吃月饼', id: 'anim-004' }] },
  ], '中文原名 → id，未知动画与空分类都过滤')
  // 配置里直接写 id 也认
  assert.equal(M.resolveMenu({ menu: [{ label: 'x', anims: ['anim-004'] }] }, manifest, {}).length, 1)
  // 没有 menu 段：按池回落，标签用原名
  const fallback = M.resolveMenu({}, manifest, { idle: ['anim-001', 'anim-002'], speak: [], click: ['anim-004'] })
  assert.deepEqual(fallback, [
    { label: '待机', items: [{ label: '三球抛接', id: 'anim-001' }, { label: '下五子棋', id: 'anim-002' }] },
    { label: '互动', items: [{ label: '中秋赏月吃月饼', id: 'anim-004' }] },
  ])
})

test('契约：菜单里每一项都能在素材地址表里查到（用户看到的「点菜单没反应」就是这条断了）', () => {
  const M = loadPackMetaLib()
  // 仿 default 包的真实形状：106 段素材，只有 26 段在 idle/speak/click 三个池里
  const files = Array.from({ length: 106 }, (_, i) => `anim-${String(i + 1).padStart(3, '0')}.webm`)
  const ids = files.map((f) => f.replace('.webm', ''))
  const pools = { idle: ids.slice(0, 13), speak: ids.slice(13, 18), click: ids.slice(18, 26) }
  const manifest = {}
  for (const id of ids) manifest[`动作-${id}`] = id
  const cfg = { menu: [{ label: '全部', anims: ids.map((id) => `动作-${id}`) }] }

  const view = { name: 'default', animations: pools }
  const anims = M.animUrlMap(M.knownAnims(view.animations, files), (n) => `http://127.0.0.1:1/api/asset/default/${n}.webm?token=t`)
  assert.equal(Object.keys(anims).length, 106, '地址表必须覆盖包目录里的全部 106 段，而不是池里的 26 段')
  for (const cat of M.resolveMenu(cfg, manifest, pools)) {
    for (const it of cat.items) assert.ok(anims[it.id], `菜单项「${it.label}」必须有素材地址（否则渲染页返回 false，桌宠继续播自己的 idle）`)
  }
  // 主进程确实走了这条合并逻辑（不是又退回只遍历三个池的老实现）
  const mainSrc = readFileSync(join(MODULE_DIR, 'pet-client', 'main.js'), 'utf8')
  assert.match(mainSrc, /metaApi\.knownAnims\(/, 'pushPackToRenderer 必须用 knownAnims 建地址表')
  assert.match(mainSrc, /metaApi\.resolveMenu\(/, '右键「动作」菜单必须用 resolveMenu 构建')
})

// ---------- 碎碎念（桌宠自己的气泡流）：载体是 QQ 也必须照常出现 ----------

/** 写一份碎碎念状态文件（nextAt 设成已到点；count 可指定）。 */
function seedWhisper(api, patch = {}) {
  const day = new Date().toDateString()
  const file = api.dataDir('whisper.json')
  writeFileSync(file, JSON.stringify({ day, count: 0, nextAt: Date.now() - 1000, lastAt: 0, lastText: '', recent: [], ...patch }))
  return file
}
/** 造一个形象包：webm 用 ASCII id，manifest 把中文原名映射过去（与真实 default 包同形状）。 */
function seedPack(api, { name = 'default', manifest = {}, extraFiles = [] } = {}) {
  const dir = api.dataDir('packs', `${name}-animation`)
  mkdirSync(dir, { recursive: true })
  for (const f of [...Object.values(manifest).map((id) => `${id}.webm`), ...extraFiles]) writeFileSync(join(dir, f), 'fake-webm')
  writeFileSync(api.dataDir('packs', `${name}-manifest.json`), JSON.stringify(manifest))
}

test('碎碎念：载体是 QQ 时照样推桌宠气泡（用户报的「永远不会主动碎碎念」）；且绝不发 QQ', async () => {
  const env = startModule({ settings: { carrier: 'qq', whisperSource: 'pool' } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, speakUp: { awakeFrom: 0, awakeTo: 24 } }) // 全天醒着：不受测试运行时段影响
  seedWhisper(env.api)
  const { cursor } = await env.connect() // 变成在线
  const r = await env.exports.whisperNow({ force: false })
  assert.equal(r.ok, true, '载体=qq 不应拦住碎碎念：' + JSON.stringify(r))
  assert.equal(r.via, 'pet')
  assert.ok(String(r.text || '').length > 0, '要有一句话')
  const ev = await env.call('/events', { query: { since: String(cursor), wait: '0', client: 'pet-test' } })
  const bubble = (ev.json.events || []).find((e) => e.type === 'proactive')
  assert.ok(bubble, '必须推到桌宠气泡事件')
  assert.equal(bubble.purpose, 'whisper', '碎碎念用 purpose=whisper 打标签，不发 QQ')
  assert.equal(env.sentToQQ.length, 0, '碎碎念永远不发 QQ')
})

test('碎碎念：载体是桌宠且开启暂停 → 不发（避免和主动搭话两个气泡）', async () => {
  const env = startModule({ settings: { carrier: 'pet', whisperPauseOnPetCarrier: true } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, ext: { speakup: { carrier: 'pet' } } })
  seedWhisper(env.api)
  await env.connect()
  const r = await env.exports.whisperNow({ force: false })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'carrier-pet')
})

test('碎碎念：桌宠离线不发、也不回落 QQ；未到点不发', async () => {
  const env = startModule({ settings: { carrier: 'qq' } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, speakUp: { awakeFrom: 0, awakeTo: 24 } })
  seedWhisper(env.api)
  const off = await env.exports.whisperNow({ force: false })
  assert.equal(off.reason, 'pet-offline', '离线时只在桌宠出现，绝不退化成 QQ 消息')
  await env.connect()
  seedWhisper(env.api, { nextAt: Date.now() + 30 * 60_000 })
  const notDue = await env.exports.whisperNow({ force: false })
  assert.equal(notDue.reason, 'not-due')
  assert.equal(env.sentToQQ.length, 0)
})

test('碎碎念：达到每日上限 / 正在干活时都不打断', async () => {
  const env = startModule({ settings: { carrier: 'qq', whisperMaxPerDay: 2 } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, speakUp: { awakeFrom: 0, awakeTo: 24 } })
  await env.connect()
  seedWhisper(env.api, { count: 2 })
  const cap = await env.exports.whisperNow({ force: false })
  assert.equal(cap.reason, 'daily-max')
  // 干活中：让路（别在思考/写代码时插一句碎碎念）
  seedWhisper(env.api, { count: 0 })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'tool/call', data: { name: 'read_file' } })
  const busy = await env.exports.whisperNow({ force: false })
  assert.equal(busy.reason, 'busy')
})

test('碎碎念：文案池可以自定义，手动（force）跳过开关与排程但仍尊重专注模式', async () => {
  const env = startModule({ settings: { carrier: 'qq', whisperSource: 'pool', whisperLines: '（自己写的碎碎念）' } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, speakUp: { awakeFrom: 0, awakeTo: 24 } })
  await env.connect()
  const r = await env.exports.whisperNow({ force: true })
  assert.equal(r.text, '（自己写的碎碎念）')
  // 专注模式：force 也不打扰
  const focusFile = env.api.dataDir('focus.json')
  writeFileSync(focusFile, JSON.stringify({ enabled: true }))
  const f = await env.exports.whisperNow({ force: true })
  assert.equal(f.ok, false)
  assert.equal(f.reason, 'focus')
})

// ---------- 干活状态（DSH 会话事件 → 动画 / 结束提醒） ----------

test('干活状态：turn/start → thinking、tool/call → working、turn/end completed → success + 收尾文案', async () => {
  const env = startModule({ settings: { carrier: 'pet' } })
  seedPack(env.api, {
    manifest: {
      '工作状态-思考冒泡': 'anim-001', '工作状态-忙碌点按': 'anim-002', '工作状态-清点归档': 'anim-003',
      '工作状态-原地踱步张望': 'anim-004', '工作状态-雀跃庆祝': 'anim-005', '工作状态-垂头叹气冒汗': 'anim-006',
      '碎碎念-对屏碎碎念': 'anim-007',
    },
  })
  const { cursor } = await env.connect()
  // 包视图按中文命名约定自动识别六档（零配置）
  const cfg = await env.call('/config')
  assert.deepEqual(cfg.json.pack.workStatus, {
    thinking: 'anim-001', working: 'anim-002', result: 'anim-003',
    waiting: 'anim-004', success: 'anim-005', error: 'anim-006',
  })
  assert.deepEqual(cfg.json.pack.whisperAnims, ['anim-007'], '碎碎念动画池按「碎碎念」命名自动识别')
  assert.equal(env.exports.workStatus().state, null, '没活干时是空闲')

  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/start' })
  assert.equal(env.exports.workStatus().state, 'thinking')
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'todo/write', data: { todos: [{ status: 'in_progress', content: '改桌宠气泡' }] } })
  assert.equal(env.exports.workStatus().task, '改桌宠气泡', '清单进度带进快照（面板/气泡都用它）')
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'tool/call', data: { name: 'write_file' } })
  assert.equal(env.exports.workStatus().state, 'working')
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const done = env.exports.workStatus()
  assert.equal(done.state, 'success')
  assert.match(done.text, /搞定/, '收尾要有一句能弹气泡/发通知的话')

  const ev = await env.call('/events', { query: { since: String(cursor), wait: '0', client: 'pet-test' } })
  const workEvents = (ev.json.events || []).filter((e) => e.type === 'work').map((e) => e.state)
  assert.deepEqual(workEvents, ['thinking', 'working', 'success'], '每次档位变化推一条；todo/write 只改文案不改档位')
})

test('干活状态：出错/阻塞/中断分别落 error、waiting、回空闲；子代理事件不参与', () => {
  const env = startModule({ settings: { carrier: 'pet' } })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/start' })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
  assert.equal(env.exports.workStatus().state, 'error')
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/start' })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
  assert.equal(env.exports.workStatus().state, 'waiting')
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/start' })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  assert.equal(env.exports.workStatus().state, null, '中断要清回空闲，不能永远卡在干活中')
  // 子代理：多跑几路不该让桌宠一直闪
  env.exports.onSessionEvent({ header: { id: 'sub', origin: 'subagent' } }, { type: 'turn/start' })
  assert.equal(env.exports.workStatus().state, null)
  env.exports.onSessionEvent({ header: { id: 'sub2', delegationDepth: 2 } }, { type: 'tool/call', data: { name: 'x' } })
  assert.equal(env.exports.workStatus().state, null)
})

test('干活状态：ask_user_question 归 waiting；关掉状态动画后事件不再档位化', () => {
  const env = startModule({ settings: { carrier: 'pet', workStatusEnabled: false } })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'tool/call', data: { name: 'ask_user_question' } })
  assert.equal(env.exports.workStatus().state, 'waiting')
  env.exports.onSessionEvent({ header: { id: 's2' } }, { type: 'turn/start' })
  assert.equal(env.exports.workStatus().state, 'waiting', '关掉开关不影响已存在的档位展示，只是不再新开档')
})

// ---------- 碎碎念：跟她「自己」的一个回合（工作区思考窗口 + 记忆），但不是主动搭话 ----------

test('碎碎念：自己想一句时走后台回合（工作区能看到思考），提示词带记忆与 DSH 状态；不选目的、不发 QQ', async () => {
  const env = startModule({ settings: { carrier: 'qq', whisperSource: 'model' } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, speakUp: { awakeFrom: 0, awakeTo: 24 } })
  env.setMemory([
    { id: 'm1', text: '主人喜欢喝冰美式，不加糖', importance: 0.8, at: Date.now() - 3600_000 },
    { id: 'm2', text: '说了周末要一起看《海街日记》', importance: 0.6, at: Date.now() - 7200_000 },
  ])
  env.setThinkReply('【思考】想起他爱喝冰美式\n（盯着杯子看了一会儿）冰美式…要不要也给自己倒一杯')
  seedWhisper(env.api)
  const { cursor } = await env.connect()
  // 先造一个「正在干活」的状态：提示词里要带上
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/start' })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'todo/write', data: { todos: [{ status: 'in_progress', content: '改桌宠气泡' }] } })

  const r = await env.exports.whisperNow({ force: true }) // force：干活中默认会推后，这里要验的是「想」的内容
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(env.thinkCalls.length, 1, '应该走一次后台系统回合（而不是 api.ask 一次性问答）')
  assert.equal(env.thinkCalls[0].title, '桌宠 · 碎碎念（自己的回合）', '工作区里那条会话的标题')
  assert.equal(env.thinkCalls[0].noTools, true)
  const prompt = env.thinkCalls[0].prompt
  assert.match(prompt, /冰美式/, '记忆要进提示词（结合记忆碎碎念）')
  assert.match(prompt, /思考中|干活中/, 'DSH 干活状态要进提示词')
  assert.match(prompt, /改桌宠气泡/, '当前清单步骤也要进提示词')
  assert.match(prompt, /不是主动搭话|不是在回复消息/, '要跟主动搭话区分开，别让她当成找人聊天')
  assert.equal(r.text, '（盯着杯子看了一会儿）冰美式…要不要也给自己倒一杯'.slice(0, 60), '备忘段【思考】要被切掉，只留那句话')

  const ev = await env.call('/events', { query: { since: String(cursor), wait: '0', client: 'pet-test' } })
  const bubble = (ev.json.events || []).find((e) => e.type === 'proactive')
  assert.ok(bubble, '要想出话并推到桌宠气泡')
  assert.equal(bubble.purpose, 'whisper')
  assert.equal(env.sentToQQ.length, 0, '碎碎念永不发 QQ')
})

test('碎碎念：她这次想说 [沉默] → 回落到文案池，照样只上桌宠；同一时间只跑一个后台回合', async () => {
  const env = startModule({ settings: { carrier: 'qq', whisperSource: 'model', whisperLines: '（今天有点懒）' } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, speakUp: { awakeFrom: 0, awakeTo: 24 } })
  await env.connect()
  env.setThinkReply('[沉默]')
  const r = await env.exports.whisperNow({ force: true })
  assert.equal(r.ok, true)
  assert.equal(r.text, '（今天有点懒）', '模型沉默时用面板文案池，不硬塞空话')

  // 上一轮还没想完：不并发开第二个后台回合
  let release
  env.holdThink(new Promise((resolve) => { release = resolve }))
  const first = env.exports.whisperNow({ force: true })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const second = await env.exports.whisperNow({ force: true })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'thinking')
  release()
  assert.equal((await first).ok, true)
  env.holdThink(null)
})

test('碎碎念：间隔最小 1 分钟、最大 9999 分钟、每天最多 9999 次都认（不再被夹回 5/48）', async () => {
  const env = startModule({ settings: { whisperMinMinutes: 1, whisperMaxMinutes: 9999, whisperMaxPerDay: 9999 } })
  const w = env.exports.whisperStatus()
  assert.equal(w.minMinutes, 1)
  assert.equal(w.maxMinutes, 9999)
  assert.equal(w.maxPerDay, 9999)
  assert.equal(w.thinking, false)
  assert.equal(w.turnTitle, '桌宠 · 碎碎念（自己的回合）')
  // 排程确实按 1~9999 分钟抽（不会因为下限被夹高而不动）
  const st = { day: new Date().toDateString(), count: 0, nextAt: 0, recent: [] }
  writeFileSync(env.api.dataDir('whisper.json'), JSON.stringify({ ...st }))
})

// ---------- 对话框（petChat） ----------

test('对话框：闸门链——默认关 / 离线 / 专注 / 并发锁 / 关键字拦截（命中不请求模型）', async () => {
  const env = startModule({ settings: { petChatCloseKeyword: '关闭' } }) // fake api 不带模块默认值，关键字显式给
  const r0 = await env.exports.petChat('你好')
  assert.equal(r0.ok, false)
  assert.equal(r0.reason, 'disabled', '默认关（petChatEnabled 默认 off）')

  env.api.saveSettings({ petChatEnabled: true })
  const r1 = await env.exports.petChat('你好')
  assert.equal(r1.reason, 'pet-offline', '没连 /events = 桌宠离线')

  await env.connect()
  env.exports.setFocus(true)
  assert.equal((await env.exports.petChat('你好')).reason, 'focus', '专注模式沿用 focusOn 闸')
  env.exports.setFocus(false)

  // 并发锁独立命名（petChatBusy）：上一句还没答完就拒收新句
  let release
  env.setThinkReply('嗯')
  env.holdThink(new Promise((resolve) => { release = resolve }))
  const first = env.exports.petChat('在吗')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const second = await env.exports.petChat('然后呢')
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'thinking')
  release()
  assert.equal((await first).ok, true)
  env.holdThink(null)

  // 关键字拦截：命中直接关窗（chatClose 事件）、不请求模型、不落历史
  const before = env.thinkCalls.length
  const lines = env.exports.petChatHistory(50).length
  const rK = await env.exports.petChat('关闭')
  assert.equal(rK.ok, true)
  assert.equal(rK.closed, true)
  assert.equal(env.thinkCalls.length, before, '关键字命中不请求模型')
  assert.equal(env.exports.petChatHistory(50).length, lines, '关键字命中不落历史')
  const ev = await env.connect({ wantEvents: true, since: 0 })
  assert.ok(ev.events.some((e) => e.type === 'chatClose'), '下发 chatClose 让客户端关窗')
})

test('对话框并发：两个请求同时进，只有一个通过（检查与占位之间不能有 await）', async () => {
  const env = startModule({ settings: { petChatEnabled: true } })
  await env.connect()
  let release
  env.setThinkReply('嗯')
  env.holdThink(new Promise((resolve) => { release = resolve }))
  // 同步发起两句：第一句同步占位后进模型，第二句必须立即 thinking（复审 #18-4 的竞态）
  const first = env.exports.petChat('第一句')
  const second = await env.exports.petChat('第二句')
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'thinking', '检查与占位之间不能 await，否则两个都能过')
  release()
  assert.equal((await first).ok, true)
  env.holdThink(null)
})

test('对话框：管线——独立回合 key=petChat、走私聊主人记忆（recallHint 读 / [记] 写归主人）、窗开走 chat 事件、窗关走气泡', async () => {
  const env = startModule({ settings: { petChatEnabled: true } })
  env.setMemHint('（你记得这些事…）')
  await env.connect()

  // 窗开着：客户端上报 open → 回复走 chat 事件
  await env.call('/chat/state', { method: 'POST', json: { open: true, hotkey: 'registered', hotkeyKey: 'Alt+P' } })
  env.setThinkReply('嗯嗯，我在的\n[记] 主人喜欢深夜写代码')
  const r = await env.call('/chat', { method: 'POST', json: { text: '在吗' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.viaWindow, true)
  assert.ok(r.json.messageId, 'chat 事件与 POST 响应共用 messageId（客户端去重）')

  const tc = env.thinkCalls.at(-1)
  assert.equal(tc.key, 'petChat', '独立后台回合 key=petChat（不抢碎碎念/行为会话）')
  assert.equal(tc.title, '桌宠 · 对话框（主人找她聊）')
  assert.equal(tc.noTools, true)
  assert.ok(tc.prompt.includes('主人在对话框里找你说话'), '框定语句换成「主人找她聊」')
  assert.ok(!tc.prompt.includes('没有人跟你说话'), '不再用碎碎念的自言自语框定')
  assert.ok(tc.prompt.includes('回复主人的这句话'), '结尾指令')
  // 记忆读：走私聊主人上下文（about 归主人、弱命中带上一句）
  const hint = env.memHintCalls.at(-1)
  assert.equal(hint.chat.kind, 'private')
  assert.equal(String(hint.chat.userId), OWNER)
  assert.equal(hint.chat.chatId, `private:${OWNER}`)
  assert.ok(tc.prompt.includes('（你记得这些事…）'))
  // 记忆写：[记] 标记 → add，about 必须归到主人头上（否则私聊 recall 想不起）
  assert.equal(env.memAdds.length, 1)
  assert.equal(env.memAdds[0].about, OWNER)
  assert.equal(env.memAdds[0].source, 'pet')
  assert.ok(env.memAdds[0].tags.includes('对话框'))

  // 历史双向落盘（服务端截断下发）
  const h = await env.call('/chat/history', { query: { limit: 50 } })
  assert.deepEqual(h.json.items.map((x) => x.role), ['user', 'pet'])
  assert.equal(h.json.items[1].text, '嗯嗯，我在的', '[记] 备忘不进历史与气泡')
  // 历史也带 messageId：开窗拉历史后，迟到的 chat 事件才能按 id 去重（复审 #18-3）
  assert.equal(h.json.items[1].messageId, r.json.messageId, '回复的历史项要带同一个 messageId')

  // 回复途中窗被关：改走碎碎念气泡（proactive，purpose=whisper，绝不发 QQ）
  await env.call('/chat/state', { method: 'POST', json: { open: false } })
  env.setThinkReply('那早点睡呀')
  const { cursor } = await env.connect()
  const r2 = await env.call('/chat', { method: 'POST', json: { text: '我先下了' } })
  assert.equal(r2.json.ok, true)
  assert.equal(r2.json.viaWindow, false)
  const ev = await env.connect({ wantEvents: true, since: cursor })
  const bubble = ev.events.find((e) => e.type === 'proactive')
  assert.ok(bubble, '窗关后回复走碎碎念气泡')
  assert.equal(bubble.purpose, 'whisper')
  assert.equal(env.sentToQQ.length, 0, '永不发 QQ')
})

test('对话框：memory 模块不在 → 不带记忆直接答，绝不挂；空回复也按空口径处理', async () => {
  const env = startModule({ settings: { petChatEnabled: true } })
  env.api.use = () => null // memory/mood 全不在
  await env.connect()
  env.setThinkReply('在的呀')
  const r = await env.call('/chat', { method: 'POST', json: { text: '在吗' } })
  assert.equal(r.status, 200, 'memory 模块不在不能把对话框搞挂（验收项）')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.text, '在的呀')

  env.setThinkReply('[沉默]')
  const r2 = await env.call('/chat', { method: 'POST', json: { text: '再说点' } })
  assert.equal(r2.status, 400)
  assert.equal(r2.json.ok, false)
})

test('对话框：历史上限头部截断 + 保留天数清理（0=永久）', async () => {
  const env = startModule({ settings: { petChatEnabled: true, petChatMaxEntries: 10, petChatRetentionDays: 0 } })
  await env.connect()
  env.setThinkReply('嗯')
  for (let i = 0; i < 8; i++) await env.exports.petChat('消息' + i)
  const h = env.exports.petChatHistory(50)
  assert.ok(h.length <= 10, `超限从头部截断（实际 ${h.length} 条）`)
  assert.equal(h.at(-1).text, '嗯')

  // 过期清理：retentionDays=0 → 永久，一条不清
  const now = Date.now()
  const file = env.api.dataDir('chat/history.jsonl')
  const line = (ts, text) => JSON.stringify({ ts, role: 'user', text })
  writeFileSync(file, [line(now - 40 * 86400_000, '旧事'), line(now - 1000, '新话')].join('\n') + '\n')
  assert.equal((await env.exports.petChatSweep(now)).removed, 0, '0=永久：不清')

  // retentionDays=30 → 只清过期行
  env.api.saveSettings({ petChatRetentionDays: 30 })
  const r = await env.exports.petChatSweep(now)
  assert.equal(r.removed, 1)
  assert.deepEqual(env.exports.petChatHistory(50).map((x) => x.text), ['新话'])
})

// ---------- 天气（一期） ----------

test('天气：配置城市后拉取进缓存与 prompt；城市留空整块静默；失败保留旧值不炸', async () => {
  const env = startModule({
    settings: { petChatEnabled: true, petWeatherCity: '上海' },
    hooks: { fetchWeather: async () => ({ ok: true, text: async () => '晴 +26°C' }) },
  })
  await env.exports.weatherFetchOnce()
  assert.ok(env.exports.petChatStatus().weather.includes('26'), '拉取结果进状态')
  await env.connect()
  env.setThinkReply('嗯')
  await env.exports.petChat('今天出门带伞吗')
  assert.ok(env.thinkCalls.at(-1).prompt.includes('天气：晴'), '天气进 prompt 的「现在」段')

  // 接口挂了：静默（不抛、状态还在），换城市后旧缓存不串台
  const env2 = startModule({
    settings: { petChatEnabled: true, petWeatherCity: '北京' },
    hooks: { fetchWeather: async () => { throw new Error('net down') } },
  })
  await env2.exports.weatherFetchOnce() // 不应抛
  assert.equal(env2.exports.petChatStatus().weather, '', '失败保留空缓存、不报错打扰')

  const env3 = startModule({ settings: { petChatEnabled: true } }) // 城市留空
  await env3.exports.weatherFetchOnce() // 整块静默跳过
  assert.equal(env3.exports.petChatStatus().weather, '')
  assert.equal(env3.exports.petChatStatus().weatherCity, '')
})

// ---------- 远端直连（publicBaseUrl，2026-11-02）：配置后桌宠可跨机连服务器；同机零退化 ----------

test('远端直连：配置 publicBaseUrl 后 host.json 写远端地址；status 报 remoteClient', async () => {
  const env = startModule({ settings: { publicBaseUrl: 'https://bot.example.com' } })
  const hostFile = env.api.dataDir('host.json')
  const h = JSON.parse(readFileSync(hostFile, 'utf8'))
  assert.equal(h.baseUrl, 'https://bot.example.com', '配置了对外地址：baseUrl 写它')
  assert.equal(h.api, '/aurabot/api', 'api 字段照旧')
  assert.equal(h.token, env.token, 'token 照旧')
  assert.equal(env.exports.status().remoteClient, true)
  assert.equal(env.exports.status().publicBaseUrl, 'https://bot.example.com')
  // 末尾斜杠剥掉再存；非法值（非 http(s)）一律当未配置
  const env2 = startModule({ settings: { publicBaseUrl: 'https://bot.example.com/' } })
  assert.equal(JSON.parse(readFileSync(env2.api.dataDir('host.json'), 'utf8')).baseUrl, 'https://bot.example.com', '末尾斜杠剥掉')
  const env3 = startModule({ settings: { publicBaseUrl: 'ftp://nope' } })
  assert.equal(JSON.parse(readFileSync(env3.api.dataDir('host.json'), 'utf8')).baseUrl, null, '非法 URL 不生效：照旧写 null')
  assert.equal(env3.exports.status().remoteClient, false)
})

test('远端直连：guard 对远端 Host/Origin 放行；无 token 401；Host 不匹配 403；token 逻辑一字不动', async () => {
  const env = startModule({ settings: { publicBaseUrl: 'https://bot.example.com' } })
  // 远端 Host + 正确 token → 放行
  const ok = await env.call('/status', { headers: { host: 'bot.example.com' } })
  assert.equal(ok.status, 200, '远端 Host（与 publicBaseUrl 主机名一致，端口段忽略）放行')
  const okPort = await env.call('/status', { headers: { host: 'bot.example.com:8443' } })
  assert.equal(okPort.status, 200, '端口段忽略')
  // 无 token 的远端请求 → 401（跨机唯一防线，一字未动）
  const noTk = await env.call('/status', { token: '', headers: { host: 'bot.example.com' } })
  assert.equal(noTk.status, 401)
  const badTk = await env.call('/status', { token: 'deadbeef'.repeat(6), headers: { host: 'bot.example.com' } })
  assert.equal(badTk.status, 401)
  // Host 不匹配（非回环也非配置主机）→ 403
  const badHost = await env.call('/status', { headers: { host: 'evil.example.net' } })
  assert.equal(badHost.status, 403)
  // Origin：远端同域放行；陌生域 403
  const okOrigin = await env.call('/focus', { method: 'POST', json: { enabled: true }, headers: { host: 'bot.example.com', origin: 'https://bot.example.com' } })
  assert.equal(okOrigin.status, 200, 'Origin 主机 = 配置主机 → 放行')
  const badOrigin = await env.call('/focus', { method: 'POST', json: { enabled: false }, headers: { origin: 'https://evil.example.net' } })
  assert.equal(badOrigin.status, 403, '跨站 Origin 仍拒绝')
  // 同机回环路径照常可用
  const loop = await env.call('/status')
  assert.equal(loop.status, 200)
})

test('远端直连：Host 头端口学习停用（远端地址不被冲掉）；X-Forwarded 兜底学习生效（显式配置优先）', async () => {
  const env = startModule({ settings: { publicBaseUrl: 'https://bot.example.com' } })
  const hostFile = env.api.dataDir('host.json')
  await env.call('/status', { headers: { host: '127.0.0.1:53299' } })
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, 'https://bot.example.com', '远端模式：回环 Host 学习不再改写 host.json')

  // 未显式配置：反代同机转发（Host 是回环，先过 Host 闸；X-Forwarded 说明真实对外地址）→ 鉴权后学习
  const env2 = startModule({})
  const hf2 = env2.api.dataDir('host.json')
  const fwd = await env2.call('/status', { headers: { host: '127.0.0.1:53210', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'learned.example.com' } })
  assert.equal(fwd.status, 200, '反代同机转发（回环 Host + 合法 token）放行')
  assert.equal(JSON.parse(readFileSync(hf2, 'utf8')).baseUrl, 'https://learned.example.com', '鉴权通过后的兜底学习写进 host.json')
  // 显式配置优先：设置后兜底学习不再覆盖
  env2.api.saveSettings({ publicBaseUrl: 'https://explicit.example.com' })
  env2.exports.writeHostFile(true)
  await env2.call('/status', { headers: { host: '127.0.0.1:53210', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'other.example.net' } })
  assert.equal(JSON.parse(readFileSync(hf2, 'utf8')).baseUrl, 'https://explicit.example.com', '显式配置优先于兜底学习')
})

// 安全回归（2026-11-02）：学习必须发生在鉴权之后，否则未鉴权请求可投毒 host.json 并借 hostAllowed 绕过 Host 闸
test('安全：未鉴权的外部请求伪造 X-Forwarded 头投毒 host.json 被拒（baseUrl 不被改写）', async () => {
  const env = startModule({}) // 未配置 publicBaseUrl = 原本会走 X-Forwarded 兜底学习的场景
  const hostFile = env.api.dataDir('host.json')
  const before = JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl
  // 攻击面：伪造 Host + X-Forwarded-Host + X-Forwarded-Proto，且不带任何令牌
  const poison = { host: 'evil.example.net', 'x-forwarded-host': 'evil.example.net', 'x-forwarded-proto': 'https' }
  const noToken = await env.call('/status', { token: '', headers: poison })
  assert.ok([401, 403].includes(noToken.status), `未带 token 的投毒请求必须被拒（实际 ${noToken.status}）`)
  // 即便 Host 闸先挡住（403），也不能在挡之前写盘
  assert.notEqual(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, 'https://evil.example.net', 'host.json 的 baseUrl 不能被投毒成攻击者地址')
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, before, 'baseUrl 保持原值（未被任何未鉴权请求改写）')
  // 坏令牌同理：401 之后同样不得学习
  const badToken = await env.call('/status', { token: 'deadbeef'.repeat(6), headers: poison })
  assert.ok([401, 403].includes(badToken.status), `坏令牌的投毒请求必须被拒（实际 ${badToken.status}）`)
  assert.notEqual(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, 'https://evil.example.net', '坏令牌同样不能投毒')
})

test('安全：鉴权通过后 X-Forwarded 兜底学习仍生效（能力保留，只是挪到鉴权之后）', async () => {
  const env = startModule({})
  const hostFile = env.api.dataDir('host.json')
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, null, '端口未注入：学习前是 null')
  // 与用例 1 同一套攻击头，唯一区别是这次带合法令牌：Host 用回环（先过严格 Host 闸），
  // X-Forwarded 头带对外地址 → 学习按设计生效，证明能力只被「挪后」而没被删掉。
  const r = await env.call('/status', {
    headers: { host: '127.0.0.1:53210', 'x-forwarded-host': 'evil.example.net', 'x-forwarded-proto': 'https' },
  })
  assert.equal(r.status, 200, '带合法 token 的反代转发放行')
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, 'https://evil.example.net', '鉴权后学习照旧写进 host.json')
  assert.equal(env.exports.status().publicBaseUrl, 'https://evil.example.net', '学到后 status 也如实上报（remoteClient 打开）')
})

test('安全：未鉴权投毒在「Host 闸已放行」的路径上也写不进 host.json（回环 Host 也一样）', async () => {
  // 第一道闸（Host）被放行时，第二道闸（token）必须单独站住，且失败的请求一个字节都不许写
  const env = startModule({}) // 未配置 publicBaseUrl
  const hostFile = env.api.dataDir('host.json')
  // 先把端口注入好：这样回环 Host 的「端口漂移学习」是 no-op，任何 baseUrl 变化都只能来自投毒，
  // 断言才不会把同机模式合法的端口学习误判成漏洞（反过来也保证测的确实是学习闸而不是端口逻辑）。
  assert.equal(env.exports.setWebPort(53210), true)
  const before = JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl
  assert.equal(before, 'http://127.0.0.1:53210', '起点：端口已注入')
  // Host 用回环（必然过 Host 闸），只靠 X-Forwarded 试图学一个攻击者地址，且不带令牌
  const noTk = await env.call('/status', {
    token: '',
    headers: { host: '127.0.0.1:53210', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
  })
  assert.equal(noTk.status, 401, 'Host 闸放行后仍必须被 token 闸拦成 401')
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, before, '未鉴权请求不得写 host.json（baseUrl 一个字节都不变）')
  assert.notEqual(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, 'https://evil.example', '绝不能学成攻击者地址')
  // 坏令牌同理
  const badTk = await env.call('/status', {
    token: 'deadbeef'.repeat(6),
    headers: { host: '127.0.0.1:53210', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
  })
  assert.equal(badTk.status, 401)
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, before, '坏令牌同样不得写 host.json')
  // 未鉴权请求也不能借学习结果给后续请求「开闸」（Host 闸不能因未鉴权输入而放宽）
  const follow = await env.call('/status', { headers: { host: 'evil.example' } })
  assert.equal(follow.status, 403, '未鉴权的 X-Forwarded 不能让 evil.example 进白名单')
})

test('安全：携带合法 token 的远端 Host 请求仍被 Host 闸拒绝（学习不改变「未配置就不放行远端」）', async () => {
  // 未配置 publicBaseUrl 时，即使令牌正确、且伪造 Host 与 X-Forwarded 完全自洽，也不得放行：
  // 否则等于「任何能构造该请求头的人」都能用 Host 闸换一个令牌猜测入口（Host 闸必须独立成立）。
  const env = startModule({})
  const hostFile = env.api.dataDir('host.json')
  const before = JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl
  const r = await env.call('/status', {
    headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
  })
  assert.equal(r.status, 403, '未配置 publicBaseUrl：远端 Host 一律 403（哪怕带合法 token）')
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, before, '被 403 的请求不得写 host.json')
})

test('安全：显式配置 publicBaseUrl 时，已鉴权的伪造 X-Forwarded 也不得覆盖配置', async () => {
  const env = startModule({ settings: { publicBaseUrl: 'https://bot.example.com' } })
  const hostFile = env.api.dataDir('host.json')
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, 'https://bot.example.com', '显式配置起始值')
  // 回环 Host + 合法 token + 伪造 X-Forwarded：能过 Host 闸与鉴权，但学习必须被显式配置挡住
  const r = await env.call('/status', {
    headers: { host: '127.0.0.1:53210', 'x-forwarded-host': 'evil.example.net', 'x-forwarded-proto': 'https' },
  })
  assert.equal(r.status, 200, '回环 Host + 合法 token 正常放行')
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, 'https://bot.example.com', '显式配置优先：host.json 的 baseUrl 不被伪造头覆盖')
  assert.equal(env.exports.status().publicBaseUrl, 'https://bot.example.com', 'status 仍报显式配置的地址')
})

test('安全：明文 http 的跨机访问默认阻断；显式 allowInsecureRemote 才放行', async () => {
  // 默认：配了 http:// 的对外地址 + 真正的跨机来源（socket 非回环）+ 合法 token → 被明文闸挡住。
  // 【安全审查 P1-2】判定看 socket，不看 Host 头——旧实现只认 Host 头，远端发 Host:127.0.0.1 即可绕过。
  const env = startModule({ settings: { publicBaseUrl: 'http://bot.example.com' } })
  const st = await env.call('/status') // 进程内直调 = 本机
  assert.equal(st.status, 200, '本机请求照常放行')
  assert.equal(st.json.publicBaseInsecure, true, 'status 报明文风险，面板据此提示')
  assert.equal(st.json.allowInsecureRemote, false, '默认不允许明文跨机')
  const r = await env.call('/status', { socket: '203.0.113.9', headers: { host: 'bot.example.com' } })
  assert.equal(r.status, 403, '明文 http 跨机默认拒绝')
  assert.ok(/明文|https/i.test(String(r.json?.message || '')), '错误信息要说清楚要用 https')
  // Host 头伪造：把 Host 写成回环确实能骗过「Host 闸」，但骗不过「明文闸」——
  // 明文闸现在按 socket 判来源，所以真正的跨机来源仍会被挡住。
  const spoofed = await env.call('/status', { socket: '203.0.113.9', headers: { host: '127.0.0.1:53210' } })
  assert.equal(spoofed.status, 403, '伪造回环 Host 不能绕过明文阻断（P1-2 回归：判定看 socket 不看 Host）')
  // 但换一个真的跨机 socket + 对外 Host，明文闸照样拦
  const cross = await env.call('/status', { socket: '198.51.100.7', headers: { host: 'bot.example.com' } })
  assert.equal(cross.status, 403, '跨机来源 + 对外 Host 必被明文闸拦')
  // 显式放行后能过（只建议内网自测）
  const env2 = startModule({ settings: { publicBaseUrl: 'http://bot.example.com', allowInsecureRemote: true } })
  const r2 = await env2.call('/status', { socket: '203.0.113.9', headers: { host: 'bot.example.com' } })
  assert.equal(r2.status, 200, 'allowInsecureRemote 打开后放行')
})

test('安全：直连伪造 X-Forwarded-For 不能冒充本机，也不能绕过限速（P1-1 回归）', async () => {
  // 旧实现取 XFF 第一跳：攻击者每次换假 XFF 就能绕过封禁，也能伪造受害者 IP 让其被封（DoS）。
  // 新口径：socket 非回环 → 转发头一律不看。
  const env = startModule({ settings: { publicBaseUrl: 'https://bot.example.com' } })
  const ip = '203.0.113.9'
  const send = (extra) => env.call('/status', { socket: ip, headers: { host: 'bot.example.com', ...extra } })
  // 每次都换一个假的 XFF 首跳，真实来源 socket 不变 → 仍然会被累计封禁
  let first429At = 0
  for (let i = 1; i <= 25; i++) {
    const r = await send({ 'x-pet-token': 'f'.repeat(48), 'x-forwarded-for': `10.0.0.${i}` })
    if (r.status === 429) { first429At = i; break }
  }
  assert.equal(first429At, 21, '换假 XFF 首跳绕不过限速（按 socket 计数）')
  // 直连伪造 XFF:127.0.0.1 也不能把自己当本机从而免于明文阻断
  const env2 = startModule({ settings: { publicBaseUrl: 'http://bot.example.com' } })
  const bypass = await env2.call('/status', { socket: ip, headers: { host: 'bot.example.com', 'x-forwarded-for': '127.0.0.1' } })
  assert.equal(bypass.status, 403, '直连伪造 XFF 本机地址照样被明文闸拦住')
})

test('安全：只有可信反向代理的最后一跳才算真实来源（P1-1 回归）', async () => {
  // 反代场景：socket 是反代自己（回环），真实来源在 XFF 最后一跳。
  // 必须显式配 trustedProxy 才采信；未配置时一律按回环处理。
  // (a) 未配 trustedProxy：XFF 完全不被采信 → 按本机处理
  const noProxy = startModule({ settings: { publicBaseUrl: 'http://bot.example.com' } })
  const direct = await noProxy.call('/status', { socket: '127.0.0.1', headers: { host: 'bot.example.com', 'x-forwarded-for': '203.0.113.9' } })
  assert.equal(direct.status, 200, '未配 trustedProxy 时不采信 XFF，按本机放行')
  // (b) 配了 trustedProxy：socket 命中 → 采信 XFF 最后一跳，这时候是跨机 → 明文闸拦住
  const proxied = startModule({ settings: { publicBaseUrl: 'http://bot.example.com', trustedProxy: '127.0.0.1' } })
  const viaProxy = await proxied.call('/status', { socket: '127.0.0.1', headers: { host: 'bot.example.com', 'x-forwarded-for': '203.0.113.9' } })
  assert.equal(viaProxy.status, 403, '可信反代 + 真实来源非本机 → 明文闸拦住')
  // (c) 可信反代但末跳是回环 → 仍算本机
  const viaProxyLocal = await proxied.call('/status', { socket: '127.0.0.1', headers: { host: '127.0.0.1:53210', 'x-forwarded-for': '127.0.0.1' } })
  assert.equal(viaProxyLocal.status, 200, '可信反代 + 末跳回环 → 算本机')
  // (d) socket 不是可信反代 → 即使带 XFF 也不采信
  const notProxy = await proxied.call('/status', { socket: '198.51.100.7', headers: { host: 'bot.example.com', 'x-forwarded-for': '127.0.0.1' } })
  assert.equal(notProxy.status, 403, 'socket 不在 trustedProxy 里 → XFF 不被采信（仍按 socket 判跨机）')
})

test('安全：令牌轮换后旧令牌立即失效，新令牌可用', async () => {
  const env = startModule({ settings: { publicBaseUrl: 'https://bot.example.com' } })
  const oldToken = env.token
  const hostFile = env.api.dataDir('host.json')
  // 旧令牌可用
  const ok1 = await env.call('/status', { headers: { host: 'bot.example.com' } })
  assert.equal(ok1.status, 200, '轮换前旧令牌可用')
  // 轮换
  const rot = env.exports.rotateToken()
  assert.equal(rot.ok, true, '轮换成功')
  const newToken = JSON.parse(readFileSync(hostFile, 'utf8')).token
  assert.notEqual(newToken, oldToken, 'host.json 里已是新令牌')
  // 旧令牌立即失效
  const bad = await env.call('/status', { headers: { host: 'bot.example.com', 'x-pet-token': oldToken } })
  assert.equal(bad.status, 401, '旧令牌立即失效（这是令牌泄露时的应急手段）')
  // 新令牌可用
  const ok2 = await env.call('/status', { headers: { host: 'bot.example.com', 'x-pet-token': newToken } })
  assert.equal(ok2.status, 200, '新令牌可用')
})
test('安全：令牌连续失败触发按 IP 限速封禁（公网防暴力猜）', async () => {
  const env = startModule({ settings: { publicBaseUrl: 'https://bot.example.com' } })
  // 阈值 20 次：前 20 次 401，第 21 次起该 IP 被封禁（429），不再继续比对令牌
  const ip = '203.0.113.9'
  const send = (headers, socket = ip) => env.call('/status', { socket, headers: { host: 'bot.example.com', ...headers } })
  let first429At = 0
  for (let i = 1; i <= 25; i++) {
    const r = await send({ 'x-pet-token': 'f'.repeat(48) })
    if (r.status === 429) { first429At = i; break }
    assert.equal(r.status, 401, `第 ${i} 次错误令牌应仍是 401`)
  }
  assert.equal(first429At, 21, '第 21 次起触发封禁（阈值 20 次失败）')
  // 封禁期间即使令牌正确也拒绝（封禁先于比对）
  const blocked = await send({ 'x-pet-token': env.token })
  assert.equal(blocked.status, 429, '封禁期间该 IP 一律拒绝')
  // 换一个来源 IP 不受影响（限速按 IP 隔离，不能误伤别人）
  const other = await send({ 'x-pet-token': env.token }, '198.51.100.7')
  assert.equal(other.status, 200, '其它 IP 不受影响')
})

test('安全：客户端包只含客户端源码，不含 node_modules（消除 161MB 体积膨胀）', async () => {
  const env = startModule({ settings: { publicBaseUrl: 'https://bot.example.com' } })
  // 在 app/ 里造一个大文件（模拟 electronInstall 装进 node_modules 的 electron.exe）
  const appDir = env.api.dataDir('app')
  mkdirSync(join(appDir, 'node_modules', 'electron', 'dist'), { recursive: true })
  writeFileSync(join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe'), Buffer.alloc(2 * 1024 * 1024))
  const r = env.exports.clientPackage()
  assert.equal(r.ok, true, '打包成功')
  // 从 central directory 读条目名（只看名字，不解压内容）
  const zip = r.buffer
  const count = zip.readUInt16LE(zip.length - 22 + 10)
  let ptr = zip.readUInt32LE(zip.length - 22 + 16)
  const names = []
  for (let i = 0; i < count; i++) {
    const nameLen = zip.readUInt16LE(ptr + 28)
    names.push(zip.toString('utf8', ptr + 46, ptr + 46 + nameLen))
    ptr += 46 + nameLen + zip.readUInt16LE(ptr + 30) + zip.readUInt16LE(ptr + 32)
  }
  assert.ok(names.includes('main.js'), '必须含 main.js')
  assert.ok(names.includes('host.json'), '必须含内嵌 host.json')
  assert.equal(names.some((n) => n.includes('node_modules')), false, '不得把 node_modules（electron.exe 等）打进包')
  assert.ok(zip.length < 1024 * 1024, `包体积应远小于 1MB（实际 ${zip.length} 字节）`)
})

test('同机零退化：未配置 publicBaseUrl 时 host.json / guard 与旧行为一致', async () => {
  const env = startModule()
  const hostFile = env.api.dataDir('host.json')
  const h1 = JSON.parse(readFileSync(hostFile, 'utf8'))
  // 旧契约逐字段一致：端口未注入写 null、api 照旧、token 照旧
  assert.equal(h1.version, 1)
  assert.equal(h1.baseUrl, null)
  assert.equal(h1.api, '/aurabot/api')
  assert.equal(h1.token, env.token)
  assert.equal(env.exports.status().remoteClient, false)
  assert.equal(env.exports.setWebPort(53211), true)
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, 'http://127.0.0.1:53211', '端口注入照旧')
  await env.call('/status', { headers: { host: '127.0.0.1:53299' } })
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, 'http://127.0.0.1:53299', 'Host 头漂移学习照旧')
  // guard：非回环 Host 在同机模式下照旧 403（无对外地址可放行）
  const bad = await env.call('/status', { headers: { host: 'bot.example.com' } })
  assert.equal(bad.status, 403, '同机模式：远端 Host 仍拒绝')
})

test('客户端 readHost：接受远端 http(s) URL；坏 token 照旧拒绝；null 照旧等待', async () => {
  const src = readFileSync(join(MODULE_DIR, 'pet-client', 'main.js'), 'utf8')
  const m = src.match(/function readHost\(\) \{[\s\S]*?\/\*\* 回环主机名判定[\s\S]*?\n\}/)
  assert.ok(m, '要能从模板里抽出 readHost（含 isLoopbackHostname）做隔离求值')
  const make = (content) => {
    const fsStub = { readFileSync: () => content }
    return new Function('fs', 'HOST_FILE', m[0] + '; return readHost')(fsStub, 'host.json')
  }
  const good = (baseUrl, token = 'a'.repeat(48)) => JSON.stringify({ baseUrl, token, api: '/aurabot/api' })
  const remote = make(good('https://bot.example.com'))()
  assert.equal(remote.baseUrl, 'https://bot.example.com', '远端 https 地址放行')
  const lan = make(good('http://192.168.1.5:3000'))()
  assert.equal(lan.baseUrl, 'http://192.168.1.5:3000', '远端 http（局域网/明文）也放行，不阻断')
  const loop = make(good('http://127.0.0.1:53210'))()
  assert.equal(loop.baseUrl, 'http://127.0.0.1:53210', '同机回环照旧放行')
  assert.equal(make(good('https://bot.example.com', 'zzz'))(), null, 'token 格式校验照旧')
  assert.equal(make(JSON.stringify({ baseUrl: null, token: 'a'.repeat(48) }))(), null, 'baseUrl=null（端口自举等待期）照旧返回 null')
})

test('客户端包：/client-package 返回合法 zip（含 main.js 与内嵌远端 host.json）', async () => {
  const { inflateRawSync } = await import('node:zlib')
  const env = startModule({ settings: { publicBaseUrl: 'https://bot.example.com' } })
  const r = await env.call('/client-package')
  assert.equal(r.status, 200)
  const zip = Buffer.from(r.raw)
  // 用测试侧的第二套解析器读 central directory，交叉验证 zipBuffer 的产物
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, '尾部是 EOCD')
  const count = zip.readUInt16LE(zip.length - 22 + 10)
  let ptr = zip.readUInt32LE(zip.length - 22 + 16)
  const files = {}
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(ptr), 0x02014b50, `central entry ${i} 签名正确`)
    const method = zip.readUInt16LE(ptr + 10)
    const csize = zip.readUInt32LE(ptr + 20)
    const nameLen = zip.readUInt16LE(ptr + 28)
    const localOff = zip.readUInt32LE(ptr + 42)
    const name = zip.toString('utf8', ptr + 46, ptr + 46 + nameLen)
    // CRC32 校验（测试侧独立实现表）：防 zipBuffer 写坏 CRC 导致解压端报损坏
    const dataOff = localOff + 30 + zip.readUInt16LE(localOff + 26) + zip.readUInt16LE(localOff + 28)
    const data = method === 0 ? zip.subarray(dataOff, dataOff + csize) : inflateRawSync(zip.subarray(dataOff, dataOff + csize))
    {
      const table = []
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c }
      let c = -1
      for (const b of data) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
      assert.equal((c ^ -1) >>> 0, zip.readUInt32LE(ptr + 16), `CRC32 对得上：${name}`)
    }
    files[name] = data
    ptr += 46 + nameLen + zip.readUInt16LE(ptr + 30) + zip.readUInt16LE(ptr + 32)
  }
  assert.ok(files['main.js'], '客户端包里有 main.js')
  assert.ok(files['behavior.js'], '客户端包里有 behavior.js（行为层不能缺）')
  const host = JSON.parse(files['host.json'].toString('utf8'))
  assert.equal(host.baseUrl, 'https://bot.example.com', 'host.json 内嵌远端地址')
  assert.equal(host.token, env.token, 'host.json 内嵌 token（用户下载即可直连）')
  // 未配置远端时也能打包（host.json 是同机内容），但按钮只在远端模式出现
  const env2 = startModule({})
  const r2 = await env2.call('/client-package')
  assert.equal(r2.status, 200, '同机模式打包照常工作（面板不展示该按钮）')
})

// ---------- 1.0.14：面板六键（physics / animRate / 互动开关）+ 余额路由 ----------

test('1.0.14：defaults 与 /config 下发甩抛物理与互动开关；坏值回落 defaults 口径', async () => {
  const env = startModule()
  // 默认值口径（与 defaults 一致，别让默认配置就「飞起来」或「砸地上」）。
  // 注：fake api 的 settings() 不合 defaults（真实 makeApi 才合），所以 defaults 单独从 mod.defaults 验
  assert.equal(mod.defaults.petGravity, 1400)
  assert.equal(mod.defaults.petRestitution, 0.78)
  assert.equal(mod.defaults.petAnimRate, 1)
  assert.equal(mod.defaults.petShowBalance, true)
  assert.equal(mod.defaults.petClickChase, false)
  assert.equal(mod.defaults.petTeaseChase, false)
  // 版本三处同步：module.json 与 index.mjs 一起升
  assert.equal(mod.version, '1.0.16')
  assert.equal(JSON.parse(readFileSync(join(MODULE_DIR, 'module.json'), 'utf8')).version, '1.0.16')

  const cfg = await env.call('/config')
  assert.equal(cfg.status, 200)
  assert.deepEqual(cfg.json.physics, { gravity: 1400, restitution: 0.78 }, '/config.physics 默认口径')
  assert.equal(cfg.json.animRate, 1, '/config.animRate 默认口径')
  assert.equal(cfg.json.balanceEnabled, true, '/config.balanceEnabled 默认开')
  assert.equal(cfg.json.clickChase, false, '/config.clickChase 默认关')
  assert.equal(cfg.json.teaseChase, false, '/config.teaseChase 默认关')

  // 正常值原样透传
  env.api.saveSettings({ petGravity: 800, petRestitution: 0.5, petAnimRate: 1.5 })
  const cfg2 = await env.call('/config')
  assert.deepEqual(cfg2.json.physics, { gravity: 800, restitution: 0.5 })
  assert.equal(cfg2.json.animRate, 1.5)

  // 坏值回落：超界夹回 min/max；非数字回落 defaults（别让坏配置把桌宠弄失灵）
  env.api.saveSettings({ petGravity: 99, petRestitution: 5, petAnimRate: 'abc' })
  const cfg3 = await env.call('/config')
  assert.deepEqual(cfg3.json.physics, { gravity: 200, restitution: 0.95 }, '超界夹回 200~4000 / 0.3~0.95')
  assert.equal(cfg3.json.animRate, 1, '坏倍率回落 1')
  env.api.saveSettings({ petGravity: 'x', petRestitution: null })
  const cfg4 = await env.call('/config')
  assert.deepEqual(cfg4.json.physics, { gravity: 1400, restitution: 0.78 }, '非数字回落默认')
})

test('1.0.14：status() 下发同款字段（面板守卫 pet.physics 等看的就是这份）', async () => {
  const env = startModule()
  const st = env.exports.status()
  assert.deepEqual(st.physics, { gravity: 1400, restitution: 0.78 })
  assert.equal(st.animRate, 1)
  assert.equal(st.balanceEnabled, true)
  assert.equal(st.clickChase, false)
  assert.equal(st.teaseChase, false)
  env.api.saveSettings({ petGravity: 3000, petAnimRate: 2, petShowBalance: false, petClickChase: true, petTeaseChase: true })
  const st2 = env.exports.status()
  assert.deepEqual(st2.physics, { gravity: 3000, restitution: 0.78 })
  assert.equal(st2.animRate, 2)
  assert.equal(st2.balanceEnabled, false)
  assert.equal(st2.clickChase, true)
  assert.equal(st2.teaseChase, true)
})

test('1.0.14：开关布尔口径——balanceEnabled !== false、click/teaseChase === true', async () => {
  const env = startModule()
  // balance：只有明确 false 才关；缺失/任意真值都当开
  env.api.saveSettings({ petShowBalance: false })
  assert.equal((await env.call('/config')).json.balanceEnabled, false, '明确 false 才关')
  env.api.saveSettings({ petShowBalance: true })
  assert.equal((await env.call('/config')).json.balanceEnabled, true)
  // click/tease：只有明确 true 才开；缺失/任意非 true 都当关（高危偏好默认关）
  env.api.saveSettings({ petClickChase: true, petTeaseChase: true })
  const on = await env.call('/config')
  assert.equal(on.json.clickChase, true)
  assert.equal(on.json.teaseChase, true)
  env.api.saveSettings({ petClickChase: 1, petTeaseChase: 'yes' })
  const truthy = await env.call('/config')
  assert.equal(truthy.json.clickChase, false, '非严格 true 不算开（=== true 口径）')
  assert.equal(truthy.json.teaseChase, false)
})

test('1.0.14：/balance 默认诚实降级（ok:false）；注入 petHooks.fetchBalance 时透传结果', async () => {
  // 默认：插件拿不到 DeepSeek key，回 ok:false + 友好文案（绝不造假数据）
  const env = startModule()
  const r = await env.call('/balance')
  assert.equal(r.status, 502)
  assert.equal(r.json.ok, false)
  assert.ok(r.json.message, '带友好文案给客户端气泡')
  // 注入：未来宿主开放 key 通道时，petHooks.fetchBalance 注入实现，路由透传 { ok, balance, currency }
  const env2 = startModule({ hooks: { fetchBalance: async () => ({ ok: true, balance: '10.00', currency: 'CNY' }) } })
  const r2 = await env2.call('/balance')
  assert.equal(r2.status, 200)
  assert.deepEqual(r2.json, { ok: true, balance: '10.00', currency: 'CNY' })
  // 注入抛错也不炸：兜底回 ok:false（key 绝不出现在响应里）
  const env3 = startModule({ hooks: { fetchBalance: async () => { throw new Error('sk-xxx 泄漏尝试') } } })
  const r3 = await env3.call('/balance')
  assert.equal(r3.status, 502)
  assert.equal(r3.json.ok, false)
  assert.ok(!r3.raw.includes('sk-xxx'), '注入抛出的内容绝不透传（防 key 进响应）')
  // 鉴权：坏令牌 401，与其它路由同口径
  const bad = await env.call('/balance', { token: 'deadbeef'.repeat(6) })
  assert.equal(bad.status, 401)
})

// ---------- 渲染页静态自检：index.html 不许有重复声明（1.0.15 真实翻车回归） ----------

test('index.html：animRate / __setAnimRate 各只声明一次（重复声明=SyntaxError 整页挂=桌宠全透明）', () => {
  // 1.0.15 真实事故：`let animRate` 在文件开头与 L285 各写了一遍，渲染页一启动就
  // 抛 "Identifier 'animRate' has already been declared"，整段 <script> 不执行，
  // 窗口/进程/心跳全活着但画面全透明——用户看到的就是「更新后桌宠不显示」。
  // 这里做静态断言把这类「同一标识符声明两遍」挡在打包前。
  const html = readFileSync(join(MODULE_DIR, 'pet-client', 'index.html'), 'utf8')
  const letAnimRate = [...html.matchAll(/^\s*let animRate\b/gm)].length
  assert.equal(letAnimRate, 1, `let animRate 只能声明一次，现在 ${letAnimRate} 次`)
  const setAnimRate = [...html.matchAll(/window\.__setAnimRate\s*=/g)].length
  assert.equal(setAnimRate, 1, `window.__setAnimRate 只能定义一次，现在 ${setAnimRate} 次`)
})


