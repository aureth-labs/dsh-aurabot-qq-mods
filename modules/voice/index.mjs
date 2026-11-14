/**
 * 豆包语音 2.0（AuraBot 扩展模块）
 *
 * 与内置 voice 模块同名，接管它的 speak(text) → { file, engine }。
 * 合成失败自动退回 edge-tts / Windows 语音，不会让她突然不会说话。
 */

import { readFileSync } from 'node:fs'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const API_BASE = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'

const DEFAULTS = {
  apiKey: '',
  resourceId: 'seed-icl-2.0',
  speaker: 'S_1CmxEOek2',
  speechRate: 0,
  contextTexts: '',
  autoEmotion: true,
  timeout: 60,
}

const SETTINGS = [
  { key: 'apiKey', label: '豆包语音 API Key', type: 'password', default: '', hint: '火山引擎「豆包语音」控制台创建，请求头 X-Api-Key' },
  {
    key: 'resourceId',
    label: '资源 ID',
    type: 'select',
    default: 'seed-icl-2.0',
    options: [
      { value: 'seed-icl-2.0', label: '声音复刻 2.0' },
      { value: 'seed-tts-2.0', label: '预置音色 2.0' },
    ],
    hint: '复刻音色只能用 seed-icl-2.0，用错会报 55000000',
  },
  { key: 'speaker', label: '音色 Speaker', type: 'text', default: 'S_1CmxEOek2', hint: '复刻音色 ID；预置 2.0 音色以 _uranus_bigtts 结尾' },
  { key: 'speechRate', label: '语速', type: 'number', default: 0, min: -50, max: 100, step: 5, hint: '默认 0；觉得快就调 -10 到 -20，改完下一条语音生效' },
  { key: 'contextTexts', label: '固定语气指令', type: 'textarea', default: '', hint: '一行一条，例如「用温柔、放慢一点的语气说这句话」；留空不加' },
  { key: 'autoEmotion', label: '按文字自动配语气', type: 'switch', default: true, hint: '按关键词自动追加语气指令，不参与计费' },
  { key: 'timeout', label: '超时（秒）', type: 'number', default: 60, min: 5, max: 300, step: 5 },
]

const EMOTION_RULES = [
  [['哭', '难过', '伤心', '委屈', '失落', '心碎', '难受', '呜呜', '唉'], '用低落、难过、带一点鼻音的语气说这句话'],
  [['生气', '气死', '烦死', '讨厌', '滚', '闭嘴', '过分', '凭什么', '怒了'], '用生气、急躁、带一点责备的语气说这句话'],
  [['开心', '高兴', '太好了', '哈哈', '笑死', '棒', '嘿嘿', '耶', '爽'], '用开心、轻快、带笑意的语气说这句话'],
  [['撒娇', '不要嘛', '人家', '抱抱', '哼', '好不好嘛', '陪我'], '用撒娇、软糯一点的语气说这句话'],
  [['害怕', '恐怖', '吓死', '紧张', '慌了', '担心'], '用紧张、放轻、带一点害怕的语气说这句话'],
  [['别怕', '没事的', '我在', '乖', '安慰', '心疼'], '用温柔、安慰、放慢一点的语气说这句话'],
  [['温柔', '宠溺', '哄哄我', '轻声'], '用温柔、宠溺、放慢一点的语气说这句话'],
  [['夹子音', '萝莉音', '少女音', '御姐音'], '用更甜美、轻柔、带点夹子音的语气说这句话'],
  [['严肃', '冷静', '正经', '好好说'], '用冷静、平稳、认真的语气说这句话'],
  [['惊讶', '真的假的', '居然', '不会吧', '卧槽', '哇'], '用惊讶、语调上扬的语气说这句话'],
]

