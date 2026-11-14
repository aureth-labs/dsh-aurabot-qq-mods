// 语音适配层：耳朵（STT）和嘴巴（TTS）都可以换成本地服务或任意线上平台。
// 目标：别人把这个模块装在自己的 Aurabot 上，不用改一行代码，只在设置里填地址/密钥/模型。
//
// 耳朵（asrProvider）：
//   local   本地 faster-whisper（默认，http://127.0.0.1:8000）
//   openai  任意 OpenAI 兼容的 /audio/transcriptions（OpenAI、Groq、硅基流动、火山方舟、通义 compatible-mode…）
//   http    完全自定义：URL + 请求头 + 表单字段 + 从返回 JSON 里取文本的路径（腾讯云、讯飞、自建都能接）
//
// 嘴巴（ttsProvider）：
//   follow      跟随插件「语音」页里配的引擎（默认，老用户行为完全不变）
//   gptsovits   本地 GPT-SoVITS（流式，首包最快）
//   cosyvoice   本地 CosyVoice
//   edge        微软 edge-tts（线上、免费、不烧积分）
//   openai      任意 OpenAI 兼容的 /audio/speech（OpenAI、硅基流动、火山、MiniMax 兼容层…），可流式
//   http        完全自定义模板（ElevenLabs、腾讯云、讯飞、自建都能接）
//   windows     Windows 自带语音（最后的兜底，离线）
//
// 所有 provider 都统一成两个动作：probe（能不能用）+ 产出音频流（AsyncIterator<Buffer>）。

import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'

const TIMEOUT_STT = 60000
const TIMEOUT_TTS = 180000

const trimSlash = (s) => String(s || '').trim().replace(/\/+$/, '')

function safeJson(text, fallback = null) {
  const raw = String(text || '').trim()
  if (!raw) return fallback
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error('这段 JSON 没解析成功：' + (error.message || error))
  }
}

function headerObj(text) {
  const obj = safeJson(text, {}) || {}
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[String(k)] = String(v)
  return out
}

/** 按 "data.text" / "result[0].text" 这种路径取值 */
export function pickPath(obj, path) {
  if (!path) return undefined
  let cur = obj
  for (const seg of String(path).replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (seg === '') continue
    if (cur === null || cur === undefined) return undefined
    cur = Array.isArray(cur) && /^\d+$/.test(seg) ? cur[Number(seg)] : cur[seg]
  }
  return cur
}

function multipart(fields, audioField, filename, buf, mime = 'audio/wav') {
  const boundary = '----voicecall-' + Math.random().toString(16).slice(2, 10)
  const chunks = []
  const push = (s) => chunks.push(Buffer.from(s, 'utf8'))
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null || v === '') continue
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${text}\r\n`)
  }
  if (audioField) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${audioField}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`)
    chunks.push(buf)
    push('\r\n')
  }
  push(`--${boundary}--\r\n`)
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** 支持 r 模式，把 {text} 换成转义后的文本、{text_raw} 换成原文、{audio_b64} 换成 base64 */
function fillTemplate(raw, vars) {
  let out = String(raw || '')
  for (const [k, v] of Object.entries(vars)) {
    if (k === 'text_raw' || k === 'audio_b64') out = out.split('{' + k + '}').join(String(v))
    else out = out.split('{' + k + '}').join(JSON.stringify(String(v)).slice(1, -1))
  }
  return out
}

function wavHeader(sampleRate = 24000, channels = 1, bits = 16, dataBytes = 0xffffffff) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(dataBytes === 0xffffffff ? 0xffffffff : 36 + dataBytes, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(channels, 22)
  head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(Math.round((sampleRate * channels * bits) / 8), 28)
  head.writeUInt16LE(Math.round((channels * bits) / 8), 32)
  head.writeUInt16LE(bits, 34)
  head.write('data', 36)
  head.writeUInt32LE(dataBytes, 40)
  return head
}

