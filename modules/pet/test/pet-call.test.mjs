// 桌宠「语音对讲」（1.2.0）服务端测试（mods-fork/modules/pet/index.mjs）
//   推倒重做：旧的「打电话」产品形态已删（5 条 /client/call/* 路由、状态机、挂断写记忆、emit('call')），
//   底层引擎（ASR / TTS 三档 / RVC / memory hint / think prompt）保留复用成单轮语音对讲。
// 覆盖：
//   1. POST /voice/talk 一轮闭环 → heard/replyText/audioB64/engine 正确（fake 钩子，不打真网络、不真采音）
//   2. 字段名兼容：只发 {audioB64} 也能读（兜底），且 audio 优先
//   3. 错误结构：无 audio → ok:false error:'no-audio'；ASR 失败 → error:'asr-failed' + message 人话
//   4. GET /voice/talk/config → talkMode:'toggle'、hotkey 默认 Alt+Space、asrReady 布尔 + asrReason
//   5. emit('voiceTalk') 状态序列 listening→thinking→speaking→idle（经 /events 长轮询捕获）
//   6. status().voiceTalk 字段从 settings 读
// 全程 AURABOT_DATA_DIR 隔离，fake api 照 pet.test.mjs 的 makeApi 面（memory 补 recall），
// 用 petHooks 注入 callAsr/callTts/callRvc/asrProbe，不打真网络、不真采音。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
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
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-pet-voicetalk-'))
})

// ---------- 假模块环境（对齐 pet.test.mjs / src/core/modules.js 的 makeApi 面） ----------

function startModule({ settings = {}, hooks = {} } = {}) {
  const s = { carrier: 'pet', modality: 'text', petFallbackToQQ: true, ...settings }
  const routes = new Map()
  const api = {
    id: 'pet',
    dir: MODULE_DIR,
    version: 'test',
    __petTestHooks: hooks, // 注入 callAsr / callTts / callRvc / asrProbe：不打真网络
    log: { info() {}, warn() {}, debug() {}, error() {} },
    dataDir: (...parts) => {
      const d = join(process.env.AURABOT_DATA_DIR, 'modules-data', 'pet')
      mkdirSync(d, { recursive: true })
      return join(d, ...parts)
    },
    config: () => ({ ownerQQ: OWNER, ownerName: '主人' }),
    settings: () => ({ ...s }),
    saveSettings: (patch) => { Object.assign(s, patch); return { ...s } },
    route: (path, handler) => { routes.set(path, handler) },
    every: () => () => {},
    onDispose: () => {},
    lib: (p) => {
      if (p !== 'voice/tts.js') throw new Error('测试不该走真 lib(): ' + p)
      const file = api.dataDir('fake-tts', 'out.wav')
      mkdirSync(join(file, '..'), { recursive: true })
      return { textToSpeech: async (t) => { writeFileSync(file, Buffer.from('tts:' + t)); return { file, engine: 'edge' } } }
    },
    dsh: { get: () => null }, // 默认没有 DSH 语音输入 provider；靠 hooks.asrProbe 让探活通过
    core: {
      http: {
        send: (res, code, body) => { res.statusCode = code; res.end(JSON.stringify(body)) },
        query: (req) => { try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams) } catch { return {} } },
        body: async (req) => req.__json ?? {},
      },
    },
  }
  let moodValue = 75
  let memItems = []
  let recallHits = []
  let thinkReply = ''
  let thinkThrow = null
  const thinkCalls = []
  api.has = (id) => (id === 'mood') || (id === 'memory' && memItems.length >= 0)
  api.use = (id) => (id === 'mood' ? { current: () => moodValue }
    : id === 'memory' ? {
        list: (q) => (q ? memItems.filter((m) => String(m.text).includes(q)) : memItems.slice()),
        add: (o) => { return { id: 'm-fake' } },
        recall: async () => recallHits,
        recallHint: () => '',
      }
      : null)
  api.think = async (prompt, opts = {}) => {
    thinkCalls.push({ prompt, title: opts.title, noTools: opts.noTools, key: opts.key, timeoutMs: opts.timeoutMs })
    if (thinkThrow) throw new Error(thinkThrow)
    return thinkReply
  }
  const exports = mod.setup(api) ?? {}
  const token = readFileSync(api.dataDir('host-token'), 'utf8').trim()

  function req(path, { method = 'GET', json, token: tk = token } = {}) {
    return {
      method,
      url: path,
      headers: { host: '127.0.0.1:53210', ...(tk ? { 'x-pet-token': tk } : {}), ...(json ? { 'content-type': 'application/json' } : {}) },
      __json: json,
    }
  }
  async function call(path, opts = {}) {
    const handler = routes.get(path.split('?')[0])
    if (!handler) return { status: 404, json: { ok: false, message: 'no route ' + path } }
    const res = { statusCode: 200, headers: {}, raw: null, setHeader() {}, end(b) { this.raw = b } }
    await handler(req(path, opts), res)
    let body = res.raw
    try { body = JSON.parse(res.raw) } catch {}
    return { status: res.statusCode, json: body }
  }
  return {
    api, exports, call, token, thinkCalls,
    setThinkReply: (t) => { thinkReply = t },
    throwThink: (e) => { thinkThrow = e },
    setRecall: (hits) => { recallHits = hits },
  }
}

