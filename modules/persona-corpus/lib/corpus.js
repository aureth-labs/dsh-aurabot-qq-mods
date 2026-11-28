/**
 * 素材库的纯逻辑：一条素材该长什么样、怎么去重、怎么渲染成给人看的样子。
 * 这里不碰文件也不碰 api，全是纯函数 —— 测试可以直接调，index.mjs 只负责接线。
 */

import { createHash } from 'node:crypto'

/** 三种素材：反面（别这么说）、正面（像她会说、值得学）、观察（实验记录） */
export const KINDS = ['negative', 'positive', 'note']
export const KIND_LABEL = { negative: '反面', positive: '正面', note: '观察' }

/** 一条素材的长度上限。原话照抄才叫素材，但也不能让一条吃掉整个提示词。 */
export const MAX_TEXT = 300
export const MAX_NOTE = 160
export const MAX_FIX = 160
export const MAX_TAGS = 5
export const MAX_TAG_LEN = 12
/** 待审队列最多攒这么多条：群友乱塞时只丢最旧的，不会把磁盘写爆 */
export const MAX_PENDING = 30

const WHO = ['owner', 'member', 'self']
const WHO_LABEL = { owner: '主人', member: '群友', self: '她自己' }
const VIA = ['tool', 'command', 'module']

/**
 * 收的是原话：除了把连续空白压成一个空格、去掉首尾空白，一个字都不改。
 * 改写过的句子就没有收录价值了 —— 反面素材的价值全在「它原样长这样」。
 */
export function cleanText(input, max = MAX_TEXT) {
  const s = String(input ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`
}

/** 裁短用，不补省略号以外的东西 */
export function short(input, max = 40) {
  const s = String(input ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(1, max - 1))}…`
}

export function normalizeKind(kind) {
  return KINDS.includes(kind) ? kind : 'negative'
}

/** 标签：逗号、顿号、空格都算分隔符；去重、限长、最多 5 个 */
export function parseTags(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,，、;；\s]+/)
  const out = []
  for (const item of raw) {
    const tag = String(item ?? '').trim().slice(0, MAX_TAG_LEN)
    if (!tag || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/**
 * id 由「类型 + 原文」算出来，所以同一句话不会收两遍 —— 群里好几个人同时喊「收了」也只留一条。
 * 前缀带 c- 是为了在命令里一眼看出这是个素材 id。
 */
export function entryId(kind, text) {
  const digest = createHash('sha256').update(`${normalizeKind(kind)}\u0000${cleanText(text)}`).digest('hex')
  return `c-${digest.slice(0, 12)}`
}

/** 造一条素材。空原话返回 null，让调用方去报错，而不是存一条没内容的空壳 */
export function makeEntry({ kind, text, note, fix, tags, source, via, at } = {}) {
  const clean = cleanText(text)
  if (!clean) return null
  const k = normalizeKind(kind)
  const from = source && typeof source === 'object' ? source : {}
  return {
    id: entryId(k, clean),
    kind: k,
    at: typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : new Date().toISOString(),
    text: clean,
    note: cleanText(note, MAX_NOTE),
    fix: cleanText(fix, MAX_FIX),
    tags: parseTags(tags),
    source: {
      chatId: cleanText(from.chatId, 40),
      who: WHO.includes(from.who) ? from.who : 'member',
      userId: cleanText(from.userId, 24),
      nickname: cleanText(from.nickname, 24),
    },
    via: VIA.includes(via) ? via : 'tool',
  }
}

/** 从磁盘读回来的东西可能被手改过，只认有 id 和原文的 */
export function isEntry(value) {
  return Boolean(value && typeof value === 'object' && typeof value.id === 'string' && typeof value.text === 'string' && value.text)
}

/**
 * 加一条：同 id 算重复，不重复收；超过上限从最旧的开始丢。
 * 返回的 list 已经是新数组，调用方直接覆盖就行。
 */
export function addEntry(entries, entry, { max = 200 } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(isEntry)
  if (!isEntry(entry)) return { ok: false, list, reason: 'bad-entry' }
  const dup = list.find((e) => e.id === entry.id)
  if (dup) return { ok: false, duplicate: true, entry: dup, list, dropped: 0 }
  const next = [...list, entry]
  const keep = Math.max(1, Number(max) || 200)
  const dropped = Math.max(0, next.length - keep)
  return { ok: true, entry, list: dropped ? next.slice(dropped) : next, dropped }
}

/** 删一条（或几条） */
export function removeEntries(entries, ids) {
  const want = new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? '').trim()).filter(Boolean))
  const list = (Array.isArray(entries) ? entries : []).filter(isEntry)
  const kept = list.filter((e) => !want.has(e.id))
  return { removed: list.length - kept.length, list: kept }
}