/** base 可能是 …/v1、…/v1/ 或者已经是完整端点 */
function endpoint(base, tail) {
  const b = trimSlash(base)
  if (!b) return ''
  if (b.toLowerCase().endsWith(tail.toLowerCase())) return b
  if (/\/v1$/i.test(b)) return b + tail
  return b + '/v1' + tail
}

// ============================ 耳朵 ============================

export const STT_LABEL = {
  local: '本地 faster-whisper',
  openai: 'OpenAI 兼容转写',
  http: '自定义 HTTP 转写',
}

export const STT_IDS = Object.keys(STT_LABEL)

export function asrConfig(settings = {}) {
  const provider = String(settings.asrProvider || 'local').trim() || 'local'
  const tpl = safeJson(settings.asrTemplate, null)
  return {
    provider: STT_IDS.includes(provider) ? provider : 'local',
    url: String(settings.asrUrl || '').trim(),
    key: String(settings.asrKey || '').trim(),
    model: String(settings.asrModel || '').trim(),
    lang: String(settings.asrLang || 'zh').trim(),
    prompt: String(settings.asrPrompt || '').trim(),
    extra: safeJson(settings.asrExtra, null) || {},
    template: tpl,
  }
}

const asrBase = (cfg) => trimSlash(cfg.url) || 'http://127.0.0.1:8000'

export async function probeStt(cfg) {
  const label = STT_LABEL[cfg.provider] || cfg.provider
  if (cfg.provider === 'local') {
    try {
      const r = await fetch(`${asrBase(cfg)}/health`, { signal: AbortSignal.timeout(3000) })
      const j = await r.json()
      if (!j.ok) return { ready: false, why: '识别服务在，但模型没就绪', provider: label }
      return { ready: true, why: 'ready', provider: `${label} ${j.model || cfg.model || 'small'}（${j.device || 'cpu'}）` }
    } catch (error) {
      return { ready: false, why: '本地识别服务没启动（windows 上是 AurabotASR.vbs）', provider: label }
    }
  }
  if (cfg.provider === 'openai') {
    if (!cfg.url) return { ready: false, why: '没填转写接口地址', provider: label }
    if (!cfg.key) return { ready: false, why: '没填 API Key', provider: label }
    return { ready: true, why: '没检测（按需直连）', provider: `${label} ${cfg.model || 'whisper-1'}` }
  }
  if (cfg.provider === 'http') {
    if (!cfg.template || !cfg.template.url) return { ready: false, why: '自定义模板里没填 url', provider: label }
    return { ready: true, why: '没检测（按需直连）', provider: label }
  }
  return { ready: false, why: '不认识的识别引擎：' + cfg.provider, provider: label }
}

