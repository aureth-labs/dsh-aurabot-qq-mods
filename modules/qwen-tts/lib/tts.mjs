// 本地接口 · 语音合成：走阿里云百炼（DashScope）的 SpeechSynthesizer 接口。
//
// 契约（插件 v1.1.24，见 src/local/local.js + templates/README-本地接口.md）：
//   输入 { text, outDir, log }
//   输出 音频文件路径（wav），或 { file }
//   出错 throw，插件会自动退回内置 TTS
//
// 设计要点：
//   - 长文本按句末标点切成 <= maxCharsPerSegment（默认 300）字的分段，逐段合成后拼成一个 WAV
//   - 缓存 key 覆盖「文本 + 所有影响输出的参数」，改配置不会命中旧音频
//   - 【语气】标记在这里剥掉，转成 instruction 里的自然语言描述（不打印、不念出来）
//   - 合成完走一遍 ffmpeg：裁首尾静音 + 300Hz 提亮 + 砍高频 + 轻压缩；失败保留原声
//   - 错误信息写成人能看懂的中文
//
// 调试：node test-tts.mjs "要念的话"         （听优化后的）
//       node test-tts.mjs --raw "要念的话"    （听优化前的原声）

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(HERE, 'tts.config.json')
const CACHE_DIR = join(HERE, 'cache')
const TMP_DIR = join(HERE, 'out')
const FFMPEG_LOG = join(HERE, 'out', 'ffmpeg.log')

const DEFAULTS = {
  baseUrl: 'https://dashscope.aliyuncs.com',
  workspaceId: '',
  region: '',
  apiKey: '',
  model: 'qwen-audio-3.1-tts-flash',
  voice: '',
  format: 'wav',
  speechRate: 1.0,
  sampleRate: 24000,
  maxCharsPerSegment: 300,
  timeoutMs: 30000,
  retries: 1,
  cache: true,
  // 语气基底：怎么念。改这一条影响最大。
  instruction: '用日常聊天说话的语气，像在手机上随口跟朋友讲话，语速略快，不要播音腔。中文。',
  // 固定 seed，让同样的输入复现同样的结果（合法范围 0-65535）
  seed: 20261,
  // 句尾轻声修正（拼音 1-4 是四声，5 是轻声）
  hotFix: { pronunciation: { 啊: 'a5' }, replace: {} },
  // 音频层：手机麦质感
  filters: {
    enabled: true,
    preset: 'medium', // light | medium | strong
    ffmpeg: '', // 留空自动找
    tailPad: 0.35, // 结尾补这么多秒静音，避免「话没说完就被掐断」
  },
}

// 官方 flash 中文女声兜底（没配 voice 时用）
const FALLBACK_VOICE = 'Cherry'

// 【语气】标记 -> instruction 里的补充描述。
// 不映射官方 [sad] 这类标签：官方标签偏"演"，而且没有撒娇、害羞这些细分。
const TONES = {
  撒娇: '这一句在撒娇，声音软一点，尾音稍微拖一点点，别太用力。',
  吐槽: '这一句在吐槽，语气随意、带点无语，别一字一顿，也别真的发火。',
  困: '这一句很困，声音偏低、偏慢、含糊一点，像马上要睡着了。',
  害羞: '这一句有点不好意思，声音小下去，说得比平时快一点。',
  生气: '这一句有点火，语气冲一点，语速快一点。',
  委屈: '这一句有点委屈，声音软下来，带一点闷。',
  惊讶: '这一句在惊讶，语速快一点，语气往上扬。',
  开心: '这一句很高兴，语气亮一点，往上扬。',
  无语: '这一句很无语，语气平、慢，带一点叹气的感觉。',
  认真: '这一句在认真说事，语气收敛，不撒娇。',
  无奈: '这一句有点无奈，语气自然、轻轻叹口气。',
  疑惑: '这一句有点疑惑，语气带一点好奇。',
  卖萌: '这一句在卖萌，语气轻快可爱，不要太夸张。',
}