// 一段够长的「录音」（>1600 字节）
const fakeWav = Buffer.alloc(4096, 7).toString('base64')
const fakeAsr = async () => '今晚一起去吃火锅吧'
const fakeTts = (text) => ({ bytes: Buffer.from('tts:' + text), mime: 'audio/wav', engine: 'fake' })
const asrReady = () => ({ ready: true, reason: '' })

// ---------- 1. settings 面板：call* 键保留复用，删 PTT/VAD，新增 voiceHotkey ----------

test('语音对讲 settings：call* 键保留、voiceHotkey 新增、callPttKey/callVadSilence 已删', () => {
  const kept = ['callEngine', 'sovitsUrl', 'callRvc', 'callRvcVoice', 'callTalkMode', 'callMaxChars', 'callAsrUrl', 'callMicDeviceId', 'callSpeakerDeviceId', 'voiceHotkey']
  for (const k of kept) {
    const row = mod.settings.find((x) => x.key === k)
    assert.ok(row, `settings 面板缺 ${k}`)
    assert.ok(row.label, `${k} 要有中文 label`)
  }
  for (const k of ['callPttKey', 'callVadSilence']) {
    assert.equal(mod.settings.find((x) => x.key === k), undefined, `${k} 应当已从面板删除`)
    assert.equal(mod.defaults[k], undefined, `${k} 应当已从默认值删除`)
  }
  const d = mod.defaults
  assert.equal(d.callEngine, 'native')
  assert.equal(d.sovitsUrl, 'http://127.0.0.1:9880')
  assert.equal(d.callRvc, false)
  assert.equal(d.callRvcVoice, '')
  assert.equal(d.callTalkMode, 'toggle')
  assert.equal(d.voiceHotkey, 'Alt+Space')
  assert.equal(d.callMaxChars, 120)
  assert.equal(d.callAsrUrl, 'http://127.0.0.1:8000')
  assert.equal(d.callMicDeviceId, '')
  assert.equal(d.callSpeakerDeviceId, '')
  assert.equal(mod.version, '1.1.0')
})

// ---------- 2. 一轮闭环：POST /voice/talk ----------