export default {
  id: 'voice',
  name: '豆包语音 2.0',
  version: '1.0.0',
  api: 1,
  description: '用豆包语音 2.0 复刻音色把她的回复念成语音条，接管内置语音',
  tab: 'voice',
  defaults: { ...DEFAULTS },
  settings: SETTINGS,

  setup(api) {
    const { hub, onebot, http } = api.core
    const { textToSpeech, installEdge, edgeInstalled, voiceConverters } = api.lib('voice/tts.js')
    const { toMono16k } = api.lib('voice/wav.js')

    const outDir = () => api.dataDir('out')
    let last = null

    const settingsOf = () => ({ ...DEFAULTS, ...(api.settings() || {}) })

    function inferEmotion(text) {
      let best = ''
      let bestScore = 0
      for (const [words, hint] of EMOTION_RULES) {
        let score = 0
        for (const w of words) {
          let i = 0
          while ((i = text.indexOf(w, i)) !== -1) {
            score++
            i += w.length
          }
        }
        if (score > bestScore) {
          best = hint
          bestScore = score
        }
      }
      return best
    }

    // 流式 WAV 的 RIFF/data 长度是 0xFFFFFFFF，回填真实长度，否则部分播放器读不出时长
    function fixWavHeader(buf) {
      if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf
      buf.writeUInt32LE(buf.length - 8, 4)
      const pos = buf.indexOf(Buffer.from('data'))
      if (pos !== -1 && buf.length >= pos + 8) buf.writeUInt32LE(buf.length - pos - 8, pos + 4)
      return buf
    }

    async function synthesize(text) {
      const cfg = settingsOf()
      const key = String(cfg.apiKey || '').trim()
      if (!key) throw new Error('还没有填豆包语音 API Key')

      const instructions = String(cfg.contextTexts || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (cfg.autoEmotion) {
        const hint = inferEmotion(text)
        if (hint) instructions.push(hint)
      }

      const req = {
        text,
        speaker: String(cfg.speaker || DEFAULTS.speaker).trim(),
        audio_params: {
          format: 'wav',
          sample_rate: 24000,
          speech_rate: Math.max(-50, Math.min(100, Math.round(Number(cfg.speechRate) || 0))),
        },
      }
      if (instructions.length) req.context_texts = instructions

      const timeoutMs = Math.max(5, Number(cfg.timeout) || 60) * 1000
      const res = await fetch(API_BASE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Api-Key': key,
          'X-Api-Resource-Id': String(cfg.resourceId || DEFAULTS.resourceId),
          'X-Api-Connect-Id': randomUUID(),
        },
        body: JSON.stringify({ user: { uid: 'aurabot' }, req_params: req }),
        signal: AbortSignal.timeout(timeoutMs),
      })

      const raw = await res.text()
      if (!res.ok) {
        const logid = res.headers.get('x-tt-logid') || ''
        throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}${logid ? ` (logid=${logid})` : ''}`)
      }

      const chunks = []
      let message = ''
      for (const line of raw.split(/\r?\n/)) {
        const s = line.trim()
        if (!s) continue
        let item = null
        try {
          item = JSON.parse(s)
        } catch {
          continue
        }
        if (item.code !== 0 && item.code != null && !item.data) {
          message = `code=${item.code} ${item.message || ''}`
          continue
        }
        if (item.data) chunks.push(Buffer.from(String(item.data), 'base64'))
      }

      const audio = Buffer.concat(chunks)
      if (!audio.length) throw new Error(`没有返回音频${message ? `：${message}` : `：${raw.slice(0, 200)}`}`)
      return fixWavHeader(audio)
    }

    async function pruneOut(keep = 40) {
      try {
        const names = await readdir(outDir())
        if (names.length <= keep) return
        const items = await Promise.all(
          names.map(async (n) => ({ n, m: (await stat(join(outDir(), n)).catch(() => null))?.mtimeMs || 0 })),
        )
        items.sort((a, b) => b.m - a.m)
        for (const it of items.slice(keep)) await unlink(join(outDir(), it.n)).catch(() => {})
      } catch {
        // 目录还不存在
      }
    }

    async function saveAudio(audio) {
      await mkdir(outDir(), { recursive: true })
      const file = join(outDir(), `doubao_${Date.now()}_${randomUUID().slice(0, 8)}.wav`)
      await writeFile(file, audio)
      pruneOut().catch(() => {})
      return { file, bytes: audio.length }
    }

    async function applyConverters(file) {
      for (const conv of voiceConverters) {
        try {
          file = await conv(file)
        } catch (error) {
          api.log.warn('变声失败，用原声：', error.message)
        }
      }
      return file
    }

    async function speak(text) {
      const clean = String(text || '').trim()
      if (!clean) throw new Error('要念的文字是空的')
      const started = Date.now()
      try {
        const { file, bytes } = await saveAudio(await synthesize(clean))
        const out = await applyConverters(file)
        last = { ok: true, at: started, ms: Date.now() - started, engine: 'doubao', bytes }
        return { file: out, engine: 'doubao' }
      } catch (error) {
        last = { ok: false, at: started, ms: Date.now() - started, engine: 'fallback', error: String(error.message || error) }
        api.log.warn('豆包语音失败，退回本机语音：', error.message)
        return textToSpeech(clean, { engine: 'auto' }, api.log)
      }
    }

    // 翻唱模块里选过音色的话，语音条照样变声（和内置 voice 行为一致）
    const { createSongVoice } = api.lib('voice/rvc.js')
    const songVoice = createSongVoice({ getConfig: api.config, getSong: () => api.use('song'), dataDir: api.dataDir, log: api.log })
    voiceConverters.push(songVoice)
    api.onDispose(() => {
      const i = voiceConverters.indexOf(songVoice)
      if (i >= 0) voiceConverters.splice(i, 1)
    })

    // ---------- 面板「语音」页用到的接口（与内置 voice 保持一致） ----------

    api.route('/voice/song-voices', async () => {
      const song = api.use('song')
      if (!song || typeof song.status !== 'function') return { ok: true, available: false, voices: [], message: '翻唱模块没在跑' }
      try {
        const st = song.status()
        return { ok: true, available: Boolean(st.ready), ready: Boolean(st.ready), voices: st.voices || [], selected: api.config().voice.songVoice || '', message: st.message || '' }
      } catch (error) {
        return { ok: false, available: false, voices: [], message: String(error.message || error) }
      }
    })

    api.route('/voice/test', async (req) => {
      const b = await http.body(req)
      const { file, engine } = await speak(String(b.text || '你好呀，我是大肥鱼'))
      const buf = readFileSync(file)
      return { ok: true, engine, mime: file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', data: buf.toString('base64') }
    })

    api.route('/voice/install', async () => installEdge(api.log))

    api.route('/voice/doubao-status', async () => {
      const cfg = settingsOf()
      return {
        ok: true,
        keySet: Boolean(String(cfg.apiKey || '').trim()),
        speaker: cfg.speaker,
        resourceId: cfg.resourceId,
        speechRate: Number(cfg.speechRate) || 0,
        autoEmotion: Boolean(cfg.autoEmotion),
        fixedInstructions: String(cfg.contextTexts || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
        last,
      }
    })

    const stt = () => api.dsh.get('speechToText')
    api.route('/voice/asr-status', async () => {
      const s0 = stt()
      if (!s0 || typeof s0.snapshot !== 'function') return { ok: false, enabled: false, message: 'DSH 里没有开启「语音输入」插件' }
      const s = s0.snapshot()
      const p = s.providers.find((x) => x.id === s.selection.providerId) || s.providers[0]
      return { ok: true, enabled: true, provider: p?.id, phase: p?.preparation?.phase || 'ready', detail: p?.preparation }
    })
    api.route('/voice/asr-prepare', async () => {
      const s0 = stt()
      if (!s0 || typeof s0.snapshot !== 'function') return { ok: false, message: 'DSH 里没有开启「语音输入」插件' }
      s0.prepare(s0.snapshot().selection.providerId)
      return { ok: true, message: '开始下载识别模型（约 200MB，下好后常驻本机）' }
    })
    api.route('/voice/asr-last', async (req) => {
      const b = await http.body(req)
      const uid = Number(b.userId || api.config().ownerQQ)
      const h = await onebot.call('get_friend_msg_history', { user_id: uid, count: 30 })
      const recs = (h?.messages || []).filter((m) => String(m.user_id) === String(uid)).flatMap((m) => (m.message || []).filter((s) => s.type === 'record').map((s) => ({ seg: s, time: m.time })))
      const lastRec = recs.at(-1)
      if (!lastRec) return { ok: false, message: '最近的聊天里没有对方发的语音' }
      const t = Date.now()
      const text = await hub.localTranscribe(lastRec.seg)
      return { ok: Boolean(text), heard: text, at: new Date(lastRec.time * 1000).toLocaleString(), ms: Date.now() - t }
    })
    api.route('/voice/asr-test', async (req) => {
      const b = await http.body(req)
      const s0 = stt()
      if (!s0 || typeof s0.resolve !== 'function') return { ok: false, message: 'DSH 里没有开启语音识别（设置 → 插件 → 语音输入）' }
      const text = String(b.text || '今天想吃白米饭')
      const { file } = await textToSpeech(text, { engine: 'windows' })
      const t = Date.now()
      const spec = s0.resolve({ audio: new Uint8Array(toMono16k(readFileSync(file))) })
      const r = await s0.transcribe(spec, AbortSignal.timeout(120000))
      const heard = typeof r === 'string' ? r : r?.text || r?.transcript || JSON.stringify(r)
      return { ok: Boolean(heard), said: text, heard, ms: Date.now() - t }
    })

    const boot = settingsOf()
    api.log.info(`豆包语音已接管内置语音 · ${boot.speaker} · ${String(boot.apiKey || '').trim() ? '已配置 Key' : '还没填 API Key'}`)

    return { speak, edgeInstalled }
  },
}