// 保留合成音频原有的起音和尾音，只加短暂的开头缓冲与音色处理。
const PRESET_BODY = {
  light: 'highpass=f=85,equalizer=f=300:width_type=q:w=1.2:g=1.5,lowpass=f=7600:poles=2,acompressor=threshold=0.12:ratio=2.5:attack=6:release=140:makeup=1.5',
  medium: 'highpass=f=90,equalizer=f=300:width_type=q:w=1.1:g=2.5,equalizer=f=3200:width_type=q:w=1.4:g=-1.2,lowpass=f=6800:poles=2,acompressor=threshold=0.10:ratio=3:attack=5:release=120:makeup=2,alimiter=limit=0.96',
  strong: 'highpass=f=110,equalizer=f=300:width_type=q:w=1.0:g=3.5,equalizer=f=3400:width_type=q:w=1.4:g=-2,lowpass=f=6000:poles=2,acompressor=threshold=0.08:ratio=3.5:attack=4:release=110:makeup=2.5,alimiter=limit=0.95',
}

/** 完整滤镜链：开头缓冲、音色处理和可选的尾部留白。 */
export function buildChain(preset = 'medium', tailPad = 0.35) {
  const body = PRESET_BODY[preset] || PRESET_BODY.medium
  const pad = Number(tailPad) > 0 ? `apad=pad_dur=${Number(tailPad)}` : ''
  return [body, pad].filter(Boolean).join(',')
}

// 静态预设（不带尾音留白），保留给外部引用
const FILTER_PRESETS = Object.fromEntries(Object.keys(PRESET_BODY).map((k) => [k, buildChain(k, 0)]))

// 语气标记：`【吐槽】` / `[吐槽]`，只认表里有的，其余原样留着不动
const TONE_RE = /[【\[]([^】\]]{1,6})[】\]]/g

function isObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function loadConfig() {
  let raw = {}
  try {
    if (existsSync(CONFIG_PATH)) raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`读不了配置文件 ${CONFIG_PATH}：${error.message}`)
  }
  const c = { ...DEFAULTS, ...raw }
  // 域名只取到 .com（/ .aliyuncs.com 结尾），丢掉后面的路径
  c.baseUrl = normalizeBase(c.baseUrl)
  c.model = String(c.model || DEFAULTS.model).trim()
  c.voice = String(c.voice || '').trim() || FALLBACK_VOICE
  c.format = ['wav', 'mp3', 'pcm', 'opus'].includes(String(c.format)) ? String(c.format) : 'wav'
  c.speechRate = Number(c.speechRate) > 0 ? Number(c.speechRate) : 1.0
  c.sampleRate = [8000, 12000, 16000, 22050, 24000, 44100, 48000].includes(Number(c.sampleRate)) ? Number(c.sampleRate) : 24000
  c.maxCharsPerSegment = Math.min(300, Math.max(50, Number(c.maxCharsPerSegment) || 300))
  c.timeoutMs = Math.max(10000, Number(c.timeoutMs) || 30000)
  c.instruction = String(c.instruction || '').trim()
  c.seed = Number.isFinite(Number(c.seed)) ? Math.max(0, Math.min(65535, Number(c.seed))) : 0
  c.hotFix = isObj(c.hotFix) ? c.hotFix : {}
  c.filters = { ...DEFAULTS.filters, ...(isObj(c.filters) ? c.filters : {}) }
  if (!FILTER_PRESETS[c.filters.preset]) c.filters.preset = 'medium'
  if (!c.apiKey) throw new Error(`没填 API Key：${CONFIG_PATH} 里的 apiKey 是空的`)
  return c
}

