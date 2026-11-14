// 豆包语音 2.0 模块的离线测试：假 api + 假 fetch，不联网、不连 QQ，数据只写临时目录。
// 跑法：node --test modules/voice/test/voice.test.mjs
// CI 里和其他模块一起跑：AURABOT_PLUGIN_DIR=<插件源码> node --import ./scripts/plugin-env.mjs --test "modules/*/test/*.test.mjs"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.mjs'

const MANIFEST = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8'))
const API_BASE = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const TEST_KEY = 'test-key-000000-not-a-real-secret'

// 流式 WAV：RIFF/data 长度是 0xFFFFFFFF 占位，模块应当回填真实长度
function streamWav(pcmBytes = 480) {
  const b = Buffer.alloc(44 + pcmBytes, 0x55)
  b.write('RIFF', 0); b.writeUInt32LE(0xFFFFFFFF, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(0xFFFFFFFF, 40)
  return b
}

const ndjson = (items) => items.map((x) => JSON.stringify(x)).join('\n')
const audioRes = (body, { ok = true, status = 200, logid = '' } = {}) => ({
  ok, status,
  headers: { get: (k) => (String(k).toLowerCase() === 'x-tt-logid' ? logid : null) },
  text: async () => body,
})
const okAudio = () => audioRes(ndjson([{ code: 0, data: streamWav().toString('base64') }]))

// 全局 fetch 替身：记录请求，响应由每个用例自己定
const calls = []
let handler = async () => okAudio()
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), headers: init?.headers || {}, body: init?.body ? JSON.parse(init.body) : null })
  return handler(url, init)
}

/** 搭一套假 api 并加载模块。所有目录都在临时根目录里。 */
function boot(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'doubao-voice-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  calls.length = 0
  handler = async () => okAudio()

  const settings = {
    apiKey: TEST_KEY, resourceId: 'seed-icl-2.0', speaker: 'S_test_speaker',
    speechRate: 0, contextTexts: '', autoEmotion: true, timeout: 60,
    ...overrides,
  }
  const routes = new Map()
  const disposes = []
  const logs = []
  const fallbackCalls = []
  const converters = []
  let converterCalls = 0
  let songVoiceOpts = null

  const textToSpeech = async (text, opts) => {
    fallbackCalls.push({ text, opts })
    const file = join(root, 'fallback.wav')
    writeFileSync(file, streamWav(160))
    return { file, engine: 'edge' }
  }
  const libs = {
    'voice/tts.js': { textToSpeech, installEdge: async () => ({ ok: true }), edgeInstalled: async () => true, voiceConverters: converters },
    'voice/wav.js': { toMono16k: (buf) => buf },
    'voice/rvc.js': {
      createSongVoice: (opts) => {
        songVoiceOpts = opts
        return async (file) => { converterCalls++; return file }
      },
    },
  }
  const api = {
    dataDir: (sub) => (sub ? join(root, sub) : root),
    settings: () => ({ ...settings }),
    config: () => ({ ownerQQ: '10001', voice: { songVoice: '' } }),
    use: () => undefined,
    dsh: { get: () => undefined },
    log: { info: (...a) => logs.push(['info', a.join(' ')]), warn: (...a) => logs.push(['warn', a.join(' ')]) },
    core: {
      hub: { localTranscribe: async () => '' },
      onebot: { call: async () => ({ messages: [] }) },
      http: { body: async (req) => (req?.body ? JSON.parse(req.body) : {}) },
    },
    lib: (name) => libs[name],
    route: (p, fn) => routes.set(p, fn),
    onDispose: (fn) => disposes.push(fn),
  }
  const iface = plugin.setup(api)
  return { root, settings, routes, disposes, logs, fallbackCalls, converters, iface, state: () => ({ converterCalls, songVoiceOpts }) }
}

const reqWith = (body) => ({ body: JSON.stringify(body) })

// ---------- 入口契约 ----------