async function sttLocal(cfg, wav) {
  const fields = { language: cfg.lang || 'zh', response_format: 'json', ...cfg.extra }
  if (cfg.model) fields.model = cfg.model
  const { body, contentType } = multipart(fields, 'file', 'speech.wav', wav)
  const r = await fetch(`${asrBase(cfg)}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
    signal: AbortSignal.timeout(TIMEOUT_STT),
  })
  if (!r.ok) throw new Error(`本地识别返回 ${r.status}：${(await r.text().catch(() => '')).slice(0, 120)}`)
  const j = await r.json()
  return String(j.text || '').trim()
}

async function sttOpenAI(cfg, wav) {
  const url = endpoint(cfg.url, '/audio/transcriptions')
  const fields = { model: cfg.model || 'whisper-1', response_format: 'json', ...cfg.extra }
  if (cfg.lang) fields.language = cfg.lang
  if (cfg.prompt) fields.prompt = cfg.prompt
  const { body, contentType } = multipart(fields, 'file', 'speech.wav', wav)
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': contentType },
    body,
    signal: AbortSignal.timeout(TIMEOUT_STT),
  })
  if (!r.ok) throw new Error(`转写接口返回 ${r.status}：${(await r.text().catch(() => '')).slice(0, 160)}`)
  const ctype = String(r.headers.get('content-type') || '')
  if (!ctype.includes('json')) return String(await r.text()).trim()
  const j = await r.json()
  return String(j.text || j.transcription || '').trim()
}

async function sttHttp(cfg, wav) {
  const tpl = cfg.template || {}
  if (!tpl.url) throw new Error('自定义模板里没填 url')
  const method = String(tpl.method || 'POST').toUpperCase()
  const headers = { ...headerObj(JSON.stringify(tpl.headers || {})) }
  const mode = String(tpl.mode || 'multipart')
  const audioField = String(tpl.audioField || 'file')
  const b64 = wav.toString('base64')
  let body = null

  if (mode === 'base64') {
    // 整段音频塞进 JSON：很多国内平台（讯飞、火山）要这么传
    const raw = String(tpl.body || '{"audio":"{audio_b64}"}')
    body = Buffer.from(fillTemplate(raw, { audio_b64: b64, reqid: randomUUID() }), 'utf8')
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
  } else if (mode === 'raw') {
    body = wav
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'audio/wav'
  } else {
    const fields = { ...cfg.extra, ...(tpl.fields || {}) }
    const parts = multipart(fields, audioField, String(tpl.filename || 'speech.wav'), wav)
    body = parts.body
    headers['Content-Type'] = parts.contentType
  }

  const r = await fetch(tpl.url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_STT) })
  const raw = Buffer.from(await r.arrayBuffer())
  if (!r.ok) throw new Error(`转写接口返回 ${r.status}：${raw.toString('utf8').slice(0, 160)}`)
  const ctype = String(r.headers.get('content-type') || '')
  if (!ctype.includes('json') && raw[0] !== 0x7b) return raw.toString('utf8').trim()
  let j = null
  try {
    j = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    throw new Error('返回的不是合法 JSON：' + raw.toString('utf8').slice(0, 160))
  }
  const text = pickPath(j, tpl.textPath || 'text')
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('没从返回里找到文本，检查「取文本的路径」：' + JSON.stringify(j).slice(0, 200))
  }
  return text.trim()
}

/** 把一段 WAV 变成文字。失败抛错，调用方决定怎么提示。 */
export async function transcribe(cfg, wav) {
  const t0 = Date.now()
  const runner = { local: sttLocal, openai: sttOpenAI, http: sttHttp }[cfg.provider]
  if (!runner) throw new Error('不认识的识别引擎：' + cfg.provider)
  const text = await runner(cfg, wav)
  return { text, provider: STT_LABEL[cfg.provider] || cfg.provider, ms: Date.now() - t0 }
}

// ============================ 嘴巴 ============================

export const TTS_LABEL = {
  follow: '跟随「语音」页设置',
  gptsovits: '本地 GPT-SoVITS',
  cosyvoice: '本地 CosyVoice',
  edge: '微软 edge-tts（线上）',
  openai: 'OpenAI 兼容语音',
  http: '自定义 HTTP 语音',
  windows: 'Windows 自带语音',
}

export const TTS_IDS = Object.keys(TTS_LABEL)

/** 把全局 voice 配置的 engine 映射成本层的 provider */
function fromGlobalEngine(voice = {}) {
  const engine = String(voice.engine || '').trim()
  if (engine === 'gptsovits' || engine === 'cosyvoice' || engine === 'http') return engine
  if (engine === 'windows') return 'windows'
  return 'edge'
}

export function ttsConfig(settings = {}, globalVoice = {}) {
  const picked = String(settings.ttsProvider || 'follow').trim() || 'follow'
  const provider = picked === 'follow' ? fromGlobalEngine(globalVoice) : picked
  const g = globalVoice.gptsovits || {}
  const c = globalVoice.cosyvoice || {}
  return {
    provider: TTS_IDS.includes(provider) ? provider : 'edge',
    follow: picked === 'follow',
    url: String(settings.ttsUrl || '').trim(),
    key: String(settings.ttsKey || '').trim(),
    model: String(settings.ttsModel || '').trim(),
    voice: String(settings.ttsVoice || '').trim() || String(globalVoice.voice || '').trim(),
    format: String(settings.ttsFormat || '').trim() || 'pcm',
    speed: String(settings.ttsSpeed || '').trim(),
    sampleRate: Number(settings.ttsSampleRate) || 24000,
    template: safeJson(settings.ttsTemplate, null),
    global: globalVoice,
    gptsovits: {
      url: String(settings.ttsUrl || '').trim() || String(g.url || '').trim(),
      refAudio: String(g.refAudio || '').trim(),
      promptText: String(g.promptText || '').trim(),
      promptLang: String(g.promptLang || 'zh'),
      textLang: String(g.textLang || 'zh'),
    },
    cosyvoice: c,
    // follow 且全局是 edge/http 时，把全局的参数沿用过来，避免填两遍；
    // settings.voice / settings.rate 是老版本留的键，继续认，老配置不用改
    edgeVoice: String(settings.ttsVoice || settings.voice || '').trim() || String(globalVoice.voice || 'zh-CN-XiaoyiNeural'),
    edgeRate: String(settings.ttsSpeed || settings.rate || '').trim() || String(globalVoice.rate || ''),
    edgePitch: String(globalVoice.pitch || ''),
  }
}

/** 本地服务有没有起来：只看端口通不通。
 *  不用 HTTP 探活——GPT-SoVITS 的根路径不应答，会把「在跑」误判成「连不上」。 */
function tcpAlive(base) {
  return new Promise((resolve) => {
    let url = null
    try {
      url = new URL(trimSlash(base))
    } catch (error) {
      return resolve(false)
    }
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    const sock = connect({ host: url.hostname, port })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch (error) { /* ignore */ }
      resolve(ok)
    }
    sock.setTimeout(1500)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

export async function probeTts(cfg, ctx = {}) {
  const label = TTS_LABEL[cfg.provider] || cfg.provider
  if (cfg.provider === 'gptsovits') {
    if (!cfg.gptsovits.url) return { ready: false, why: '没填 GPT-SoVITS 地址', provider: label }
    if (!cfg.gptsovits.refAudio) return { ready: false, why: '没配参考音（「语音」页里填）', provider: label }
    const ok = await tcpAlive(cfg.gptsovits.url)
    return { ready: ok, why: ok ? 'ready（流式）' : '连不上本地合成服务', provider: label }
  }
  if (cfg.provider === 'cosyvoice') {
    const ok = await tcpAlive(cfg.cosyvoice.url || cfg.url || 'http://127.0.0.1:50000')
    return { ready: ok, why: ok ? 'ready' : '连不上本地 CosyVoice', provider: label }
  }
  if (cfg.provider === 'openai') {
    if (!cfg.url) return { ready: false, why: '没填语音接口地址', provider: label }
    if (!cfg.key) return { ready: false, why: '没填 API Key', provider: label }
    return { ready: true, why: '没检测（按需直连）', provider: `${label} ${cfg.model || 'tts-1'}` }
  }
  if (cfg.provider === 'http') {
    if (!cfg.template || !cfg.template.url) return { ready: false, why: '自定义模板里没填 url', provider: label }
    return { ready: true, why: '没检测（按需直连）', provider: label }
  }
  if (cfg.provider === 'edge') {
    const installed = ctx.builtin?.edgeInstalled?.()
    return { ready: installed !== false, why: installed === false ? 'edge-tts 没装（「语音」页可一键装）' : 'ready', provider: label }
  }
  if (cfg.provider === 'windows') {
    return { ready: process.platform === 'win32', why: process.platform === 'win32' ? 'ready' : '只在 Windows 上有', provider: label }
  }
  return { ready: false, why: '不认识的合成引擎：' + cfg.provider, provider: label }
}

const CONTENT_TYPE = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', pcm: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' }

async function* fromWebStream(body) {
  const reader = body.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value && value.length) yield Buffer.from(value)
    }
  } finally {
    try {
      await reader.cancel()
    } catch (error) {
      /* 断开就算了 */
    }
  }
}

/** GPT-SoVITS 的流式接口：0.5–1 秒就能出第一块，这是目前首句最快的路 */
async function openGptSovits(cfg, text) {
  const g = cfg.gptsovits
  if (!g.url) throw new Error('没填 GPT-SoVITS 地址')
  const params = new URLSearchParams({
    text,
    text_lang: g.textLang || 'zh',
    ref_audio_path: g.refAudio || '',
    prompt_text: g.promptText || '',
    prompt_lang: g.promptLang || 'zh',
    media_type: 'wav',
    streaming_mode: 'true',
  })
  if (cfg.speed) params.set('speed_factor', cfg.speed)
  const up = await fetch(`${trimSlash(g.url)}/tts?${params}`, { signal: AbortSignal.timeout(TIMEOUT_TTS) })
  if (!up.ok || !up.body) throw new Error(`GPT-SoVITS 返回 ${up.status}：${(await up.text().catch(() => '')).slice(0, 120)}`)
  return { contentType: 'audio/wav', iter: fromWebStream(up.body) }
}

/** OpenAI 兼容的 /audio/speech。要 pcm 就能边生成边播，要 mp3 就整段回来 */
async function openOpenAI(cfg, text) {
  const url = endpoint(cfg.url, '/audio/speech')
  const format = (cfg.format || 'pcm').toLowerCase()
  const payload = {
    model: cfg.model || 'tts-1',
    input: text,
    voice: cfg.voice || 'alloy',
    response_format: format,
  }
  if (cfg.speed) {
    const sp = Number(String(cfg.speed).replace(/[^0-9.]/g, ''))
    if (sp > 0.2 && sp < 5) payload.speed = sp
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_TTS),
  })
  if (!r.ok || !r.body) throw new Error(`语音接口返回 ${r.status}：${(await r.text().catch(() => '')).slice(0, 160)}`)
  const sampleRate = cfg.sampleRate || 24000
  if (format === 'pcm' || format === 'wav-raw') {
    // PCM 流前面补一个长度未知的 WAV 头，浏览器就能边下边播（Chrome 认 0xFFFFFFFF）
    return {
      contentType: 'audio/wav',
      iter: (async function* () {
        yield wavHeader(sampleRate, 1, 16)
        yield* fromWebStream(r.body)
      })(),
    }
  }
  return { contentType: CONTENT_TYPE[format] || 'audio/mpeg', iter: fromWebStream(r.body) }
}

/** 完全自定义的 HTTP 语音：拿二进制或者 JSON 里的 base64 都行 */
async function openHttp(cfg, text) {
  const tpl = cfg.template || {}
  if (!tpl.url) throw new Error('自定义模板里没填 url')
  const method = String(tpl.method || 'POST').toUpperCase()
  const headers = headerObj(JSON.stringify(tpl.headers || {}))
  let target = tpl.url
  let body
  if (method === 'GET' || method === 'HEAD') {
    if (!target.includes('{text}')) throw new Error('GET 方式的地址里要有 {text}')
    target = target.split('{text}').join(encodeURIComponent(text))
  } else {
    const raw = String(tpl.body || '{"text":"{text}"}')
    body = fillTemplate(raw, { text, reqid: randomUUID() })
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
  }
  const r = await fetch(target, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_TTS) })
  if (!r.ok) throw new Error(`语音接口返回 ${r.status}：${(await r.text().catch(() => '')).slice(0, 160)}`)
  const ctype = String(r.headers.get('content-type') || '')
  let buf = Buffer.from(await r.arrayBuffer())
  const looksJson = ctype.includes('json') || buf[0] === 0x7b
  if (looksJson) {
    let j = null
    try {
      j = JSON.parse(buf.toString('utf8'))
    } catch (error) {
      throw new Error('返回的不是合法 JSON：' + buf.toString('utf8').slice(0, 160))
    }
    const path = tpl.audioPath || 'data.audio'
    const found = pickPath(j, path) || pickPath(j, 'audio') || pickPath(j, 'data')
    if (typeof found !== 'string' || found.length < 40) {
      throw new Error(`没从返回里找到音频（试过 ${path}），检查「取音频的路径」：` + JSON.stringify(j).slice(0, 200))
    }
    buf = Buffer.from(found.replace(/^data:[^,]+,/, ''), 'base64')
  }
  if (buf.length < 400) throw new Error('返回的音频太短（' + buf.length + ' 字节），可能失败了')
  const declared = String(tpl.format || '').toLowerCase()
  const sniff = buf.toString('ascii', 0, 4)
  const fmt = declared || (sniff === 'RIFF' ? 'wav' : sniff === 'ID3' || buf[0] === 0xff ? 'mp3' : 'mp3')
  return { contentType: CONTENT_TYPE[fmt] || 'audio/mpeg', iter: (async function* () { yield buf })() }
}

/** 插件自带的合成（edge / cosyvoice / windows）：整段回，再切块吐 */
async function openBuiltin(cfg, text, ctx, opt = {}) {
  const builtin = ctx.builtin
  if (!builtin?.textToSpeech) throw new Error('插件自带的语音模块拿不到')
  const { file, engine } = await builtin.textToSpeech(text, opt, ctx.log)
  const fs = await import('node:fs')
  if (!file || !fs.existsSync(file)) throw new Error('没生成出音频文件')
  const ext = (file.match(/\.[a-z0-9]+$/i) || ['.mp3'])[0].toLowerCase().replace('.', '')
  return {
    contentType: CONTENT_TYPE[ext] || 'audio/mpeg',
    engine,
    iter: (async function* () {
      yield* fs.createReadStream(file)
    })(),
  }
}

function chainOf(provider) {
  if (provider === 'gptsovits') return ['gptsovits', 'edge', 'windows']
  if (provider === 'cosyvoice') return ['cosyvoice', 'edge', 'windows']
  if (provider === 'openai') return ['openai', 'edge', 'windows']
  if (provider === 'http') return ['http', 'edge', 'windows']
  if (provider === 'edge') return ['edge', 'windows']
  if (provider === 'windows') return ['windows']
  return ['edge', 'windows']
}

async function openOne(provider, cfg, text, ctx) {
  if (provider === 'gptsovits') return openGptSovits(cfg, text)
  if (provider === 'openai') return openOpenAI(cfg, text)
  if (provider === 'http') return openHttp(cfg, text)
  if (provider === 'cosyvoice') {
    return openBuiltin(cfg, text, ctx, { engine: 'cosyvoice', cosyvoice: cfg.cosyvoice })
  }
  if (provider === 'edge') {
    return openBuiltin(cfg, text, ctx, { engine: 'edge', voice: cfg.edgeVoice, rate: cfg.edgeRate, pitch: cfg.edgePitch })
  }
  if (provider === 'windows') return openBuiltin(cfg, text, ctx, { engine: 'windows' })
  throw new Error('不认识的合成引擎：' + provider)
}

/**
 * 拿到一段文字的音频流。按降级链逐个试，全都不行才抛错。
 * @returns {Promise<{provider:string, label:string, contentType:string, iter:AsyncIterator<Buffer>}>}
 */
export async function openTts(cfg, text, ctx = {}) {
  const chain = chainOf(cfg.provider)
  let lastError = null
  for (const p of chain) {
    try {
      const r = await openOne(p, cfg, text, ctx)
      if (p !== cfg.provider) ctx.log?.warn?.(`${TTS_LABEL[cfg.provider]} 不可用，这一句改用 ${TTS_LABEL[p]}`)
      return { provider: p, label: TTS_LABEL[p] || p, ...r }
    } catch (error) {
      lastError = error
      ctx.log?.warn?.(`${TTS_LABEL[p] || p} 合成失败：${error.message}`)
    }
  }
  throw lastError || new Error('没有可用的语音合成引擎')
}

/** 合成一整段到文件（垫话缓存、非流式接口用），返回 { file, engine } */
export async function ttsToFile(cfg, text, ctx, outPath) {
  const r = await openTts(cfg, text, ctx)
  const fs = await import('node:fs')
  const { once } = await import('node:events')
  const ws = fs.createWriteStream(outPath)
  for await (const chunk of r.iter) {
    if (!ws.write(chunk)) await once(ws, 'drain')
  }
  await new Promise((resolve, reject) => ws.end((error) => (error ? reject(error) : resolve())))
  return { file: outPath, engine: r.provider }
}

export { wavHeader }