/** 统计：给命令、提要、日志共用 */
export function summarize(entries, pending = []) {
  const list = (Array.isArray(entries) ? entries : []).filter(isEntry)
  const out = { total: list.length, negative: 0, positive: 0, note: 0, pending: Array.isArray(pending) ? pending.length : 0, updatedAt: null }
  for (const e of list) {
    const k = normalizeKind(e.kind)
    out[k] += 1
    if (!out.updatedAt || String(e.at) > String(out.updatedAt)) out.updatedAt = e.at || null
  }
  return out
}

/** 新的在前 */
export function newestFirst(entries) {
  return [...(Array.isArray(entries) ? entries : []).filter(isEntry)].sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

/** 翻库：按类型筛、按关键词找（原话 / 为什么 / 换成 / 标签都算） */
export function pickEntries(entries, { kind, q, limit = 10 } = {}) {
  const key = String(q ?? '').trim().toLowerCase()
  const want = KINDS.includes(kind) ? kind : ''
  const list = newestFirst(entries).filter((e) => {
    if (want && normalizeKind(e.kind) !== want) return false
    if (!key) return true
    const hay = [e.text, e.note, e.fix, ...(Array.isArray(e.tags) ? e.tags : [])].join(' ').toLowerCase()
    return hay.includes(key)
  })
  return list.slice(0, Math.max(1, Math.min(50, Number(limit) || 10)))
}

/**
 * 每轮塞进上下文的提要。
 * 只给主人那一轮用（群聊不塞）：素材里是别人的原话，不该在群里复读。
 */
export function renderDigest(entries, pending = [], { limit = 3 } = {}) {
  const n = Math.max(0, Math.min(10, Number(limit) || 0))
  const s = summarize(entries, pending)
  if (!s.total && !s.pending) return ''
  const head = [`【人格素材】反面 ${s.negative} · 正面 ${s.positive} · 观察 ${s.note}${s.pending ? ` · 待审 ${s.pending}` : ''}`]
  if (!n) return head.join('\n')
  const neg = newestFirst(entries).filter((e) => normalizeKind(e.kind) === 'negative').slice(0, n)
  if (neg.length) {
    head.push('收过的反面（别这么说）：')
    for (const e of neg) head.push(`· ${short(e.text, 40)}${e.fix ? ` → ${short(e.fix, 30)}` : ''}`)
  }
  if (s.pending) head.push('有群友要求收录的，等主人过一下（corpus_review）。')
  return head.join('\n')
}

export function formatTime(iso) {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return '时间不明'
  const d = new Date(t)
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 给人看的那份镜像（corpus.md）。
 * 正本是 JSONL，这份只是方便主人直接打开看；改这份不会生效，所以开头就写明。
 */
export function renderMarkdown(entries, { pending = 0 } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(isEntry)
  const s = summarize(list)
  const out = [
    '# 人格素材库',
    '',
    '> 由 `persona-corpus` 模块生成。正本是同一目录下的 `corpus.jsonl`，**改这份 md 不会生效**。',
    '',
    `共 ${s.total} 条：反面 ${s.negative} · 正面 ${s.positive} · 观察 ${s.note}${pending ? `；另有 ${pending} 条待审` : ''}。`,
    '',
  ]
  const titles = {
    negative: '反面素材（别这么说）',
    positive: '正面素材（像她、值得学）',
    note: '观察记录（实验备注）',
  }
  for (const kind of KINDS) {
    const group = newestFirst(list).filter((e) => normalizeKind(e.kind) === kind)
    if (!group.length) continue
    out.push(`## ${titles[kind]}`, '')
    group.forEach((e, i) => {
      const who = WHO_LABEL[e.source?.who] || '群友'
      out.push(`${i + 1}. \`${e.id}\` · ${formatTime(e.at)} · ${who}`)
      out.push(`   > ${e.text}`)
      if (e.note) out.push(`   - 为什么：${e.note}`)
      if (e.fix) out.push(`   - 换成：${e.fix}`)
      if (Array.isArray(e.tags) && e.tags.length) out.push(`   - 标签：${e.tags.join('、')}`)
      out.push('')
    })
  }
  if (!s.total) out.push('（还空着。被人点名收录的时候，或者 `/素材` 里手动加。）', '')
  return `${out.join('\n').trimEnd()}\n`
}