test('一轮闭环：POST {audio} 走 fake ASR/think/TTS → heard/replyText/audioB64/engine 正确', async () => {
  const env = startModule({ hooks: { asrProbe: asrReady, callAsr: fakeAsr, callTts: fakeTts } })
  env.setThinkReply('好呀，想吃辣一点的！')
  env.setRecall([{ text: '上次也是他约的火锅' }])

  const r = await env.call('/voice/talk', { method: 'POST', json: { audio: fakeWav } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.heard, '今晚一起去吃火锅吧', 'heard 来自 fake ASR')
  assert.equal(r.json.replyText, '好呀，想吃辣一点的！', '回复来自 think')
  assert.ok(r.json.audioB64.length > 0, 'audioB64 非空')
  assert.equal(Buffer.from(r.json.audioB64, 'base64').toString(), 'tts:好呀，想吃辣一点的！', 'TTS 产物就是 fake 合成的那段')
  assert.equal(r.json.mime, 'audio/wav')
  assert.equal(r.json.engine, 'fake', 'engine 字段来自 fake TTS 的自报')
  assert.ok(r.json.ms && typeof r.json.ms.total === 'number')

  // think prompt：key=voiceTalk、title=语音对讲、场景行 + 旧事提示 + 桌宠状态 + 口语约束
  const t = env.thinkCalls.find((x) => x.key === 'voiceTalk')
  assert.ok(t, 'think 用 key:voiceTalk')
  assert.equal(t.title, '语音对讲')
  assert.equal(t.noTools, true)
  assert.ok(t.prompt.includes('语音对讲'), '场景行在 prompt 里')
  assert.ok(t.prompt.includes('【想起的旧事】'), '旧事提示进 prompt')
  assert.ok(t.prompt.includes('【你此刻的状态】'), '桌宠当下状态进 prompt')
  assert.ok(t.prompt.includes('他刚说：「今晚一起去吃火锅吧」'))
  assert.ok(t.prompt.includes('最多 120 字'), '限 callMaxChars 字')
  assert.ok(t.prompt.includes('不要 Markdown') && t.prompt.includes('不要 emoji'), '禁 Markdown/emoji/旁白')
})

test('字段名兼容：只发 {audioB64} 也能读（兜底），且 audio 优先于 audioB64', async () => {
  const env = startModule({ hooks: { asrProbe: asrReady, callAsr: fakeAsr, callTts: fakeTts } })
  env.setThinkReply('收到')
  // 只有 audioB64：兜底也要能读
  const fallback = await env.call('/voice/talk', { method: 'POST', json: { audioB64: fakeWav } })
  assert.equal(fallback.json.ok, true, 'audioB64 兜底可读')
  // 两个字段都在：audio 优先（用不同内容标记，靠注入的 callAsr 记录拿到的是哪段）
  let heardBuf = null
  env.api.__petTestHooks.callAsr = async (buf) => { heardBuf = buf; return '听清了' }
  const both = await env.call('/voice/talk', {
    method: 'POST',
    json: { audio: Buffer.from('this-is-audio').toString('base64').padEnd(0), audioB64: fakeWav },
  })
  assert.equal(both.json.ok, true)
  assert.equal(Buffer.from(heardBuf || '').toString(), 'this-is-audio', 'audio 字段优先，audioB64 被忽略')
})

// ---------- 3. 错误结构 ----------

test('错误结构：无 audio → ok:false error:no-audio；ASR 失败 → asr-failed + 人话 message', async () => {
  const env = startModule({ hooks: { asrProbe: asrReady, callTts: fakeTts } })
  // 无 audio
  const noAudio = await env.call('/voice/talk', { method: 'POST', json: {} })
  assert.equal(noAudio.json.ok, false)
  assert.equal(noAudio.json.error, 'no-audio')
  assert.ok(noAudio.json.message && noAudio.json.message.length > 0, 'message 是人话')

  // ASR 抛错 → asr-failed + 人话 message
  const env2 = startModule({ hooks: { asrProbe: asrReady, callAsr: async () => { throw new Error('识别服务 500') }, callTts: fakeTts } })
  const failed = await env2.call('/voice/talk', { method: 'POST', json: { audio: fakeWav } })
  assert.equal(failed.json.ok, false)
  assert.equal(failed.json.error, 'asr-failed')
  assert.ok(String(failed.json.message).includes('没听清'), 'message 是人话')

  // ASR 未就绪 → asr-not-ready + 人话原因
  const env3 = startModule({ hooks: { asrProbe: () => ({ ready: false, reason: '本地识别 127.0.0.1:8000 连不上，请在面板配 faster-whisper 或开 DSH 语音输入' }) } })
  const notReady = await env3.call('/voice/talk', { method: 'POST', json: { audio: fakeWav } })
  assert.equal(notReady.json.error, 'asr-not-ready')
  assert.ok(String(notReady.json.message).includes('连不上'))
})

// ---------- 4. GET /voice/talk/config ----------

test('/voice/talk/config：talkMode toggle、hotkey 默认 Alt+Space、asrReady 布尔 + asrReason', async () => {
  const env = startModule({ hooks: { asrProbe: asrReady } })
  const c = await env.call('/voice/talk/config')
  assert.equal(c.status, 200)
  assert.equal(c.json.ok, true)
  assert.equal(c.json.talkMode, 'toggle')
  assert.equal(c.json.engine, 'native')
  assert.equal(c.json.rvc, false)
  assert.equal(c.json.hotkey, 'Alt+Space', 'hotkey 默认 Alt+Space')
  assert.equal(typeof c.json.asrReady, 'boolean')
  assert.equal(c.json.asrReady, true)
  assert.equal(typeof c.json.asrReason, 'string')
  // guard 口径不变：坏令牌 / 缺令牌 401
  assert.equal((await env.call('/voice/talk/config', { token: 'deadbeef' })).status, 401)
  assert.equal((await env.call('/voice/talk/config', { token: '' })).status, 401)

  // 未就绪时 asrReady:false + 人话原因
  const env2 = startModule({ hooks: { asrProbe: () => ({ ready: false, reason: '本地识别连不上，请在面板配 faster-whisper 或开 DSH 语音输入' }) } })
  const c2 = await env2.call('/voice/talk/config')
  assert.equal(c2.json.asrReady, false)
  assert.ok(String(c2.json.asrReason).includes('连不上'))
  // 自定义热键也透出
  const env3 = startModule({ settings: { voiceHotkey: 'Ctrl+K' }, hooks: { asrProbe: asrReady } })
  assert.equal((await env3.call('/voice/talk/config')).json.hotkey, 'Ctrl+K')
})

// ---------- 5. emit('voiceTalk') 状态序列（经 /events 捕获） ----------

test('emit(voiceTalk) 状态序列：listening→thinking→speaking→idle', async () => {
  const env = startModule({ hooks: { asrProbe: asrReady, callAsr: fakeAsr, callTts: fakeTts } })
  env.setThinkReply('好嘞')
  // 先对齐水位拿 cursor
  const base = await env.call('/events?client=t1')
  const cursor = base.json.cursor
  // 跑一轮
  const r = await env.call('/voice/talk', { method: 'POST', json: { audio: fakeWav } })
  assert.equal(r.json.ok, true)
  // 拉新事件（wait=0 立即返回）
  const after = await env.call(`/events?client=t1&since=${cursor}&wait=0`)
  const states = after.json.events.filter((e) => e.type === 'voiceTalk').map((e) => e.state)
  assert.deepEqual(states, ['listening', 'thinking', 'speaking', 'idle'], '状态序列完整且顺序正确')
})

// ---------- 6. status().voiceTalk 字段从 settings 读 ----------

test('status().voiceTalk 字段从 settings 读（保留 call 兼容）', async () => {
  const env = startModule({
    settings: { callEngine: 'sovits', callRvc: true, callRvcVoice: '小鱼', voiceHotkey: 'Ctrl+Shift+M', callMaxChars: 60, callMicDeviceId: 'mic-9', callSpeakerDeviceId: 'spk-9' },
    hooks: { asrProbe: asrReady },
  })
  const st = env.exports.status()
  assert.ok(st.voiceTalk, 'status 有 voiceTalk 字段')
  assert.equal(st.voiceTalk.engine, 'sovits')
  assert.equal(st.voiceTalk.rvc, true)
  assert.equal(st.voiceTalk.rvcVoice, '小鱼')
  assert.equal(st.voiceTalk.talkMode, 'toggle')
  assert.equal(st.voiceTalk.hotkey, 'Ctrl+Shift+M')
  assert.equal(st.voiceTalk.maxChars, 60)
  assert.equal(st.voiceTalk.micDeviceId, 'mic-9')
  assert.equal(st.voiceTalk.speakerDeviceId, 'spk-9')
  assert.ok(st.call, 'call 字段保留兼容')
  // /status 路由同口径
  const route = await env.call('/status')
  assert.equal(route.json.voiceTalk.hotkey, 'Ctrl+Shift+M')
  assert.equal(route.json.voiceTalk.talkMode, 'toggle')
})

// ---------- 7. 删除确认：旧通话路由不再注册 ----------

test('旧通话路由已删除：/client/call/* 均 404，/voice/talk/config 存在', async () => {
  const env = startModule({ hooks: { asrProbe: asrReady } })
  for (const p of ['/client/call/start', '/client/call/audio', '/client/call/interrupt', '/client/call/stop', '/client/call/state']) {
    assert.equal((await env.call(p)).status, 404, `${p} 应已删除`)
  }
  assert.equal((await env.call('/voice/talk/config')).status, 200)
  assert.equal((await env.call('/voice/talk/nope')).status, 404, '子路径没注册就是 404')
})