/** https://xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 -> https://xxx.cn-beijing.maas.aliyuncs.com */
function normalizeBase(s) {
  let u = String(s || '').trim()
  if (!u) return DEFAULTS.baseUrl
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  try {
    const p = new URL(u)
    return `${p.protocol}//${p.host}`
  } catch {
    // 连 URL 都解析不了就退回默认
    return DEFAULTS.baseUrl
  }
}

// ---------- 语气标记 ----------

/**
 * 把 `【吐槽】行吧` 拆成 { text: '行吧', tone: '吐槽', desc: '…' }。
 * 表里没有的标记原样保留，不影响念。
 */
export function parseTone(text) {
  const src = String(text || '')
  let tone = ''
  let desc = ''
  const clean = src.replace(TONE_RE, (m, name) => {
    const key = String(name).trim()
    if (TONES[key]) {
      if (!desc) { tone = key; desc = TONES[key] }
      return ' '
    }
    return m
  }).replace(/[ \t]{2,}/g, ' ').trim()
  return { text: clean, tone, desc }
}

// ---------- 长文本切分 ----------

/** 按句末标点切成不超过 maxChars 的分段；没有标点的超长段硬切。 */
export function splitText(text, maxChars = 300) {
  const src = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!src) return []
  if (src.length <= maxChars) return [src]

  // 先按句末标点 + 换行切成小句（保留标点）
  const pieces = src.match(/[^。！？!?；;\n…]+[。！？!?；;\n…]*|[。！？!?；;\n…]+/g) || [src]
  const out = []
  let buf = ''
  const push = () => { if (buf.trim()) out.push(buf.trim()); buf = '' }

  for (const p of pieces) {
    if ((buf + p).length <= maxChars) { buf += p; continue }
    push()
    if (p.length <= maxChars) { buf = p; continue }
    // 单个小句就超长：按逗号再切
    const parts = p.match(/[^，,、：:]+[，,、：:]*/g) || [p]
    for (const q of parts) {
      if ((buf + q).length <= maxChars) { buf += q; continue }
      push()
      if (q.length <= maxChars) { buf = q; continue }
      // 还是没有标点：硬切
      for (let i = 0; i < q.length; i += maxChars) {
        const chunk = q.slice(i, i + maxChars)
        if (chunk.length === maxChars) out.push(chunk)
        else buf = chunk
      }
    }
  }
  push()
  return out.length ? out : [src.slice(0, maxChars)]
}

// ---------- 缓存 ----------

/** 缓存键覆盖所有影响输出的参数——少一个，改配置就不生效。 */
function cacheKey(text, instruction, c) {
  const sig = JSON.stringify({
    pipeline: 4,
    t: text,
    m: c.model,
    v: c.voice,
    f: c.format,
    r: c.speechRate,
    sr: c.sampleRate,
    i: instruction || '',
    s: c.seed,
    hf: c.hotFix && Object.keys(c.hotFix).length ? c.hotFix : null,
    fl: c.filters.enabled ? c.filters.preset : 'off',
    tp: c.filters.enabled ? (c.filters.tailPad ?? 0.35) : null,
    b: c.baseUrl,
  })
  return createHash('sha256').update(sig).digest('hex').slice(0, 32)
}

function cacheGet(key, format) {
  try {
    const f = join(CACHE_DIR, `${key}.${format}`)
    if (!existsSync(f)) return ''
    if (Date.now() - statSync(f).mtimeMs > 7 * 86400_000) { try { unlinkSync(f) } catch {} ; return '' }
    return statSync(f).size > 1024 ? f : ''
  } catch { return '' }
}

function cacheSet(key, format, buf) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    const f = join(CACHE_DIR, `${key}.${format}`)
    writeFileSync(f, buf)
    return f
  } catch { return '' }
}

// ---------- HTTP ----------

