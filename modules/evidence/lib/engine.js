/**
 * 证据引擎：把「事实」按被反复提到的强度算成证据分，再往上长成反思和人格片段。
 *
 * 抄的是 N.E.K.O 的 config/memory_settings.py 那套阈值：
 *   EVIDENCE_CONFIRMED_THRESHOLD = 1.0
 *   EVIDENCE_PROMOTED_THRESHOLD  = 2.0
 *   EVIDENCE_ARCHIVE_THRESHOLD   = -2.0
 *   EVIDENCE_REIN_HALF_LIFE_DAYS = 30
 *   EVIDENCE_DISP_HALF_LIFE_DAYS = 180
 *   USER_FACT_REINFORCE_COMBO_THRESHOLD = 2 / BONUS = 0.5
 *
 * 和 N.E.K.O 的区别：它的事实库自己管证据；桌宠的事实存在 companion-memory 里
 * （records.json，字段 mention_events / pinned / recall_only），这里只读那边，
 * 证据分和晋升结果另存一份，不改人家的文件。
 */

import { createHash } from 'node:crypto'

export const CONFIRMED_THRESHOLD = 1.0
export const PROMOTED_THRESHOLD = 2.0
export const ARCHIVE_THRESHOLD = -2.0
export const REIN_HALF_LIFE_DAYS = 30
export const DISP_HALF_LIFE_DAYS = 180
export const COMBO_THRESHOLD = 2
export const COMBO_BONUS = 0.5
export const COMBO_WINDOW_MS = 24 * 3600 * 1000

/** 反思：一个主题至少攒够这么多条钉稳的事实才值得写 */
export const REFLECTION_MIN_FACTS = 2
/** 人格：一个主题至少攒够这么多条反思才够格长成「样子」 */
export const PERSONA_MIN_REFLECTIONS = 2
/** 人格：这些反思加起来证据分至少这么高 */
export const PERSONA_MIN_EVIDENCE = 4.0
/**
 * 泛用桶不算主题。companion-memory 会把没归上类的记忆扔进 general/misc，
 * 这些凑在一起毫无关系，硬写成一段反思就是胡编。
 */
export const CATCH_ALL_TOPICS = new Set(['general', 'misc', 'other', ''])

function realTopic(topic) {
  const t = String(topic ?? '').trim()
  if (!t || CATCH_ALL_TOPICS.has(t.toLowerCase())) return null
  return t
}

const DAY = 86400000

export function decayFactor(ageMs, halfLifeDays) {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1
  const halfLife = Math.max(1, Number(halfLifeDays) || 1) * DAY
  return Math.pow(0.5, ageMs / halfLife)
}