test('入口导出与 module.json 一致，setup 返回 speak', () => {
  assert.equal(plugin.id, MANIFEST.id)
  assert.equal(plugin.version, MANIFEST.version)
  assert.equal(plugin.api, MANIFEST.api)
  assert.equal(typeof plugin.setup, 'function')
  assert.equal(MANIFEST.replacesBuiltin, true)
  const keySetting = plugin.settings.find((s) => s.key === 'apiKey')
  assert.equal(keySetting.type, 'password')
})

test('setup 返回 speak / edgeInstalled，注册全部面板路由', (t) => {
  const b = boot(t)
  assert.equal(typeof b.iface.speak, 'function')
  assert.equal(typeof b.iface.edgeInstalled, 'function')
  const need = ['/voice/song-voices', '/voice/test', '/voice/install', '/voice/doubao-status', '/voice/asr-status', '/voice/asr-prepare', '/voice/asr-last', '/voice/asr-test']
  for (const r of need) assert.ok(b.routes.has(r), `缺路由 ${r}`)
})

// ---------- 合成与 WAV 修正 ----------

test('speak 成功：engine=doubao，文件落盘，流式 WAV 头被回填', async (t) => {
  const b = boot(t)
  const r = await b.iface.speak('你好呀')
  assert.equal(r.engine, 'doubao')
  assert.ok(existsSync(r.file))
  const buf = readFileSync(r.file)
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF')
  assert.equal(buf.readUInt32LE(4), buf.length - 8)
  const pos = buf.indexOf(Buffer.from('data'))
  assert.equal(buf.readUInt32LE(pos + 4), buf.length - pos - 8)
})

test('请求形状：Key 只走 X-Api-Key 头，不进请求体', async (t) => {
  const b = boot(t)
  await b.iface.speak('今天天气不错')
  assert.equal(calls.length, 1)
  const c = calls[0]
  assert.equal(c.url, API_BASE)
  assert.equal(c.headers['X-Api-Key'], TEST_KEY)
  assert.equal(c.headers['X-Api-Resource-Id'], 'seed-icl-2.0')
  assert.ok(c.headers['X-Api-Connect-Id'])
  assert.equal(c.body.req_params.text, '今天天气不错')
  assert.equal(c.body.req_params.speaker, 'S_test_speaker')
  assert.deepEqual(c.body.req_params.audio_params, { format: 'wav', sample_rate: 24000, speech_rate: 0 })
  assert.ok(!JSON.stringify(c.body).includes(TEST_KEY))
})

test('NDJSON：多段 data 拼接，坏行跳过，非 WAV 原样保存', async (t) => {
  const b = boot(t)
  const wav = streamWav(480)
  const cut = 260
  handler = async () => audioRes([
    '这不是 JSON',
    JSON.stringify({ code: 0, data: wav.subarray(0, cut).toString('base64') }),
    '',
    JSON.stringify({ code: 0, data: wav.subarray(cut).toString('base64') }),
  ].join('\n'))
  const r = await b.iface.speak('分段返回')
  const buf = readFileSync(r.file)
  assert.equal(buf.length, wav.length)
  assert.equal(buf.readUInt32LE(4), buf.length - 8)

  const mp3ish = Buffer.from('ID3-test-not-wav-payload')
  handler = async () => audioRes(ndjson([{ code: 0, data: mp3ish.toString('base64') }]))
  const r2 = await b.iface.speak('不是 wav')
  assert.deepEqual(readFileSync(r2.file), mp3ish)
})

// ---------- 失败降级 ----------

test('没填 Key：不发请求，退回本机语音', async (t) => {
  const b = boot(t, { apiKey: '' })
  const r = await b.iface.speak('这句走降级')
  assert.equal(calls.length, 0)
  assert.equal(b.fallbackCalls.length, 1)
  assert.equal(b.fallbackCalls[0].opts.engine, 'auto')
  assert.equal(r.engine, 'edge')
  assert.ok(b.logs.some(([lv, msg]) => lv === 'warn' && msg.includes('退回')))
})

test('HTTP 错误：降级并记录状态码和 logid', async (t) => {
  const b = boot(t)
  handler = async () => audioRes('{"message":"bad key"}', { ok: false, status: 401, logid: 'logid-123' })
  const r = await b.iface.speak('鉴权失败')
  assert.equal(r.engine, 'edge')
  assert.equal(b.fallbackCalls.length, 1)
  const st = await b.routes.get('/voice/doubao-status')()
  assert.equal(st.last.ok, false)
  assert.match(st.last.error, /HTTP 401/)
  assert.match(st.last.error, /logid-123/)
})

