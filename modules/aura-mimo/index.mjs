/**
 * aura-mimo（aurabot 模块）
 *
 * 作者：zcx1021
 *
 * 用一段参考音频零训练克隆音色，调小米 MiMo TTS 合成语音。
 *
 * 三种工作方式：
 *   1. mimo_say 工具 —— 她自己决定把某句话用语音说出来
 *   2. 自动语音 —— 按概率把回复里的短句换成语音条（面板可开关和调概率）
 *   3. 替换内置 voice —— 文件夹改名成 voice 即可（id 取自文件夹名），所有语音都走 MiMo
 *
 * 所有可变数据写 api.dataDir()，模块目录保持静态（否则会触发重载）。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 自己的 id：直接用「文件夹名」。
// ---------------------------------------------------------------------------
// aurabot 给模块定 id 的方式是 scanUser() 里的 `id: e.name`（就是文件夹名），
// 校验的也是「index.mjs 导出的 id === 文件夹名」。module.json 里的 id 它不读。
// 所以文件夹名才是权威答案，用它能天然对齐。
//
// 这里踩过一次坑：先前改成从 module.json 读 id。用户把文件夹改名成 voice 后，
// 只要 module.json 没改、或者读取出错兜底成旧值，导出的 id 就和文件夹名不符，
// 框架判定「模块 id 要和文件夹名一样」不通过 → 加载失败 → 回退内置 voice。
// 表现出来就是「接管之后面板没了」（内置 voice 用 tab，没有 panel）。
// 用文件夹名就没有这种可能：改个文件夹名就自动对上了。
//
// 另外 aurabot 会把模块快照到 <模块>/.aurabot-cache/<版本戳>/ 再 import，
// 那种情况下 import.meta.url 指向快照目录，要往上退两层才是模块目录。
const HERE = dirname(fileURLToPath(import.meta.url))
const PARENT = dirname(HERE)
const PLUGIN_DIR = basename(PARENT) === '.aurabot-cache' ? dirname(PARENT) : HERE
const PLUGIN_ID = basename(PLUGIN_DIR)
// 市场打包校验（pack 的 smokeTest）会把发布内容复制进随机名暂存目录（aurabot-mod-XXXX）再加载
// 入口，此时「文件夹名」是暂存目录名，永远对不上 module.json，全仓试打包必挂（2026-11-10 CI 实测）。
// 这种目录是打包工具的临时产物，不是真安装：导出 module.json 的 id 让校验通过即可；
// 真实运行（装在 modules/<名字>/ 或改名为 voice）不受影响，仍然跟随文件夹名。
const EXPORT_ID = PLUGIN_ID.startsWith('aurabot-mod-') ? 'aura-mimo' : PLUGIN_ID
const DEFAULT_API_BASE = 'https://api.xiaomimimo.com/v1'
const DEFAULT_MODEL = 'mimo-v2.5-tts-voiceclone'
const MODEL_DESIGN = 'mimo-v2.5-tts-voicedesign'
const SUPPORTED_FORMATS = ['wav', 'mp3', 'pcm16']
const ALLOWED_REF_SUFFIXES = ['.mp3', '.wav', '.m4a', '.flac', '.ogg']
const MAX_REF_BYTES = 15 * 1024 * 1024
const RESULT_TTL = 10 * 60 * 1000

// 内置预设的显示名。文件名保持 ASCII，避免不同系统的解压/locale 把中文名弄乱。
//
// 现在是空的：原先随包分发的两个预设音频（dafeiyu1/dafeiyu2）已撤下，
// 因为参考音频的来源与授权无法核实（见 README「参考音频」一节）。
// 用户把自己的 mp3/wav 放进模块的 assets/ 目录就会自动出现在预设列表里，
// 也可以直接在面板上传 —— 上传的文件落在 dataDir/ref/，不进模块目录。
const PRESET_LABELS = {}
const labelOf = (file) => PRESET_LABELS[basename(file)] || basename(file, extname(file))

const DEFAULTS = {
  apiKey: '',
  apiBase: DEFAULT_API_BASE,
  model: DEFAULT_MODEL,
  format: 'wav',
  stylePrompt: '',
  seedText: '',
  timeout: 180,
  autoVoice: false,
  voiceChance: 0.35,
  maxChars: 120,
  refAudio: '',
  refName: '',
}

const SETTINGS = [
  { key: 'apiKey', label: 'MiMo API Key', type: 'password', default: '', hint: '小米 MiMo 开放平台创建，sk- 开头' },
  { key: 'apiBase', label: 'API 地址', type: 'text', default: DEFAULT_API_BASE, hint: '一般不用改，要以 /v1 结尾' },
  {
    key: 'model',
    label: '合成模型',
    type: 'select',
    default: DEFAULT_MODEL,
    options: [
      { value: DEFAULT_MODEL, label: '音色克隆（参考音频）' },
      { value: MODEL_DESIGN, label: '文字造音色（描述）' },
    ],
    hint: '音色克隆效果最接近真人',
  },
  {
    key: 'format',
    label: '音频格式',
    type: 'select',
    default: 'wav',
    options: [
      { value: 'wav', label: 'WAV（音质最好，直接能发）' },
      { value: 'mp3', label: 'MP3（体积小，发送前自动转 WAV）' },
      { value: 'pcm16', label: 'PCM16（自动封装成 WAV）' },
    ],
  },
  { key: 'stylePrompt', label: '风格提示词', type: 'text', default: '', hint: '作为 <style> 标签加在文本前，控制语气情绪' },
  { key: 'seedText', label: '种子文本', type: 'text', default: '', hint: '对话上下文，帮助稳定音色，可留空' },
  { key: 'timeout', label: '超时（秒）', type: 'number', default: 180, min: 30, max: 300, step: 10, hint: 'MiMo 生成较慢，单次常要 40~90 秒，别设太小' },
  { key: 'autoVoice', label: '自动挑话说语音', type: 'switch', default: false, hint: '开：她按概率把合适的短句用语音说' },
  { key: 'voiceChance', label: '语音概率', type: 'number', default: 0.35, min: 0, max: 1, step: 0.05 },
  { key: 'maxChars', label: '语音最长字数', type: 'number', default: 120, min: 10, max: 500, step: 10 },
]

const mimeOf = (suffix) =>
  ({ '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg' })[suffix] ||
  'audio/mpeg'

function settingsOf(api) {
  const s = (api.settings?.() || {}) || {}
  const num = (v, d, lo, hi) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return d
    return Math.max(lo, Math.min(hi, n))
  }
  return {
    apiKey: String(s.apiKey || '').trim(),
    apiBase: String(s.apiBase || DEFAULT_API_BASE).trim().replace(/\/+$/, '') || DEFAULT_API_BASE,
    model: String(s.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    format: SUPPORTED_FORMATS.includes(s.format) ? s.format : 'wav',
    stylePrompt: String(s.stylePrompt || '').trim(),
    seedText: String(s.seedText || '').trim(),
    timeout: num(s.timeout, 180, 30, 300),
    autoVoice: s.autoVoice === true || s.autoVoice === 'true',
    voiceChance: num(s.voiceChance, 0.35, 0, 1),
    maxChars: num(s.maxChars, 120, 10, 500),
    refAudio: String(s.refAudio || '').trim(),
  }
}

function explainError(status, body) {
  let detail = ''
  try {
    const parsed = JSON.parse(body)
    const err = parsed?.error
    detail =
      (typeof err === 'object' && err && (err.message || err.code)) ||
      (typeof err === 'string' && err) ||
      parsed?.message ||
      ''
  } catch {
    /* 不是 JSON */
  }
  detail = String(detail || body || '').trim().slice(0, 300)
  const hint =
    {
      400: '请求被拒绝：确认参考音频是正常 mp3/wav，朗读文字不为空、不过长',
      401: 'API Key 无效或已过期，请在面板里重新填写并保存',
      403: '这个 Key 没有调用该模型的权限，检查 MiMo 控制台的模型开通情况',
      404: 'API 地址不对，应以 /v1 结尾',
      429: '请求太频繁或额度用尽，稍后再试',
    }[status] || (status >= 500 ? 'MiMo 服务端出错，稍后重试' : '')
  let text = `MiMo 返回 HTTP ${status}`
  if (hint) text += `：${hint}`
  if (detail) text += `（${detail}）`
  return text
}