async function synthesizeSegment(text, instruction, c) {
  const url = `${c.baseUrl}/api/v1/services/audio/tts/SpeechSynthesizer`
  const input = {
    text,
    voice: c.voice,
    format: c.format,
    sample_rate: c.sampleRate,
    seed: c.seed,
  }
  if (Number(c.speechRate) !== 1) input.rate = Number(c.speechRate)
  if (instruction) input.instruction = instruction
  if (c.hotFix && Object.keys(c.hotFix).length) input.hot_fix = c.hotFix
  const body = { model: c.model, input, parameters: {} }

  let lastErr = ''
  for (let attempt = 0; attempt <= c.retries; attempt++) {
    let r
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(c.timeoutMs),
      })
    } catch (error) {
      lastErr = error.name === 'TimeoutError'
        ? `合成超时（${Math.round(c.timeoutMs / 1000)} 秒没返回）`
        : `连不上语音服务：${error.message}`
      continue
    }
    const raw = await r.text()
    if (!r.ok) {
      lastErr = explainHttpError(r.status, raw)
      // 401/403/404/400 重试无意义
      if ([401, 403, 404, 400].includes(r.status)) break
      if (attempt < c.retries && (r.status === 429 || r.status >= 500)) await new Promise((resolve) => setTimeout(resolve, 1000))
      continue
    }
    let j
    try { j = JSON.parse(raw) } catch { lastErr = '语音服务返回的不是 JSON'; continue }
    const audioUrl = j?.output?.audio?.url
    if (!audioUrl) {
      lastErr = '语音服务没返回音频地址'
      continue
    }
    // 这个 URL 只有 24 小时有效，要再 GET 一次才是音频
    let a
    try {
      a = await fetch(audioUrl, { signal: AbortSignal.timeout(c.timeoutMs) })
    } catch (error) {
      lastErr = `下载合成好的音频失败：${error.message}`
      continue
    }
    if (!a.ok) { lastErr = `下载合成好的音频失败（HTTP ${a.status}）`; continue }
    const buf = Buffer.from(await a.arrayBuffer())
    if (buf.length < 1024) { lastErr = `拿到的音频太小（${buf.length} 字节），可能是空音频`; continue }
    return buf
  }
  throw new Error(lastErr || '语音合成失败（原因不明）')
}

function explainHttpError(status, raw) {
  const detail = ''
  if (status === 401) return `百炼不认这个 API Key（401）${detail}`
  if (status === 403) return `这个 API Key 没有调语音的权限（403）${detail}`
  if (status === 404) return `接口地址不对（404）——检查 baseUrl 是不是只到域名${detail}`
  if (status === 429) return `调用太频繁被限流了（429）${detail}`
  if (status >= 500) return `百炼服务端出错（${status}）${detail}`
  return `语音服务返回 ${status}${detail}`
}

// ---------- WAV 拼接 ----------

function parseWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let off = 12, fmt = null, data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const start = off + 8
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(start), channels: buf.readUInt16LE(start + 2), rate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) }
    else if (id === 'data') data = buf.subarray(start, Math.min(buf.length, start + (size > buf.length ? buf.length - start : size)))
    off = start + size + (size & 1)
    if (size <= 0 || off > buf.length) break
  }
  if (!fmt || !data) return null
  return { ...fmt, data }
}

function buildWav(pcm, rate, channels = 1, bits = 16) {
  const out = Buffer.alloc(44 + pcm.length)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + pcm.length, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(channels, 22)
  out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * channels * (bits / 8), 28)
  out.writeUInt16LE(channels * (bits / 8), 32)
  out.writeUInt16LE(bits, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(pcm.length, 40)
  pcm.copy(out, 44)
  return out
}

/** 多段 WAV 拼成一个；无法拼接时明确报错，避免只发出前半段。 */
function concatWav(bufs, log) {
  const parsed = bufs.map((b) => parseWav(b))
  if (parsed.some((p) => !p)) {
    if (bufs.length === 1) return bufs[0]
    throw new Error('语音分段不是标准 WAV，无法拼接完整语音')
  }
  const first = parsed[0]
  const same = parsed.every((p) => p.format === first.format && p.channels === first.channels && p.rate === first.rate && p.bits === first.bits)
  if (!same) {
    throw new Error('语音分段格式不一致，无法拼接完整语音')
  }
  // 百炼返回的 WAV 头部 data 长度字段是错的（0x7fffff9b 之类），一律按真实数据重打包
  const total = parsed.reduce((n, p) => n + p.data.length, 0)
  const pcm = Buffer.concat(parsed.map((p) => p.data), total)
  return buildWav(pcm, first.rate, first.channels, first.bits)
}