test('只有错误码没有音频：降级并带上服务端消息', async (t) => {
  const b = boot(t)
  handler = async () => audioRes(ndjson([{ code: 55000000, message: 'speaker 不存在' }]))
  const r = await b.iface.speak('音色不对')
  assert.equal(r.engine, 'edge')
  const st = await b.routes.get('/voice/doubao-status')()
  assert.match(st.last.error, /55000000/)
  assert.match(st.last.error, /speaker 不存在/)
})

test('空文字：直接拒绝', async (t) => {
  const b = boot(t)
  await assert.rejects(b.iface.speak('   '), /空的/)
  assert.equal(calls.length, 0)
})

// ---------- 语气与参数 ----------

test('自动语气：关键词命中追加指令，关掉就不加', async (t) => {
  const b = boot(t)
  await b.iface.speak('哈哈太好了')
  assert.ok(calls[0].body.req_params.context_texts.some((s) => s.includes('开心')))
  b.settings.autoEmotion = false
  await b.iface.speak('哈哈太好了')
  assert.equal(calls[1].body.req_params.context_texts, undefined)
})

test('固定语气指令按行拆分，和自动语气并存', async (t) => {
  const b = boot(t, { contextTexts: '用温柔语气说\n  放慢一点  \n' })
  await b.iface.speak('哈哈太好了')
  const texts = calls[0].body.req_params.context_texts
  assert.ok(texts.includes('用温柔语气说'))
  assert.ok(texts.includes('放慢一点'))
  assert.ok(texts.some((s) => s.includes('开心')))
})

test('语速夹在 -50 到 100', async (t) => {
  const b = boot(t, { speechRate: 500 })
  await b.iface.speak('快一点')
  assert.equal(calls[0].body.req_params.audio_params.speech_rate, 100)
  b.settings.speechRate = -500
  await b.iface.speak('慢一点')
  assert.equal(calls[1].body.req_params.audio_params.speech_rate, -50)
})

// ---------- 面板路由 ----------

test('doubao-status：只报 keySet，不泄露 Key 本体', async (t) => {
  const b = boot(t, { contextTexts: '第一行\n第二行' })
  const st = await b.routes.get('/voice/doubao-status')()
  assert.equal(st.ok, true)
  assert.equal(st.keySet, true)
  assert.equal(st.speaker, 'S_test_speaker')
  assert.deepEqual(st.fixedInstructions, ['第一行', '第二行'])
  assert.ok(!JSON.stringify(st).includes(TEST_KEY))
})

test('/voice/test：返回 base64 音频和引擎', async (t) => {
  const b = boot(t)
  const r = await b.routes.get('/voice/test')(reqWith({ text: '试听一句' }))
  assert.equal(r.ok, true)
  assert.equal(r.engine, 'doubao')
  assert.equal(r.mime, 'audio/wav')
  const buf = Buffer.from(r.data, 'base64')
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF')
})

test('/voice/song-voices：翻唱模块没跑时如实回报', async (t) => {
  const b = boot(t)
  const r = await b.routes.get('/voice/song-voices')()
  assert.equal(r.ok, true)
  assert.equal(r.available, false)
})

test('asr-status：没开语音输入插件时提示开启', async (t) => {
  const b = boot(t)
  const r = await b.routes.get('/voice/asr-status')()
  assert.equal(r.ok, false)
  assert.equal(r.enabled, false)
})

// ---------- 变声接线 ----------

test('翻唱变声器挂进 voiceConverters，dispose 时摘掉', async (t) => {
  const b = boot(t)
  assert.equal(b.converters.length, 1)
  assert.ok(b.state().songVoiceOpts)
  await b.iface.speak('带变声的一句')
  assert.equal(b.state().converterCalls, 1)
  for (const fn of b.disposes) fn()
  assert.equal(b.converters.length, 0)
})