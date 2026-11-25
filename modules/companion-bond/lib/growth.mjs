// 纯状态逻辑；不读聊天记录，不调用模型。所有时间由调用方传入，方便验证。
import { createHash } from 'node:crypto'

const HOUR = 3_600_000
const TYPES = ['chat', 'feed', 'play', 'touch']
export const DEFAULTS = { chatCooldownSeconds: 30, chatDailyLimit: 60, allowGroups: false }
export const RULES = {
  chat: { xp: 1, bond: 1, cooldown: 30_000, limit: 60 },
  feed: { xp: 8, bond: 5, cooldown: 30 * 60_000, limit: 4 },
  play: { xp: 6, bond: 4, cooldown: 10 * 60_000, limit: 6 },
  touch: { xp: 2, bond: 2, cooldown: 5 * 60_000, limit: 12 },
}
export const LABELS = { chat: '聊天', feed: '投喂', play: '玩耍', touch: '摸摸', sleep: '休息', wake: '醒来' }
export const STAGES = [[0, '初识'], [30, '熟悉'], [100, '亲近'], [250, '默契'], [600, '深厚']]
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n))
const number = (n, fallback = 0) => Number.isFinite(n) ? n : fallback
const counts = (raw = {}) => Object.fromEntries(TYPES.map(k => [k, Math.max(0, Math.floor(number(raw?.[k])))]))
export const dayOf = now => new Date(now + 8 * HOUR).toISOString().slice(0, 10)

export function settings(raw = {}) {
  return {
    chatCooldownSeconds: clamp(number(raw.chatCooldownSeconds, 30), 0, 3600),
    chatDailyLimit: Math.floor(clamp(number(raw.chatDailyLimit, 60), 0, 1000)),
    allowGroups: raw.allowGroups === true,
  }
}

export function createState(now) {
  return {
    schema: 1, createdAt: now, updatedAt: now, xp: 0, bond: 0,
    energy: 80, joy: 65, sleeping: false,
    day: dayOf(now), daily: counts(), totals: counts(), last: counts(),
    seenMessages: [], seenFeed: [], feedSince: now, events: [],
  }
}

export function loadState(raw, now) {
  if (!raw || raw.schema !== 1 || !Number.isFinite(raw.xp) || !Number.isFinite(raw.bond)) {
    throw new Error('养成存档格式不受支持，请保留原文件后检查；没有自动重置。')
  }
  const s = createState(now)
  for (const key of ['createdAt', 'updatedAt', 'feedSince']) s[key] = Math.max(0, number(raw[key], now))
  s.xp = Math.floor(clamp(raw.xp, 0, 1_000_000_000))
  s.bond = Math.floor(clamp(raw.bond, 0, 1000))
  s.energy = clamp(number(raw.energy, 80), 0, 100)
  s.joy = clamp(number(raw.joy, 65), 0, 100)
  s.sleeping = raw.sleeping === true
  s.day = /^\d{4}-\d{2}-\d{2}$/.test(raw.day) ? raw.day : s.day
  for (const key of ['daily', 'totals', 'last']) s[key] = counts(raw[key])
  for (const key of ['seenMessages', 'seenFeed']) {
    s[key] = (Array.isArray(raw[key]) ? raw[key] : []).filter(x => typeof x === 'string').slice(-128)
  }
  s.events = (Array.isArray(raw.events) ? raw.events : [])
    .filter(e => e && LABELS[e.kind] && Number.isFinite(e.at))
    .slice(-20).map(e => ({ kind: e.kind, at: e.at, bond: number(e.bond), xp: number(e.xp) }))
  return s
}

export function advance(s, now) {
  // 时钟回拨不倒扣状态；离线期间只改变精神、心情，不扣亲密度。
  const elapsed = Math.max(0, now - s.updatedAt) / HOUR
  s.energy = clamp(s.energy + elapsed * (s.sleeping ? 12 : -2), 20, 100)
  s.joy = 60 + (s.joy - 60) * 2 ** (-elapsed / 12)
  s.updatedAt = Math.max(s.updatedAt, now)
  if (s.day !== dayOf(now)) { s.day = dayOf(now); s.daily = counts() }
  return s
}

export function addEvent(s, kind, now, bond = 0, xp = 0) {
  s.events.push({ kind, at: now, bond, xp })
  s.events = s.events.slice(-20)
}