function timeOf(value) {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

/** 一条事实的提及事件，按时间排好 */
export function mentionsOf(record) {
  const events = Array.isArray(record?.mention_events) ? record.mention_events : []
  const out = []
  for (const event of events) {
    const t = timeOf(event?.occurred_at)
    if (t === null) continue
    out.push({ at: t, kind: event?.kind === 'substantive' ? 'substantive' : 'passing' })
  }
  // 没有 mention_events 就退回 last_user_mention_at / created_at，别让老数据变 0 分
  if (out.length === 0) {
    const t = timeOf(record?.last_user_mention_at) ?? timeOf(record?.created_at)
    if (t !== null) out.push({ at: t, kind: 'substantive' })
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * 算一条事实的证据分。
 * - 每被「实质性」提到一次 +1，按 30 天半衰期衰减
 * - 24 小时内被提到 >= 2 次，额外 +0.5（连着说才叫真的重要）
 * - pinned 直接锁在 PROMOTED_THRESHOLD，永不衰减（主人手动钉的）
 */
export function scoreFact(record, now = Date.now()) {
  const mentions = mentionsOf(record)
  if (record?.pinned) {
    return {
      evidence: PROMOTED_THRESHOLD,
      mentions: mentions.length,
      substantive: mentions.filter((m) => m.kind === 'substantive').length,
      lastAt: mentions.length ? new Date(mentions[mentions.length - 1].at).toISOString() : null,
      comboActive: false,
      pinned: true,
    }
  }

  const substantive = mentions.filter((m) => m.kind === 'substantive')
  let evidence = 0
  for (const mention of substantive) {
    const age = Math.max(0, now - mention.at)
    evidence += decayFactor(age, REIN_HALF_LIFE_DAYS)
  }

  let comboActive = false
  for (let i = 1; i < substantive.length; i += 1) {
    const gap = substantive[i].at - substantive[i - 1].at
    if (gap >= 0 && gap <= COMBO_WINDOW_MS && substantive.length >= COMBO_THRESHOLD) {
      comboActive = true
      break
    }
  }
  if (comboActive) evidence += COMBO_BONUS

  return {
    evidence: Math.round(evidence * 10000) / 10000,
    mentions: mentions.length,
    substantive: substantive.length,
    lastAt: substantive.length ? new Date(substantive[substantive.length - 1].at).toISOString() : null,
    comboActive,
    pinned: false,
  }
}

/** 证据分 → 阶段 */
export function stageFor(evidence, previous) {
  if (evidence >= PROMOTED_THRESHOLD) return 'promoted'
  if (evidence >= CONFIRMED_THRESHOLD) return 'confirmed'
  if (evidence <= ARCHIVE_THRESHOLD) return 'archive'
  // 掉下来了：曾经钉稳过的保留 confirmed 标签但标记 falling，免得来回跳
  if (previous === 'promoted' || previous === 'confirmed') return 'confirmed'
  return 'candidate'
}

export function isStableStage(stage) {
  return stage === 'confirmed' || stage === 'promoted'
}

/** 反思的幂等 id：同一个主题 + 同一批事实，算出来永远是同一个 */
export function reflectionId(topicId, factIds) {
  const sorted = [...factIds].sort().join('|')
  return `refl-${createHash('sha256').update(`${topicId}::${sorted}`).digest('hex').slice(0, 12)}`
}

export function personaId(topicId) {
  return `persona-${createHash('sha256').update(`persona::${topicId}`).digest('hex').slice(0, 12)}`
}

/**
 * 从旧 store + 新事实算出新的 store（纯函数，方便测）。
 * 返回 { store, events }，events 记录这轮发生了什么变化。
 */
export function advance(store, records, now = Date.now()) {
  const events = []
  const facts = { ...(store.facts ?? {}) }
  const seen = new Set()

  for (const record of records) {
    if (!record || typeof record.id !== 'string') continue
    if (record.status === 'superseded' || record.status === 'deleted') continue
    seen.add(record.id)
    const score = scoreFact(record, now)
    const previous = facts[record.id]
    const stage = stageFor(score.evidence, previous?.stage)
    const next = {
      id: record.id,
      topic_id: record.topic_id ?? 'misc',
      fact_key: record.fact_key ?? null,
      summary: record.summary ?? '',
      pinned: Boolean(record.pinned),
      recall_only: Boolean(record.recall_only),
      evidence: score.evidence,
      mentions: score.mentions,
      substantive: score.substantive,
      comboActive: score.comboActive,
      lastAt: score.lastAt,
      stage,
      firstSeen: previous?.firstSeen ?? new Date(now).toISOString(),
      at: new Date(now).toISOString(),
    }
    if (previous && previous.stage !== stage) {
      events.push({ type: 'stage', id: record.id, from: previous.stage, to: stage, evidence: score.evidence })
    }
    if (!previous && isStableStage(stage)) {
      events.push({ type: 'discovered', id: record.id, stage, evidence: score.evidence })
    }
    facts[record.id] = next
  }

  // 已经不在这边的记忆（被删/被合并）标成 gone，不直接抹掉，留个痕
  for (const [id, fact] of Object.entries(facts)) {
    if (seen.has(id)) continue
    if (fact.stage !== 'gone') {
      facts[id] = { ...fact, stage: 'gone', at: new Date(now).toISOString() }
      events.push({ type: 'gone', id })
    }
  }

  const reflections = advanceReflections(store.reflections ?? [], facts, now, events)
  const persona = advancePersona(store.persona ?? [], reflections, facts, now, events)

  return {
    store: {
      ...store,
      version: store.version ?? 1,
      updated_at: new Date(now).toISOString(),
      facts,
      reflections,
      persona,
    },
    events,
  }
}

/** 按主题聚合，够格就产出一条「待写」的反思占位 */
function advanceReflections(previous, facts, now, events) {
  const out = previous.map((r) => ({ ...r }))
  const byTopic = new Map()
  for (const fact of Object.values(facts)) {
    if (fact.stage === 'gone' || fact.recall_only) continue
    if (!isStableStage(fact.stage)) continue
    const topic = realTopic(fact.topic_id)
    if (!topic) continue
    if (!byTopic.has(topic)) byTopic.set(topic, [])
    byTopic.get(topic).push(fact)
  }

  for (const [topic, topicFacts] of byTopic) {
    if (topicFacts.length < REFLECTION_MIN_FACTS) continue
    const ids = topicFacts.map((f) => f.id).sort()
    const id = reflectionId(topic, ids)
    const existing = out.find((r) => r.id === id)
    const evidence = topicFacts.reduce((sum, f) => sum + f.evidence, 0)
    if (existing) {
      existing.evidence = Math.round(evidence * 10000) / 10000
      existing.fact_ids = ids
      existing.at = new Date(now).toISOString()
      continue
    }
    out.push({
      id,
      topic_id: topic,
      fact_ids: ids,
      evidence: Math.round(evidence * 10000) / 10000,
      // pending = 还等桌宠自己动笔写；stale = 有事实变了要重写
      status: 'pending',
      text: null,
      created_at: new Date(now).toISOString(),
      at: new Date(now).toISOString(),
    })
    events.push({ type: 'reflection-pending', id, topic })
  }

  // 已经有反思的主题，事实集合变了 → 标 stale
  for (const refl of out) {
    if (!refl.fact_ids) continue
    const current = (byTopic.get(refl.topic_id) ?? []).map((f) => f.id).sort()
    if (current.length === 0) continue
    if (current.join('|') !== refl.fact_ids.join('|') && refl.status === 'ready') {
      refl.status = 'stale'
      events.push({ type: 'reflection-stale', id: refl.id, topic: refl.topic_id })
    }
  }

  return out
}

/** 一个主题攒够反思，就长成一条人格片段 */
function advancePersona(previous, reflections, facts, now, events) {
  const out = previous.map((p) => ({ ...p }))
  // stale 也算数：它只是「事实后来变了」，当时写下的反思依然是长过的痕迹
  const ready = reflections.filter(
    (r) => (r.status === 'ready' || r.status === 'stale') && typeof r.text === 'string' && r.text.trim(),
  )
  const byTopic = new Map()
  for (const refl of ready) {
    if (!byTopic.has(refl.topic_id)) byTopic.set(refl.topic_id, [])
    byTopic.get(refl.topic_id).push(refl)
  }

  for (const [topic, list] of byTopic) {
    if (list.length < PERSONA_MIN_REFLECTIONS) continue
    const evidence = list.reduce((sum, r) => sum + (r.evidence ?? 0), 0)
    if (evidence < PERSONA_MIN_EVIDENCE) continue
    const id = personaId(topic)
    const refIds = list.map((r) => r.id).sort()
    const existing = out.find((p) => p.id === id)
    if (existing) {
      existing.reflection_ids = refIds
      existing.evidence = Math.round(evidence * 10000) / 10000
      existing.at = new Date(now).toISOString()
      continue
    }
    out.push({
      id,
      topic_id: topic,
      reflection_ids: refIds,
      evidence: Math.round(evidence * 10000) / 10000,
      // pending = 等桌宠把这几条反思揉成一句「我是怎么样的」
      status: 'pending',
      text: null,
      created_at: new Date(now).toISOString(),
      at: new Date(now).toISOString(),
    })
    events.push({ type: 'persona-pending', id, topic })
  }

  return out
}

/** 写反思 / 人格：把 pending 变成 ready */
export function writeReflection(store, id, text, now = Date.now()) {
  const refl = (store.reflections ?? []).find((r) => r.id === id)
  if (!refl) return null
  refl.text = String(text ?? '').trim()
  refl.status = refl.text ? 'ready' : 'pending'
  refl.written_at = new Date(now).toISOString()
  refl.at = new Date(now).toISOString()
  return refl
}

export function writePersona(store, id, text, now = Date.now()) {
  const entry = (store.persona ?? []).find((p) => p.id === id)
  if (!entry) return null
  entry.text = String(text ?? '').trim()
  entry.status = entry.text ? 'ready' : 'pending'
  entry.written_at = new Date(now).toISOString()
  entry.at = new Date(now).toISOString()
  return entry
}

function short(text, max = 60) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

/**
 * 给系统提示用的一小段话。没东西可说就返回空串（不占 token）。
 * 控制在 ~500 字以内。
 */
export function renderDigest(store, options = {}) {
  const maxLines = options.maxLines ?? 6
  const facts = Object.values(store.facts ?? {}).filter((f) => f.stage !== 'gone')
  const reflections = (store.reflections ?? []).filter((r) => r.status !== 'archived')
  const persona = (store.persona ?? []).filter((p) => p.status !== 'archived')

  const lines = []

  const growing = facts
    .filter((f) => f.stage === 'promoted' && !f.pinned)
    .sort((a, b) => b.evidence - a.evidence)
    .slice(0, 3)
  if (growing.length) {
    lines.push(`反复提到、已经很稳的：${growing.map((f) => short(f.summary, 40)).join('；')}`)
  }

  const pending = reflections.filter((r) => r.status === 'pending').slice(0, 2)
  if (pending.length) {
    for (const refl of pending) {
      const src = (refl.fact_ids ?? []).map((id) => store.facts?.[id]).filter(Boolean).map((f) => short(f.summary, 30))
      lines.push(`关于「${refl.topic_id}」你还欠自己一段反思：${src.join('；')}`)
    }
  }

  const stale = reflections.filter((r) => r.status === 'stale').slice(0, 1)
  if (stale.length) {
    lines.push(`「${stale[0].topic_id}」的反思有新事实了，可以重写一遍`)
  }

  const maybePersona = persona.filter((p) => p.status === 'pending').slice(0, 1)
  if (maybePersona.length) {
    lines.push(`「${maybePersona[0].topic_id}」攒够反思了，可以写一句自己的样子`)
  }

  const ready = persona.filter((p) => p.status === 'ready' && p.text).slice(-3)
  if (ready.length) {
    lines.push(`长出来的样子：${ready.map((p) => short(p.text, 50)).join('；')}`)
  }

  if (lines.length === 0) return ''
  const body = lines.slice(0, maxLines).join('\n')
  return `【记忆证据】\n${body}`
}

export function summarize(store) {
  const facts = Object.values(store.facts ?? {})
  const count = (stage) => facts.filter((f) => f.stage === stage).length
  return {
    facts: facts.length,
    candidate: count('candidate'),
    confirmed: count('confirmed'),
    promoted: count('promoted'),
    reflections: (store.reflections ?? []).length,
    reflectionsPending: (store.reflections ?? []).filter((r) => r.status === 'pending').length,
    reflectionsReady: (store.reflections ?? []).filter((r) => r.status === 'ready').length,
    persona: (store.persona ?? []).length,
    personaReady: (store.persona ?? []).filter((p) => p.status === 'ready').length,
    updatedAt: store.updated_at ?? null,
  }
}
