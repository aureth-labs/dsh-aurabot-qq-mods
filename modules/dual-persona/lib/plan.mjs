// 计划结构的收敛：面板存什么、这里就只认什么，坏值一律退回安全默认。
// 「开没开」由模块自己的设置项（启用双重人格）管，这里只管模式；
// 模式只有两种且互斥：split（人格分裂，默认）、global（全局人格切换）。
export const MAX_SLOTS = 24
export const MAX_BANDS = 12
export const MAX_POOL = 30
export const MAX_SPLIT_ROWS = 60

const str = (v) => String(v == null ? '' : v).trim()
const num = (v, min, max, fallback) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const TIME_RE = /^([01]?\d|2[0-3])[:：]([0-5]?\d)$/

export const normTime = (v) => {
  const m = TIME_RE.exec(str(v))
  if (!m) return ''
  const h = String(Number(m[1])).padStart(2, '0')
  const min = String(Number(m[2])).padStart(2, '0')
  return `${h}:${min}`
}

const normSlots = (raw) => {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const it of raw.slice(0, MAX_SLOTS)) {
    const at = normTime(it?.at)
    const persona = str(it?.persona)
    if (!at || !persona) continue
    out.push({ at, persona })
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

const normDays = (raw) => {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw)) {
    const d = Number(k)
    const persona = str(v)
    if (!Number.isInteger(d) || d < 1 || d > 31 || !persona) continue
    out[String(d)] = persona
  }
  return out
}

const normBands = (raw) => {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const it of raw.slice(0, MAX_BANDS)) {
    const persona = str(it?.persona)
    if (!persona) continue
    let min = num(it?.min, 0, 100, 0)
    let max = num(it?.max, 0, 100, 100)
    if (min > max) [min, max] = [max, min]
    out.push({ min, max, persona })
  }
  return out.sort((a, b) => a.min - b.min)
}

const normPool = (raw) => {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const it of raw.slice(0, MAX_POOL)) {
    const persona = str(it?.persona)
    if (!persona) continue
    out.push({ persona, weight: num(it?.weight, 0, 100, 1) })
  }
  return out
}

// 分裂表：一组「号码串 + 人格卡」。号码串在运行时会解析成 chatId（见 lib/split.mjs）。
// 空行也留着：面板上点了「+」还没填完的那一行，不能一保存就没了。
const normRows = (raw) => {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const it of raw.slice(0, MAX_SPLIT_ROWS)) {
    if (!it || typeof it !== 'object') continue
    out.push({ ids: str(it.ids), persona: str(it.persona) })
  }
  return out
}

export function defaultPlan() {
  return {
    mode: 'split',
    // 每条规则都有 scope：QQ 号/群号串。全局模式下不用；分裂模式下不填就不生效。
    timed: { enabled: false, scope: '', slots: [] },
    monthly: { enabled: false, scope: '', days: {} },
    mood: { enabled: false, scope: '', source: 'auto', manual: 50, bands: [] },
    randomFixed: { enabled: false, scope: '', target: 'chat', totalPercent: 30, pool: [] },
    randomTemp: { enabled: false, scope: '', totalPercent: 20, pool: [] },
    split: { default: '', rows: [] },
  }
}

export function normalizePlan(raw) {
  const d = defaultPlan()
  if (!raw || typeof raw !== 'object') return d
  const t = raw.timed && typeof raw.timed === 'object' ? raw.timed : {}
  const m = raw.monthly && typeof raw.monthly === 'object' ? raw.monthly : {}
  const mo = raw.mood && typeof raw.mood === 'object' ? raw.mood : {}
  const rf = raw.randomFixed && typeof raw.randomFixed === 'object' ? raw.randomFixed : {}
  const rt = raw.randomTemp && typeof raw.randomTemp === 'object' ? raw.randomTemp : {}
  const sp = raw.split && typeof raw.split === 'object' ? raw.split : {}

  // 兼容 1.0 / 1.1 早期存的 mode 字段，和 1.2 的两个开关字段：
  // 以前「哪个开关开着」决定模式；1.3 起总开关在模块设置里，这里只留 mode。
  let mode = raw.mode === 'global' ? 'global' : 'split'
  if (raw.mode === undefined && raw.switchGlobal === true && raw.switchSplit !== true) mode = 'global'

  return {
    mode,
    timed: { enabled: t.enabled === true, scope: str(t.scope).slice(0, 300), slots: normSlots(t.slots) },
    monthly: { enabled: m.enabled === true, scope: str(m.scope).slice(0, 300), days: normDays(m.days) },
    mood: {
      enabled: mo.enabled === true,
      scope: str(mo.scope).slice(0, 300),
      source: mo.source === 'manual' ? 'manual' : 'auto',
      manual: num(mo.manual, 0, 100, 50),
      bands: normBands(mo.bands),
    },
    randomFixed: {
      enabled: rf.enabled === true,
      // 1.3 及以前这里叫 scope 且值只有 'global' / 'chat'；现在 scope 是 QQ 范围、target 才管落点
      scope: rf.target === undefined && (rf.scope === 'global' || rf.scope === 'chat') ? '' : str(rf.scope).slice(0, 300),
      target: (rf.target !== undefined ? rf.target : rf.scope) === 'global' ? 'global' : 'chat',
      totalPercent: num(rf.totalPercent, 0, 100, 30),
      pool: normPool(rf.pool),
    },
    randomTemp: {
      enabled: rt.enabled === true,
      scope: str(rt.scope).slice(0, 300),
      totalPercent: num(rt.totalPercent, 0, 100, 20),
      pool: normPool(rt.pool),
    },
    split: { default: str(sp.default), rows: normRows(sp.rows) },
  }
}

/** 面板拿到的精简视图（只读，给 UI 显示用） */
export function planSummary(plan) {
  const p = normalizePlan(plan)
  const on = []
  if (p.mode === 'split') {
    if (p.split.default) on.push('分裂·公共默认')
    const n = p.split.rows.filter((r) => r.ids && r.persona).length
    if (n) on.push(`分裂·${n} 组号码`)
  }
  // 定时/每月/心情现在两种模式都会跑：全局模式换全局卡，分裂模式只换范围内那几个会话
  if (p.timed.enabled && p.timed.slots.length) on.push(p.mode === 'split' && !p.timed.scope ? '定时（未填范围）' : '定时')
  if (p.monthly.enabled && Object.keys(p.monthly.days).length) on.push(p.mode === 'split' && !p.monthly.scope ? '每月（未填范围）' : '每月')
  if (p.mood.enabled && p.mood.bands.length) on.push(p.mode === 'split' && !p.mood.scope ? '心情（未填范围）' : '心情')
  if (p.randomFixed.enabled && p.randomFixed.pool.length) on.push(p.mode === 'split' && !p.randomFixed.scope ? '随机·固定（未填范围）' : '随机·固定')
  if (p.randomTemp.enabled && p.randomTemp.pool.length) on.push(p.mode === 'split' && !p.randomTemp.scope ? '随机·临时（未填范围）' : '随机·临时')
  return { modes: on }
}