export function interact(s, kind, now, rawSettings = {}) {
  advance(s, now)
  if (kind === 'sleep' || kind === 'wake') {
    const asleep = kind === 'sleep'
    if (s.sleeping === asleep) return { ok: false, message: asleep ? '她已经在休息了。' : '她现在醒着呢。' }
    s.sleeping = asleep
    addEvent(s, kind, now)
    return { ok: true, message: asleep ? '她开始休息，精神会随时间慢慢恢复。' : '她醒来了，可以继续一起玩。' }
  }
  const rule = RULES[kind]
  if (!rule) return { ok: false, message: '没有这个互动，请发送“养成帮助”。' }
  const cfg = settings(rawSettings)
  const cooldown = kind === 'chat' ? cfg.chatCooldownSeconds * 1000 : rule.cooldown
  const limit = kind === 'chat' ? cfg.chatDailyLimit : rule.limit
  if (s.daily[kind] >= limit) return { ok: false, message: '今天这项互动的成长奖励已经领完了，仍然可以正常聊天。' }
  const left = s.last[kind] ? cooldown - (now - s.last[kind]) : 0
  if (left > 0) return { ok: false, message: `刚互动过，约 ${Math.ceil(left / 60_000)} 分钟后再来。` }
  if (kind === 'play' && s.sleeping) return { ok: false, message: '她正在休息，醒来后再一起玩吧。' }
  if (kind === 'play' && s.energy < 35) return { ok: false, message: '她有些累了，先让她休息一会儿。' }
  const bondGain = Math.min(1000 - s.bond, rule.bond)
  s.xp += rule.xp
  s.bond += bondGain
  s.daily[kind]++
  s.totals[kind]++
  s.last[kind] = now
  if (kind === 'play') { s.energy = Math.max(20, s.energy - 12); s.joy = Math.min(100, s.joy + 12) }
  if (kind === 'touch') s.joy = Math.min(100, s.joy + 4)
  if (kind === 'feed') s.joy = Math.min(100, s.joy + 5)
  addEvent(s, kind, now, bondGain, rule.xp)
  return { ok: true, message: `${LABELS[kind]}已记下：亲密度 +${bondGain}，经验 +${rule.xp}。` }
}

export function remember(s, field, key) {
  if (!key) return true
  if (s[field].includes(key)) return false
  s[field].push(key)
  s[field] = s[field].slice(-128)
  return true
}

export function syncFeed(s, records, now, cfg) {
  let changed = false
  for (const rec of (Array.isArray(records) ? records : []).slice(-40).sort((a, b) => a?.at - b?.at)) {
    if (!rec || !Number.isFinite(rec.at) || rec.at < s.feedSince || rec.at > now) continue
    const key = createHash('sha256').update(JSON.stringify([rec.at, rec.food, rec.portion, rec.source, rec.gain])).digest('hex')
    if (!remember(s, 'seenFeed', key)) continue
    changed = true
    // 沿用喂食模块的“投喂”分类；自己找零食、没吃进去均不增加相处奖励。
    if (rec.source === '投喂' && Number(rec.gain) > 0) interact(s, 'feed', rec.at, cfg)
  }
  return changed
}

export function snapshot(s, now) {
  const v = advance(structuredClone(s), now)
  const level = Math.floor(Math.sqrt(v.xp / 25)) + 1
  const [threshold, stage] = STAGES.filter(([at]) => v.bond >= at).at(-1)
  const next = STAGES.find(([at]) => at > v.bond)
  return {
    ...v, level, stage, threshold, nextStage: next?.[1] || '', nextBond: next?.[0] || 1000,
    levelBase: 25 * (level - 1) ** 2, nextXp: 25 * level ** 2,
    energy: Math.round(v.energy), joy: Math.round(v.joy),
  }
}

export function parseAction(text) {
  const t = String(text || '').trim().replace(/[！!。～~]+$/u, '')
  if (/^(?:养成|养成状态|亲密度|关系状态)$/.test(t)) return 'status'
  if (/^(?:养成帮助|陪伴帮助)$/.test(t)) return 'help'
  if (/^(?:陪你玩(?:一会儿)?|一起玩(?:一会儿)?|和你玩(?:一会儿)?|玩耍)$/.test(t)) return 'play'
  if (/^(?:摸摸(?:你|头)?|抱抱(?:你)?)$/.test(t)) return 'touch'
  if (/^(?:晚安|睡觉吧|去休息吧|休息一下吧)$/.test(t)) return 'sleep'
  if (/^(?:早安|早上好|起床啦|醒醒)$/.test(t)) return 'wake'
  return null
}