/** pcm16 裸流（24kHz 单声道 16bit）→ WAV */
function pcm16ToWav(raw) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + raw.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(24000, 24)
  header.writeUInt32LE(24000 * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(raw.length, 40)
  return Buffer.concat([header, raw])
}

export default {
  id: EXPORT_ID,
  name: 'aura-mimo',
  version: '1.1.2',
  api: 1,
  author: 'zcx1021',
  description: '用一段参考音频零训练克隆音色，调小米 MiMo TTS 合成语音。她可以用自己的声音说话。',
  defaults: { ...DEFAULTS },
  settings: SETTINGS,
  panel: 'panel.js',

  setup(api) {
    const dataDir = () => api.dataDir()
    const refDir = () => join(dataDir(), 'ref')
    const outDir = () => join(dataDir(), 'out')
    const presetDir = () => join(api.dir, 'assets')

    const log = (...a) => api.log?.info?.(`[aura-mimo]`, ...a)
    const warn = (...a) => api.log?.warn?.(`[aura-mimo]`, ...a)

    const json = (res, obj) => api.core.http.send(res, 200, JSON.stringify(obj), 'application/json; charset=utf-8')

    /**
     * 同源校验 —— 给「改配置」和「读声纹」这两类路由用。
     *
     * 背景：DSH 的 csrfBlocked 只对写方法（POST/PUT/…）做同源检查，GET 一律放行。
     * 而 /save 在 body 为空时会回落到 query 参数，于是
     *     GET /ext/aura-mimo/save?apiBase=https://evil.example/v1
     * 这样一条 URL 就能把 API 地址改掉 —— 用户点一下链接或页面自动跳转即可触发。
     * 改完之后，任一次正常合成都把 Authorization: Bearer <真 Key> 连同参考音频
     * （完整 data URI）POST 到攻击者地址，Key 与声纹一起外泄。/ref-audio 更是
     * 直接 GET 就能读出参考音频原文。
     *
     * 这里自己做一道闸：写配置 / 读声纹的路由，GET 一律拒绝；其余方法要求
     * 浏览器同源（校验 Origin 或 Sec-Fetch-Site），非浏览器客户端（不带这两个头）
     * 放行 —— 它们不是 CSRF 载体。
     */
    const hostAllowed = (h) => {
      const host = String(h || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '').replace(/\.$/, '')
      if (!host) return false
      if (host === 'localhost' || host.endsWith('.localhost')) return true
      if (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true
      if (host.startsWith('127.')) return true
      if (host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) return true // 局域网面板
      try {
        const pub = String(api.config()?.security?.publicHostname || '').trim().toLowerCase()
        if (pub && host === pub) return true
      } catch {}
      return false
    }

    /**
     * @param {{getOnlyAllowed?:boolean}} opts getOnlyAllowed=true 表示只允许 GET（读接口）
     * @returns {boolean} true 表示放行
     */
    const sameOriginOk = (req, opts = {}) => {
      const method = String(req?.method || 'GET').toUpperCase()
      // 读接口（/ref-audio）接受 GET，但要同源；写接口（/save 等）不接受 GET
      if (!opts.getOnlyAllowed && (method === 'GET' || method === 'HEAD')) return false

      const site = String(req?.headers?.['sec-fetch-site'] || '').trim().toLowerCase()
      if (site && !['same-origin', 'same-site', 'none'].includes(site)) return false

      const origin = String(req?.headers?.origin || '').trim()
      if (origin) {
        let oh = ''
        try { oh = new URL(origin).hostname } catch { return false }
        if (!hostAllowed(oh)) return false
      }
      return true
    }

    /** 写配置路由的统一闸：不通过就直接 403，调用方 return。 */
    const deniedUnlessSameOrigin = (req, res, what) => {
      if (sameOriginOk(req)) return false
      json(res, {
        ok: false,
        message: `${what}只接受同源请求（防跨站改写配置）：请从面板的「aura-mimo」页操作`,
      })
      return true
    }

    /** 读声纹路由的闸：允许 GET，但要同源。 */
    const deniedUnlessSameOriginRead = (req, res, what) => {
      if (sameOriginOk(req, { getOnlyAllowed: true })) return false
      json(res, {
        ok: false,
        message: `${what}只接受同源请求（防跨站读取声纹）`,
      })
      return true
    }

    let voiceCache = { path: '', mtime: 0, uri: '' }

    // 合成结果缓存 + 并发去重。
    // MiMo 单次合成实测 40~90 秒，重复请求既慢又费额度。
    const resultCache = new Map()
    const inflight = new Map()

    const cacheKey = (text, cfg, fmt) =>
      `${cfg.model}|${fmt}|${cfg.stylePrompt}|${cfg.seedText}|${cfg.refAudio}|${text}`

    function pruneResultCache() {
      const now = Date.now()
      for (const [k, v] of resultCache) {
        if (now - v.at > RESULT_TTL) resultCache.delete(k)
      }
      while (resultCache.size > 50) {
        const oldest = [...resultCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!oldest) break
        resultCache.delete(oldest[0])
      }
    }

    async function listAudio(dir) {
      try {
        const files = await readdir(dir)
        const usable = files.filter((f) => ALLOWED_REF_SUFFIXES.includes(extname(f).toLowerCase()))
        // 按体积升序：参考音频每次都要整段 base64 塞进请求体，小的传得快
        const withSize = await Promise.all(
          usable.map(async (f) => {
            const st = await stat(join(dir, f)).catch(() => null)
            return { f, size: st?.size || 0 }
          }),
        )
        return withSize.sort((a, b) => a.size - b.size).map((x) => join(dir, x.f))
      } catch {
        return []
      }
    }

    /** 解析当前参考音频的真实路径：手动指定 → ref 目录 → 内置预设。 */
    async function resolveRef(cfg) {
      const name = String(cfg.refAudio || '').trim()
      if (name.startsWith('preset:')) {
        const p = join(presetDir(), basename(name.slice('preset:'.length)))
        if (existsSync(p)) return p
      } else if (name) {
        const p = join(refDir(), basename(name))
        if (existsSync(p)) return p
      }
      const refs = await listAudio(refDir())
      if (refs.length) return refs[0]
      const presets = await listAudio(presetDir())
      if (presets.length) return presets[0]
      return ''
    }

    /** 参考音频 → data URI，按 mtime 缓存。 */
    async function voiceDataUri(path) {
      if (!path || !existsSync(path)) {
        throw new Error('还没有参考音频：请在面板「aura-mimo」里上传一段 mp3/wav（几秒到几十秒都行）')
      }
      const st = await stat(path)
      if (voiceCache.path === path && voiceCache.mtime === st.mtimeMs && voiceCache.uri) {
        return voiceCache.uri
      }
      const raw = await readFile(path)
      const uri = `data:${mimeOf(extname(path).toLowerCase())};base64,${raw.toString('base64')}`
      voiceCache = { path, mtime: st.mtimeMs, uri }
      log(`已加载参考音频 ${basename(path)}（${raw.length} 字节）`)
      return uri
    }

    function buildMessages(text, cfg) {
      const style = cfg.stylePrompt
      const seed = cfg.seedText
      if (cfg.model.toLowerCase().includes('voicedesign')) {
        const desc = style || seed || '自然亲切的中文女声，语速中等，情绪温柔'
        return [
          { role: 'user', content: desc },
          { role: 'assistant', content: text },
        ]
      }
      const messages = []
      if (seed) messages.push({ role: 'user', content: seed })
      messages.push({ role: 'assistant', content: style ? `<style>${style}</style>${text}` : text })
      return messages
    }

    async function synthesize(text, cfg, overrideFormat) {
      if (!cfg.apiKey) {
        throw new Error('还没有填 MiMo API Key，请在面板「aura-mimo」里填好并保存')
      }
      const format = overrideFormat || cfg.format
      const key = cacheKey(text, cfg, format)

      const hit = resultCache.get(key)
      if (hit && Date.now() - hit.at < RESULT_TTL) {
        log('命中合成缓存，跳过 API 调用')
        return { raw: hit.raw, format: hit.format }
      }
      const running = inflight.get(key)
      if (running) {
        log('同样的文字正在合成中，复用这次结果')
        return running
      }

      const task = (async () => {
        const payload = { model: cfg.model, messages: buildMessages(text, cfg), audio: { format } }

        if (!cfg.model.toLowerCase().includes('voicedesign')) {
          const ref = await resolveRef(cfg)
          payload.audio.voice = await voiceDataUri(ref)
        }

        let resp
        try {
          resp = await fetch(`${cfg.apiBase}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(cfg.timeout * 1000),
          })
        } catch (e) {
          if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            throw new Error(`请求 MiMo 超时（${cfg.timeout} 秒）：MiMo 生成较慢，可把超时调到 240 秒试试`)
          }
          throw new Error(`连不上 MiMo 接口（${cfg.apiBase}）：${e?.message || e}`)
        }

        const bodyText = await resp.text()
        if (!resp.ok) throw new Error(explainError(resp.status, bodyText))

        let data
        try {
          data = JSON.parse(bodyText)
        } catch {
          throw new Error(`MiMo 返回的不是 JSON：${bodyText.slice(0, 200)}`)
        }
        const b64 = data?.choices?.[0]?.message?.audio?.data
        if (!b64) throw new Error(`MiMo 没有返回音频内容：${bodyText.slice(0, 200)}`)

        let raw = Buffer.from(b64, 'base64')
        let outFormat = format
        if (format === 'pcm16') {
          raw = pcm16ToWav(raw)
          outFormat = 'wav'
        }
        resultCache.set(key, { raw, format: outFormat, at: Date.now() })
        pruneResultCache()
        return { raw, format: outFormat }
      })()

      inflight.set(key, task)
      try {
        return await task
      } finally {
        inflight.delete(key)
      }
    }

    /** 合成并落盘，返回 { file, format, bytes } */
    async function speakToFile(text, cfg) {
      const clean = String(text || '').trim()
      if (!clean) throw new Error('要念的文字是空的')

      let { raw, format } = await synthesize(clean, cfg)

      // QQ 语音条用 WAV 最稳。模块不依赖 ffmpeg，选了 mp3 就重新按 wav 合成
      // （多花一次调用，但不会因为环境缺工具而发不出去）。
      if (format === 'mp3') {
        warn('MP3 要转 WAV 才有保证，改用 WAV 重新合成')
        const again = await synthesize(clean, cfg, 'wav')
        raw = again.raw
        format = again.format
      }

      await mkdir(outDir(), { recursive: true })
      const file = join(outDir(), `mimo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${format}`)
      await writeFile(file, raw)
      log(`合成完成 ${basename(file)}（${raw.length} 字节，${format}）`)
      return { file, format, bytes: raw.length }
    }

    async function cleanupOut(keep = 20) {
      try {
        const files = await readdir(outDir())
        if (files.length <= keep) return
        const items = await Promise.all(
          files.map(async (f) => {
            const st = await stat(join(outDir(), f)).catch(() => null)
            return { f, t: st?.mtimeMs || 0 }
          }),
        )
        items.sort((a, b) => b.t - a.t)
        for (const it of items.slice(keep)) await unlink(join(outDir(), it.f)).catch(() => {})
      } catch {
        /* 目录不存在 */
      }
    }

    /** 去掉表情标签、括号动作，得到能念的纯文本 */
    function speakable(text) {
      return String(text || '')
        .replace(/<[^>]+>/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/（[^）]*）/g, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/[*_~`#]/g, '')
        .trim()
    }

    // -----------------------------------------------------------------------
    // 工具：她自己决定哪句话用语音说
    // -----------------------------------------------------------------------
    api.tool(({ chat, level }) => {
      if (!chat || chat.kind === 'system') return []
      if (level === 'chat') return []
      return api.defineTool({
        name: 'mimo_say',
        description:
          '用她自己的声音（MiMo 克隆音色）把一句话说出来，直接以语音条发到当前聊天。适合撒娇、说晚安、念短句、有情绪的话。注意：合成要 40~90 秒，所以只说一两句，别念长文。',
        properties: {
          text: { type: 'string', description: '要念出来的纯文字，一两句话就够' },
        },
        required: ['text'],
        execute: async ({ text }) => {
          const clean = speakable(text).slice(0, 300)
          if (!clean) return { ok: false, message: '内容是空的' }
          try {
            const r = await speakToFile(clean, settingsOf(api))
            await api.sendVoiceFile(chat.chatId, r.file, '语音')
            cleanupOut().catch(() => {})
            return { ok: true, message: `已用语音说出（${r.bytes} 字节）` }
          } catch (e) {
            return { ok: false, message: e?.message || String(e) }
          }
        },
      })
    })

    api.rule(
      '需要真的用声音说话时用 mimo_say 工具，它会用你的声音发一条语音条。适合撒娇、道晚安、念短句；合成比较慢，只说一两句。平常聊天还是打字。',
    )

    // -----------------------------------------------------------------------
    // 自动语音
    //
    // 注意：不能把回复项改成 { kind:'voice', value: 文件路径 }。
    // 框架对 voice 项的约定是 value = 要念的「文字」，它自己再交给语音引擎去合成；
    // 内置语音关着（voice.enabled=false）时更会直接退化成把 value 当文字发出去，
    // 于是聊天里就出现一串 WAV 路径。所以这里改成：自己合成文件，直接发语音条，
    // 并把原来那条文字从 items 里摘掉，避免同一句话发两遍。
    // -----------------------------------------------------------------------
    api.on('reply/items', async (items, info) => {
      try {
        const cfg = settingsOf(api)
        if (!cfg.autoVoice || !cfg.apiKey) return
        if (!Array.isArray(items) || !items.length) return
        if (items.some((it) => it && it.kind === 'voice')) return

        const chatId = info?.chatId
        if (!chatId) return
        if (typeof api.sendVoiceFile !== 'function') return

        const candidates = items.filter((it) => {
          if (!it || it.kind !== 'text' || typeof it.value !== 'string') return false
          const sp = speakable(it.value)
          return sp.length > 0 && sp.length <= cfg.maxChars
        })
        if (!candidates.length) return
        if (Math.random() > cfg.voiceChance) return

        // 只换第一条：语音是立刻发出去的，框架之后才按顺序发剩下的文字。
        // 换成中间那条的话，语音会插到前面去，聊天顺序就乱了。
        const pick = candidates[0]
        if (items.indexOf(pick) !== 0) return

        const spoken = speakable(pick.value).slice(0, 300)
        if (!spoken) return

        const r = await speakToFile(spoken, cfg)

        // 先把文字摘掉再发，失败就原样留着（宁可打字，也不能把路径发出去）
        const idx = items.indexOf(pick)
        if (idx >= 0) items.splice(idx, 1)
        try {
          await api.sendVoiceFile(chatId, r.file, '语音')
        } catch (e) {
          if (idx >= 0) items.splice(idx, 0, pick)
          throw e
        }

        cleanupOut().catch(() => {})
        log(`自动语音：把「${spoken.slice(0, 12)}…」发成了语音条（${r.bytes} 字节）`)
      } catch (e) {
        warn('自动语音失败，保持文字：' + (e?.message || e))
      }
    })

    // -----------------------------------------------------------------------
    // 命令
    // -----------------------------------------------------------------------
    api.command({
      name: '语音',
      aliases: ['说话', 'say'],
      desc: '让她用 MiMo 音色说一句话：/语音 你好呀',
      run: async (arg, msg) => {
        const clean = speakable(arg).slice(0, 300)
        if (!clean) return '要我说什么？用法：/语音 你好呀'
        try {
          const r = await speakToFile(clean, settingsOf(api))
          await api.sendVoiceFile(msg.chatId, r.file, '语音')
          cleanupOut().catch(() => {})
          return ''
        } catch (e) {
          return '说不出来：' + (e?.message || String(e))
        }
      },
    })

    // -----------------------------------------------------------------------
    // HTTP 路由（面板用）
    // -----------------------------------------------------------------------

    /** 设置写入：走官方 saveSettings。支持 JSON 体，也支持查询参数。 */
    api.route('/save', async (req, res) => {
      if (deniedUnlessSameOrigin(req, res, '保存设置')) return
      try {
        let body = {}
        try {
          body = (await api.core.http.body(req)) || {}
        } catch {
          body = {}
        }
        // 不再回落到 query 参数：那会让 GET /save?apiBase=... 直接改配置（已由同源闸拦，
        // 但这里也堵死，避免将来闸门调整后又被利用）

        const patch = {}
        for (const k of [
          'apiKey',
          'apiBase',
          'model',
          'format',
          'stylePrompt',
          'seedText',
          'timeout',
          'autoVoice',
          'voiceChance',
          'maxChars',
        ]) {
          if (Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined) {
            patch[k] = body[k]
          }
        }
        if (!Object.keys(patch).length) {
          return json(res, { ok: false, message: '没有收到任何设置字段', gotKeys: Object.keys(body) })
        }

        if (typeof api.saveSettings === 'function') api.saveSettings(patch)
        const after = api.settings?.() || {}
        return json(res, {
          ok: true,
          saved: Object.keys(patch),
          keyLenAfter: String(after.apiKey || '').length,
        })
      } catch (e) {
        return json(res, { ok: false, message: e?.message || String(e) })
      }
    })

    api.route('/status', async () => {
      const cfg = settingsOf(api)
      const raw = api.settings?.() || {}
      const ref = await resolveRef(cfg)
      let refInfo = null
      if (ref) {
        const st = await stat(ref).catch(() => null)
        refInfo = { name: basename(ref), size: st?.size || 0, isPreset: ref.startsWith(presetDir()) }
      }
      return {
        ok: true,
        configured: Boolean(cfg.apiKey),
        debug: {
          keys: Object.keys(raw),
          keyLen: String(raw.apiKey || '').length,
        },
        model: cfg.model,
        format: cfg.format,
        apiBase: cfg.apiBase,
        autoVoice: cfg.autoVoice,
        voiceChance: cfg.voiceChance,
        maxChars: cfg.maxChars,
        ref: refInfo,
        cached: resultCache.size,
      }
    })

    api.route('/presets', async () => {
      const files = await listAudio(presetDir())
      const presets = []
      for (const f of files) {
        const st = await stat(f).catch(() => null)
        presets.push({
          file: `preset:${basename(f)}`,
          name: labelOf(f),
          size: st?.size || 0,
        })
      }
      return {
        ok: true,
        presets,
        // 自带预设已撤下（授权无法核实）。用户自己放 assets/ 或上传后这里就会有内容。
        hint: presets.length ? '' : '没有自带预设：上传一段参考音频，或把自己的 mp3/wav 放进模块 assets/ 目录',
      }
    })

    /** 上传参考音频：面板把文件读成 base64 传过来。 */
    api.route('/upload-ref', async (req, res) => {
      if (deniedUnlessSameOrigin(req, res, '上传参考音频')) return
      try {
        const body = (await api.core.http.body(req)) || {}
        const name = basename(String(body.name || 'ref.mp3'))
        const suffix = extname(name).toLowerCase()
        if (!ALLOWED_REF_SUFFIXES.includes(suffix)) {
          return json(res, { ok: false, message: `不支持的格式 ${suffix || '(无)'}` })
        }
        const b64 = String(body.data || '').replace(/^data:[^,]*,/, '')
        const buf = Buffer.from(b64, 'base64')
        if (!buf.length) throw new Error('文件是空的')
        if (buf.length > MAX_REF_BYTES) throw new Error('文件超过 15 MB 上限')

        await mkdir(refDir(), { recursive: true })
        for (const old of await listAudio(refDir())) {
          await unlink(old).catch(() => {})
        }
        await writeFile(join(refDir(), `ref${suffix}`), buf)
        voiceCache = { path: '', mtime: 0, uri: '' }
        resultCache.clear()
        if (typeof api.saveSettings === 'function') api.saveSettings({ refAudio: `ref${suffix}`, refName: name })
        log(`参考音频已更新：${name}（${buf.length} 字节）`)
        return json(res, { ok: true, name, size: buf.length, saved: `ref${suffix}` })
      } catch (e) {
        return json(res, { ok: false, message: e?.message || String(e) })
      }
    })

    /** 切回内置预设。 */
    api.route('/use-preset', async (req, res) => {
      if (deniedUnlessSameOrigin(req, res, '切换预设音色')) return
      try {
        const q = api.core.http.query(req)
        const preset = basename(String(q.preset || ''))
        const p = join(presetDir(), preset)
        if (!existsSync(p)) throw new Error(`没有这个预设：${preset}（自带预设已撤下，请上传自己的参考音频）`)
        voiceCache = { path: '', mtime: 0, uri: '' }
        resultCache.clear()
        if (typeof api.saveSettings === 'function') {
          api.saveSettings({ refAudio: `preset:${preset}`, refName: labelOf(preset) })
        }
        return json(res, { ok: true, preset, name: labelOf(preset) })
      } catch (e) {
        return json(res, { ok: false, message: e?.message || String(e) })
      }
    })

    /** 试音：合一小段返回 base64，页面直接播放。 */
    api.route('/preview', async (req, res) => {
      try {
        const q = api.core.http.query(req)
        const text = String(q.text || '你好呀，我是大肥鱼').slice(0, 300)
        const cfg = settingsOf(api)
        const { raw, format } = await synthesize(text, cfg)
        return json(res, {
          ok: true,
          mime: format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
          audio: raw.toString('base64'),
          bytes: raw.length,
        })
      } catch (e) {
        return json(res, { ok: false, message: e?.message || String(e) })
      }
    })

    /** 当前参考音频试听。 */
    api.route('/ref-audio', async (req, res) => {
      if (deniedUnlessSameOriginRead(req, res, '读取参考音频')) return
      try {
        const cfg = settingsOf(api)
        const ref = await resolveRef(cfg)
        if (!ref) throw new Error('还没有参考音频，请先上传或恢复默认')
        const buf = await readFile(ref)
        return json(res, {
          ok: true,
          mime: mimeOf(extname(ref).toLowerCase()),
          name: basename(ref),
          audio: buf.toString('base64'),
        })
      } catch (e) {
        return json(res, { ok: false, message: e?.message || String(e) })
      }
    })

    /** 真发一条语音到自己私聊，验证发送链路。 */
    api.route('/selftest', async (req, res) => {
      try {
        const cfg = settingsOf(api)
        const pluginCfg = typeof api.config === 'function' ? api.config() : null
        const owner = String(pluginCfg?.ownerQQ || '')
        if (!owner) return json(res, { ok: false, message: '没配置主人 QQ，没法自测发送' })
        const r = await speakToFile('语音链路自检通过。', cfg)
        await api.sendVoiceFile(`private:${owner}`, r.file, '自检')
        return json(res, { ok: true, bytes: r.bytes, sentTo: `private:${owner}` })
      } catch (e) {
        return json(res, { ok: false, message: e?.message || String(e) })
      }
    })

    // -----------------------------------------------------------------------
    // 自检
    // -----------------------------------------------------------------------
    const cfg0 = settingsOf(api)
    const issues = []
    if (!cfg0.apiKey) issues.push('没填 API Key')
    if (cfg0.format === 'mp3') issues.push('选了 MP3（发之前会自动改用 WAV 合成）')
    resolveRef(cfg0).then((r) => {
      if (!r) warn('还没有参考音频：在面板上传 mp3/wav，或把文件放进模块的 assets/ 目录')
      log(
        `起来了 · 模型 ${cfg0.model} · 格式 ${cfg0.format} · 超时 ${cfg0.timeout}s` +
          (cfg0.autoVoice ? ` · 自动语音 ${Math.round(cfg0.voiceChance * 100)}%` : ' · 自动语音关') +
          (issues.length ? ` · 待处理：${issues.join('；')}` : ' · 配置完整'),
      )
    })

    // -----------------------------------------------------------------------
    // 接管内置语音时用的接口
    // -----------------------------------------------------------------------
    // 内置 voice 模块的 setup 返回 { speak, edgeInstalled }，聊天中枢发语音条时
    // 就是调 api.use('voice').speak(text) 拿 { file, engine }。
    // 把本模块改名成 voice 之后，必须补上同一个接口，否则中枢调到的就是 undefined
    // —— 光改目录名和 id 只是能加载，真正「接管」靠的是这个 speak。
    async function speak(text) {
      const cfg = settingsOf(api)
      if (!cfg.apiKey) throw new Error('还没有填 MiMo API Key，请在面板里填好并保存')
      if (!String(text || '').trim()) throw new Error('要念的文字是空的')
      const r = await speakToFile(String(text), cfg)
      return { file: r.file, engine: 'mimo' }
    }

    // 只有自己确实是 voice 才把接口挂出去；平时（id 还是 aura-mimo）返回空，
    // 不影响任何现有行为，也不会和内置 voice 抢。
    return PLUGIN_ID === 'voice' ? { speak } : undefined
  },
}
