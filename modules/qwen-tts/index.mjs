// 百炼语音设置：把 local/tts.config.json 里正在用的真实参数搬到面板「语音」页。
//
// 为什么要有这个模块：语音现在由 local/tts.mjs 这个本地脚本接管，内置「语音」页只认
// voice.engine 那一套（edge-tts / CosyVoice / GPT-SoVITS），看不到百炼的真实参数，
// 于是面板上显示的跟实际在跑的对不上。这里直接读那份配置，原样呈现、就地改、能试听。
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, copyFileSync, constants } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'qwen-tts'

/** 不进面板的键（敏感） */
const SECRET = ['apiKey']

const maskKey = (k) => {
  const s = String(k || '')
  return s ? '已配置' : ''
}

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

function deepMerge(base, over) {
  const out = { ...(isObj(base) ? base : {}) }
  for (const [k, v] of Object.entries(isObj(over) ? over : {})) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v
  }
  return out
}

/** 人话摘要，面板顶部那张表用 */
function summarize(c) {
  const f = c.filters || {}
  return [
    { k: '走的哪家', v: '阿里云百炼 DashScope（本地脚本接管）' },
    { k: '域名', v: c.baseUrl || '（空）' },
    { k: 'API Key', v: c.apiKey ? `已配置（${String(c.apiKey).length} 位）` : '❌ 没有' },
    { k: '模型', v: c.model || '（空）' },
    { k: '音色', v: c.voice || '（空 → 用官方默认 Cherry）' },
    { k: '输出', v: `${c.format || 'wav'} · ${c.sampleRate || 24000} Hz` },
    { k: '语速', v: String(c.speechRate ?? 1) },
    { k: '语气基底 instruction', v: c.instruction || '（空，会用默认）' },
    { k: 'seed', v: c.seed == null ? '（未设）' : String(c.seed) },
    { k: '分段上限', v: `${c.maxCharsPerSegment || 300} 字` },
    { k: '缓存', v: c.cache === false ? '关' : '开' },
    { k: '音频层', v: f.enabled === false ? '关（发原声）' : `开 · ${f.preset || 'medium'} · 结尾留白 ${f.tailPad ?? 0} 秒` },
    { k: 'ffmpeg', v: f.ffmpeg || '自动找' },
  ]
}