/** 只缩短开头静音，保留 80ms 起音空间；末尾样本完整保留。 */
export function trimLeadingSilence(audio) {
  const p = parseWav(audio)
  if (!p || p.format !== 1 || p.bits !== 16) return audio
  const frameBytes = p.channels * 2
  const frames = Math.floor(p.data.length / frameBytes)
  const window = Math.max(1, Math.round(p.rate * 0.01))
  for (let start = 0; start < frames; start += window) {
    const end = Math.min(frames, start + window)
    let energy = 0
    for (let frame = start; frame < end; frame++) {
      for (let ch = 0; ch < p.channels; ch++) {
        const sample = p.data.readInt16LE(frame * frameBytes + ch * 2)
        energy += sample * sample
      }
    }
    if (Math.sqrt(energy / ((end - start) * p.channels)) > 32) {
      const cut = Math.max(0, start - Math.round(p.rate * 0.08))
      return cut ? buildWav(p.data.subarray(cut * frameBytes), p.rate, p.channels, p.bits) : audio
    }
  }
  return audio
}

// ---------- 音频层：ffmpeg ----------

let ffmpegCache = null

/** 找 ffmpeg：配置指定 > local/bin 自带 > PATH。找不到返回 ''。 */
export function findFfmpeg(c) {
  if (ffmpegCache !== null) return ffmpegCache
  const explicit = String(c?.filters?.ffmpeg || '').trim()
  if (explicit && existsSync(explicit)) return (ffmpegCache = explicit)
  // 自带的（build 目录名带版本号，扫一层）
  const binRoot = join(HERE, 'bin', 'ffmpeg')
  if (existsSync(binRoot)) {
    const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    try {
      for (const d of readdirSync(binRoot)) {
        const p = join(binRoot, d, 'bin', exeName)
        if (existsSync(p)) return (ffmpegCache = p)
      }
    } catch {}
    const flat = join(binRoot, exeName)
    if (existsSync(flat)) return (ffmpegCache = flat)
  }
  // PATH 里碰运气
  try {
    const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    if (probe.status === 0) return (ffmpegCache = 'ffmpeg')
  } catch {}
  ffmpegCache = ''
  return ffmpegCache
}

/**
 * 给合成好的 WAV 上手机麦质感。任何一步失败都返回原 buffer——绝不能因此发不出语音。
 */
export function polish(audio, c, log) {
  if (!c.filters.enabled) return audio
  const exe = findFfmpeg(c)
  if (!exe) {
    log?.warn?.('没找到 ffmpeg，这一条先发原声（装好 ffmpeg 后自动生效）')
    return audio
  }
  const chain = buildChain(c.filters.preset, c.filters.tailPad)
  const stamp = `${process.pid}-${Date.now()}`
  const tmpIn = join(TMP_DIR, `tmp-in-${stamp}.wav`)
  const tmpOut = join(TMP_DIR, `tmp-out-${stamp}.wav`)
  try {
    mkdirSync(TMP_DIR, { recursive: true })
    writeFileSync(tmpIn, trimLeadingSilence(audio))
    let fd = -1
    try { fd = openSync(FFMPEG_LOG, 'a') } catch {}
    const r = spawnSync(exe, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', tmpIn,
      '-af', chain,
      '-ar', String(c.sampleRate || 24000),
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      tmpOut,
    ], { stdio: fd >= 0 ? ['ignore', 'ignore', fd] : 'ignore', timeout: 20000 })
    if (fd >= 0) { try { closeSync(fd) } catch {} }
    if (r.error) throw r.error
    if (r.status !== 0) throw new Error(`ffmpeg 退出码 ${r.status}`)
    if (!existsSync(tmpOut)) throw new Error('ffmpeg 没产出文件')
    const out = readFileSync(tmpOut)
    if (out.length < 1024) throw new Error('ffmpeg 产出的文件太小')
    return out
  } catch (error) {
    log?.warn?.(`音频加工失败，这一条发原声：${error.message}`)
    return audio
  } finally {
    for (const f of [tmpIn, tmpOut]) { try { if (existsSync(f)) unlinkSync(f) } catch {} }
  }
}

