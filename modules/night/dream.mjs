// 梦：睡着以后按 REM 阶段生成，醒来只剩强度和碎片。
//
// 设计要点：
// - 五档强度 1~5，越强记得越久（每天衰减 0.30 / 0.22 / 0.15 / 0.08 / 0.03）
// - 梦不是现实：只写进私人梦境记录，往记忆里只留一句「做过梦」，不写内容
// - 生成失败不补、不重试，跳过这一次

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const LEVEL_DECAY = { 1: 0.3, 2: 0.22, 3: 0.15, 4: 0.08, 5: 0.03 }
export const LEVEL_CN = { 1: '很淡', 2: '零碎', 3: '清楚', 4: '强烈', 5: '忘不掉' }
export const MAX_KEEP = 200
export const EXPIRE_AT = 0.15

const BUILTIN_TAGS = ['旧房子', '走不完的路', '熟人', '水', '飞', '找东西', '错过', '小时候', '雨', '光']

const PROMPT = `你在做梦。梦是碎的、跳的、不讲逻辑的，但情绪是真的。

你记得的碎片：
{fragments}

{continuation}情绪底色：{mood}

写一段 300~500 字的梦，第一人称，像醒来后还能记住的那种：
- 不要解释「这是梦」，不要总结寓意
- 可以有具体的画面、声音、身体感觉
- 结尾停在半截，别圆满收尾

只输出一个 JSON 对象，不要代码块，不要别的话：
{{"text": "梦的内容", "level": 1, "tags": ["标签1", "标签2"]}}
level 是这段梦的强度：1 醒来就忘，3 能记住大概，5 一整天都忘不掉。`

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const randomOf = (list) => list[Math.floor(Math.random() * list.length)]

function loadJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export class Dreamer {
  constructor({ api, cfgOf, log }) {
    this.api = api
    this.cfgOf = cfgOf
    this.log = log
    this.file = api.dataDir('dreams.json')
    mkdirSync(dirname(this.file), { recursive: true })
    this.items = []
    this.load()
  }

  get cfg() {
    return this.cfgOf()
  }

  load() {
    const raw = loadJson(this.file, [])
    this.items = Array.isArray(raw) ? raw.filter((x) => x && x.id && x.text) : []
  }

  save() {
    try {
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      this.log.warn('保存梦境失败：' + (error?.message || error))
    }
  }

  // ------------------------------------------------------------ 衰减
  strengthOf(dream, now = Date.now()) {
    if (!dream) return 0
    if (dream.pinned) return 1
    const base = num(dream.strength, 1)
    const days = Math.max(0, (now - num(dream.decayAt, dream.createdAt || now)) / 86400000)
    return clamp(base - (num(dream.decayPerDay, 0.15) * days), 0, 1)
  }

  living(now = Date.now()) {
    return this.items
      .filter((d) => this.strengthOf(d, now) > EXPIRE_AT)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  byId(id, now = Date.now()) {
    const dream = this.items.find((d) => d.id === id)
    if (!dream) return null
    return { ...dream, strength: this.strengthOf(dream, now) }
  }

  stats() {
    const alive = this.living()
    const byLevel = {}
    for (let i = 1; i <= 5; i += 1) byLevel[i] = alive.filter((d) => d.level === i).length
    return { total: this.items.length, living: alive.length, byLevel }
  }

  // ------------------------------------------------------------ 时机
  due({ sleepAt = 0, already = 0, stage = null, dreamSkip = false, now = Date.now() } = {}) {
    const cfg = this.cfg
    if (!cfg.dreamEnabled || !sleepAt) return false
    if (dreamSkip) return false
    if (cfg.dreamInRemOnly && stage && stage.key !== 'rem') return false
    if (cfg.dreamInRemOnly && !stage) return false
    const maxPerSleep = Math.max(1, num(cfg.dreamMaxPerSleep, 8))
    if (already >= maxPerSleep) return false
    const startAfter = Math.max(1, num(cfg.dreamStartAfterMinutes, 60)) * 60_000
    if (now - sleepAt < startAfter) return false
    const interval = Math.max(5, num(cfg.dreamIntervalMinutes, 60)) * 60_000
    const last = this.items.reduce((max, d) => Math.max(max, num(d.createdAt, 0)), 0)
    if (last && now - last < interval) return false
    return true
  }

  // ------------------------------------------------------------ 生成
  fragments() {
    try {
      const memory = this.api.use('memory')
      const items = memory?.list?.('') || []
      const pool = items
        .filter((item) => item && typeof item.text === 'string')
        .filter((item) => !/梦/.test(String(item.text).slice(0, 4)))
        .filter((item) => item.text.length >= 6 && item.text.length <= 90)
      const picked = []
      const used = new Set()
      for (let i = 0; i < 40 && picked.length < 5 && pool.length; i += 1) {
        const item = randomOf(pool)
        if (used.has(item.id)) continue
        used.add(item.id)
        picked.push(String(item.text).replace(/\s+/g, ' ').trim())
      }
      return picked
    } catch {
      return []
    }
  }

  async make({ kind = 'night', mood = '', continuation = '', persist = true } = {}) {
    const cfg = this.cfg
    if (!cfg.dreamEnabled) return null
    const fragments = this.fragments()
    const tags = (Array.isArray(cfg.dreamTags) ? cfg.dreamTags : String(cfg.dreamTags || '').split(/[,，\n]/))
      .map((x) => String(x).trim())
      .filter(Boolean)
    const pool = tags.length ? tags : BUILTIN_TAGS
    const moodText = mood || randomOf(pool)

    const prompt = PROMPT
      .replace('{fragments}', fragments.length ? fragments.map((f) => `- ${f}`).join('\n') : '- （今晚没有想起什么具体的事）')
      .replace('{continuation}', continuation ? `这是刚才那个梦的延续，接着往下写：\n${continuation}\n\n` : '')
      .replace('{mood}', moodText)

    let raw = ''
    try {
      raw = await this.api.ask({
        system: '你是一个正在做梦的人。你只输出一个 JSON 对象，不要解释，不要代码块。',
        text: prompt,
        maxTokens: 900,
      })
    } catch (error) {
      this.log.warn('做梦失败：' + (error?.message || error))
      return null
    }

    const data = extractJson(raw)
    const text = String(data?.text || '').trim()
    if (!text) return null
    const level = clamp(Math.round(num(data?.level, 3)), 1, 5)
    const dreamTags = Array.isArray(data?.tags)
      ? data.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
      : [moodText]

    const now = Date.now()
    const entry = {
      id: `dream_${Math.floor(now / 1000)}_${Math.random().toString(16).slice(2, 8)}`,
      createdAt: now,
      kind,
      level,
      tags: dreamTags,
      text: text.slice(0, 2000),
      strength: 1,
      decayPerDay: LEVEL_DECAY[level] || 0.15,
      decayAt: now,
      pinned: false,
    }
    if (!persist) return entry

    this.items.push(entry)
    // 只留最近的 200 条，先扔过期最久的
    this.items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    if (this.items.length > MAX_KEEP) this.items = this.items.slice(0, MAX_KEEP)
    this.save()

    try {
      const memory = this.api.use('memory')
      memory?.addEvent?.({
        text: '我昨晚做了一段梦（内容只留在私人梦境记录里，不当作现实）',
        tags: ['梦'],
        importance: Math.min(1, 0.2 * level),
      })
    } catch {
      // 记忆模块没开就不记
    }

    this.log.info(`长夜：做了一段梦（${level} 级，${dreamTags.join('、')}）`)
    return entry
  }

  // ------------------------------------------------------------ 醒来
  pickMorning({ since = 0, until = Date.now() } = {}) {
    const cfg = this.cfg
    if (!cfg.dreamEnabled) return null
    const pool = this.items.filter((d) => {
      const at = num(d.createdAt, 0)
      return at >= since && at <= until && this.strengthOf(d, until) > 0.2
    })
    if (!pool.length) return null
    // 强梦更容易被记住
    pool.sort((a, b) => (b.level || 0) - (a.level || 0))
    const top = pool[0]
    const chance = top.level >= 4 ? 0.85 : 0.45
    return Math.random() < chance ? top : null
  }

  recall(query = '', limit = 5) {
    const q = String(query || '').trim()
    const alive = this.living()
    if (!q) return alive.slice(0, limit)
    return alive
      .map((d) => {
        const inText = String(d.text).includes(q) ? 3 : 0
        const inTag = (d.tags || []).some((t) => q.includes(t)) ? 2 : 0
        return { d, score: inText + inTag }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.d)
  }

  setPinned(id, pinned) {
    const dream = this.items.find((d) => d.id === id)
    if (!dream) return false
    dream.pinned = Boolean(pinned)
    if (dream.pinned) dream.strength = 1
    this.save()
    return true
  }

  remove(id) {
    const before = this.items.length
    this.items = this.items.filter((d) => d.id !== id)
    if (this.items.length === before) return false
    this.save()
    return true
  }
}

function extractJson(text) {
  if (!text) return null
  const match = String(text).match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const data = JSON.parse(match[0])
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}