export default {
  id: ID,
  name: '百炼语音设置',
  version: '1.0.0',
  api: 1,
  description: '看、改、试听 local/tts.mjs 正在用的百炼语音参数',
  tab: 'voice',
  panel: 'panel.js',

  setup(api) {
    // modules-data/<id> → plugins-data/aurabot → local
    const localDir = join(api.dataDir(), '..', '..', 'local')
    const configPath = join(localDir, 'tts.config.json')

    const read = () => {
      if (!existsSync(configPath)) return {}
      try {
        return JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
      } catch {
        return {}
      }
    }

    const clientConfig = () => {
      const c = read()
      const out = {}
      for (const [k, v] of Object.entries(c)) out[k] = SECRET.includes(k) ? maskKey(v) : v
      out.apiKeySet = Boolean(c.apiKey)
      return out
    }

    // 用户主动安装；绝不覆盖已有的本地接口。
    api.route('/install', async (req) => {
      if (req?.method !== 'POST') return { ok: false, message: '需要 POST 请求' }
      try {
        mkdirSync(localDir, { recursive: true })
        copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'tts.mjs'), join(localDir, 'tts.mjs'), constants.COPYFILE_EXCL)
        return { ok: true, message: '脚本已安装，请在本地接口页开启语音' }
      } catch (error) { return { ok: false, message: error.code === 'EEXIST' ? '已有本地语音脚本，请先自行备份和移走，不会自动覆盖' : '安装脚本失败：' + error.message } }
    })
    api.route('/get', async () => {
      const c = read()
      return {
        ok: true,
        path: configPath,
        exists: existsSync(configPath),
        config: clientConfig(),
        summary: summarize(c),
        ttsScript: existsSync(join(localDir, 'tts.mjs')),
        updatedAt: existsSync(configPath) ? statSync(configPath).mtimeMs : 0,
      }
    })

    api.route('/set', async (req) => {
      const body = (await api.core.http.body(req)) || {}
      const patch = isObj(body.patch) ? body.patch : {}
      const cur = read()
      const clean = JSON.parse(JSON.stringify(patch))
      if ('apiKey' in clean && !String(clean.apiKey || '').trim()) delete clean.apiKey
      for (const k of ['speechRate', 'sampleRate', 'maxCharsPerSegment', 'timeoutMs', 'retries', 'seed']) {
        if (k in clean && clean[k] !== '' && clean[k] !== null) {
          const n = Number(clean[k])
          if (Number.isFinite(n)) clean[k] = n
          else delete clean[k]
        }
      }
      if (isObj(clean.filters)) {
        if ('tailPad' in clean.filters) {
          const n = Number(clean.filters.tailPad)
          clean.filters.tailPad = Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 0
        }
        if ('enabled' in clean.filters) clean.filters.enabled = Boolean(clean.filters.enabled)
      }
      const next = deepMerge(cur, clean)
      try {
        writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
      } catch (error) {
        return { ok: false, message: `写配置失败：${error.message}` }
      }
      return { ok: true, message: '存好了，下一条语音就用新参数', config: clientConfig(), summary: summarize(next) }
    })

    // 试听：合成一句，把 wav 用 base64 回给面板直接播
    api.route('/test', async (req) => {
      const body = (await api.core.http.body(req)) || {}
      const text = String(body.text || '那我先撤了啊，明天再战。').slice(0, 120)
      const local = api.core.local
      if (!local?.active?.('tts')) return { ok: false, message: '本地 tts.mjs 没启用，或文件不在 local 目录' }
      try {
        const file = await local.call('tts', { text })
        if (!file || !existsSync(file)) return { ok: false, message: '脚本跑完了但没返回文件' }
        const buf = readFileSync(file)
        return { ok: true, mime: 'audio/wav', data: buf.toString('base64'), bytes: buf.length, seconds: wavSeconds(buf) }
      } catch (error) {
        return { ok: false, message: String(error?.message || error) }
      }
    })

    // 发到 QQ：试听满意了就发到主人私聊
    api.route('/send', async (req) => {
      const body = (await api.core.http.body(req)) || {}
      const text = String(body.text || '那我先撤了啊，明天再战。').slice(0, 200)
      const cfg = api.config()
      const local = api.core.local
      if (!local?.active?.('tts')) return { ok: false, message: '本地 tts.mjs 没启用，或文件不在 local 目录' }
      try {
        const file = await local.call('tts', { text })
        if (!file || !existsSync(file)) return { ok: false, message: '脚本跑完了但没返回文件' }
        await api.sendVoiceFile('private:' + cfg.ownerQQ, file, '面板试听')
        return { ok: true, message: '发到 QQ 了' }
      } catch (error) {
        return { ok: false, message: String(error?.message || error) }
      }
    })

    // 问百炼要音色列表，方便确认现在用的是哪一个
    api.route('/voices', async () => {
      const c = read()
      if (!c.apiKey) return { ok: false, message: '还没填 API Key' }
      const base = String(c.baseUrl || '').replace(/\/+$/, '')
      if (!base) return { ok: false, message: '还没填域名' }
      try {
        const r = await fetch(`${base}/api/v1/services/audio/tts/customization`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
          body: JSON.stringify({ model: 'voice-enrollment', input: { action: 'list_voice' } }),
          signal: AbortSignal.timeout(20000),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) return { ok: false, message: `查音色失败（HTTP ${r.status}）` }
        const arr = j?.output?.voice_list || j?.data?.voice_list || []
        return {
          ok: true,
          current: c.voice || '',
          list: arr
            .map((x) => ({ voice: x.voice_id || x.voice || '', name: x.voice_name || x.name || '', status: x.status || '' }))
            .filter((x) => x.voice),
        }
      } catch (error) {
        return { ok: false, message: `查音色出错：${error.message}` }
      }
    })

    api.route('/files', async () => {
      const outDir = join(localDir, 'out')
      let files = []
      try {
        files = readdirSync(outDir)
          .filter((f) => /\.(wav|mp3)$/i.test(f))
          .map((f) => {
            const st = statSync(join(outDir, f))
            return { name: f, at: st.mtimeMs, size: st.size }
          })
          .sort((a, b) => b.at - a.at)
          .slice(0, 12)
      } catch {}
      return { ok: true, dir: outDir, files }
    })

    return { configPath, read }
  },
}

/** WAV 时长：百炼返回的 data 块长度字段是假的（0x7fffffxx），按实际文件长度算。 */
function wavSeconds(buf) {
  try {
    if (buf.toString('ascii', 0, 4) !== 'RIFF') return 0
    let off = 12
    let rate = 24000
    let ch = 1
    let bits = 16
    let dataLen = 0
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const sz = buf.readUInt32LE(off + 4)
      if (id === 'fmt ') {
        ch = buf.readUInt16LE(off + 10)
        rate = buf.readUInt32LE(off + 12)
        bits = buf.readUInt16LE(off + 22)
      } else if (id === 'data') {
        dataLen = Math.min(sz, buf.length - off - 8)
        break
      }
      if (sz <= 0) break
      off += 8 + sz + (sz & 1)
    }
    return dataLen / (rate * ch * (bits / 8))
  } catch {
    return 0
  }
}