// ---------- 主入口 ----------

/** 正文 -> 实际要念的文本 + 这一句的 instruction */
export function prepare(text, c) {
  const { text: clean, tone, desc } = parseTone(text)
  const base = c.instruction || ''
  const instruction = desc ? (base ? `${base}${base.endsWith('。') ? '' : '。'}${desc}` : desc) : base
  return { text: clean, tone, instruction }
}

export default async function tts({ text, outDir, log, raw = false }) {
  const c = loadConfig()
  if (raw) c.filters = { ...c.filters, enabled: false }
  const { text: clean, tone, instruction } = prepare(String(text || ''), c)
  if (!clean) throw new Error('没有要念的文字')

  const dir = outDir || TMP_DIR
  mkdirSync(dir, { recursive: true })

  // 1. 缓存命中
  const key = cacheKey(clean, instruction, c)
  const hit = c.cache ? cacheGet(key, c.format) : ''
  if (hit) {
    log?.info?.('百炼语音命中缓存')
    return hit
  }

  // 2. 切分
  const segs = splitText(clean, c.maxCharsPerSegment)
  if (segs.length > 1) log?.info?.(`文字有点长，切成 ${segs.length} 段念`)

  // 3. 逐段合成
  const bufs = []
  for (let i = 0; i < segs.length; i++) {
    try {
      bufs.push(await synthesizeSegment(segs[i], instruction, c))
    } catch (error) {
      throw new Error(segs.length > 1 ? `第 ${i + 1}/${segs.length} 段合成失败——${error.message}` : error.message)
    }
  }

  // 4. 拼接 + 加工 + 落盘
  const merged = concatWav(bufs, log)
  const audio = polish(merged, c, log)
  const ext = c.format === 'mp3' ? 'mp3' : 'wav'
  const file = join(dir, `tts-${Date.now()}.${ext}`)
  writeFileSync(file, audio)

  if (c.cache) cacheSet(key, c.format, audio)
  log?.info?.(`百炼语音合成完成（${bufs.length} 段，${Math.round(audio.length / 1024)} KB）`)
  return file
}

/** 给 test-tts.mjs 用：不写缓存、按给定参数合成。raw=true 时跳过音频层。 */
export async function testSynthesize(text, overrides = {}, { raw = false } = {}) {
  const c = { ...loadConfig(), ...overrides, cache: false }
  if (raw) c.filters = { ...c.filters, enabled: false }
  const dir = join(HERE, 'out')
  mkdirSync(dir, { recursive: true })
  const { text: clean, tone, instruction } = prepare(String(text || ''), c)
  const segs = splitText(clean, c.maxCharsPerSegment)
  const bufs = []
  for (const s of segs) bufs.push(await synthesizeSegment(s, instruction, c))
  const merged = concatWav(bufs, console)
  const audio = polish(merged, c, console)
  const file = join(dir, `test-${Date.now()}${raw ? '-raw' : ''}.${c.format === 'mp3' ? 'mp3' : 'wav'}`)
  writeFileSync(file, audio)
  return { file, segments: segs.length, bytes: audio.length, tone, instruction, text: clean }
}

export { loadConfig, CONFIG_PATH, FILTER_PRESETS }
