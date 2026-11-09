/**
 * 关键词表：把 assets/activity-keywords.json 编译成优先级有序的 needle 表。
 *
 * 优先级（高 → 低）：private > own > game > launcher > work > comm > ent
 * 浏览器窗口先按域名表判，域名没命中再回落标题表。
 */

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/

function makeNeedle(alias) {
  const low = String(alias || '').toLowerCase().trim()
  if (!low) return ''
  const asciiAlnum = /^[a-z0-9]|[a-z0-9]$/.test(low)
  if (!asciiAlnum || CJK.test(low)) return low
  const left = /[a-z0-9]/.test(low[0]) ? '\\b' : ''
  const right = /[a-z0-9]/.test(low[low.length - 1]) ? '\\b' : ''
  try {
    return new RegExp(left + low.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + right)
  } catch {
    return low
  }
}

function matches(needle, text) {
  if (!needle) return false
  if (typeof needle === 'string') return text.includes(needle)
  return needle.test(text)
}

function pushTitle(table, rows, category, subcategory) {
  for (const row of rows || []) {
    if (!Array.isArray(row)) continue
    const canonical = row[0]
    const aliases = Array.isArray(row[1]) ? row[1] : []
    const tagA = row[2] ?? null
    const tagB = row[3] ?? null
    for (const alias of aliases) {
      const needle = makeNeedle(alias)
      if (!needle) continue
      const result = { category, subcategory, canonical }
      if (category === 'gaming' && subcategory === 'game') {
        result.intensity = tagA
        result.genre = tagB
      } else if (tagA) {
        result.subcategory = tagA
      }
      table.push([needle, result])
    }
  }
}

function pushProc(table, rows, category, subcategory, isTuple) {
  for (const row of rows || []) {
    const proc = Array.isArray(row) ? row[0] : row
    const sub = Array.isArray(row) ? row[1] : null
    const needle = makeNeedle(proc)
    if (!needle) continue
    table.push([needle, { category, subcategory: isTuple ? sub || subcategory : subcategory, canonical: proc }])
  }
}

function pushDomain(table, rows, category) {
  for (const row of rows || []) {
    if (!Array.isArray(row)) continue
    const [domain, sub] = row
    const needle = makeNeedle(domain)
    if (!needle) continue
    table.push([needle, { category, subcategory: sub ?? null, canonical: domain }])
  }
}

export function buildTables(raw) {
  const title = []
  const proc = []
  const domain = []

  pushTitle(title, raw.private?.title, 'private', null)
  pushProc(proc, raw.private?.proc, 'private', null, false)

  pushTitle(title, raw.own?.title, 'own_app', null)
  pushProc(proc, raw.own?.proc, 'own_app', null, false)

  pushTitle(title, raw.game?.title, 'gaming', 'game')
  pushProc(proc, raw.game?.proc, 'gaming', 'game', false)
  pushTitle(title, raw.launcher?.title, 'gaming', 'launcher')
  pushProc(proc, raw.launcher?.proc, 'gaming', 'launcher', false)

  pushTitle(title, raw.work?.title, 'work', null)
  pushProc(proc, raw.work?.proc, 'work', null, true)
  pushDomain(domain, raw.work?.domain, 'work')

  pushTitle(title, raw.comm?.title, 'communication', null)
  pushProc(proc, raw.comm?.proc, 'communication', null, true)
  pushDomain(domain, raw.comm?.domain, 'communication')

  pushTitle(title, raw.ent?.title, 'entertainment', null)
  pushProc(proc, raw.ent?.proc, 'entertainment', null, true)
  pushDomain(domain, raw.ent?.domain, 'entertainment')

  return {
    title,
    proc,
    domain,
    browsers: new Set((raw.browser || []).map((p) => String(p).toLowerCase())),
    stats: { title: title.length, proc: proc.length, domain: domain.length },
  }
}

export const UNKNOWN = Object.freeze({ category: 'unknown', subcategory: null, canonical: null })

export function classifyTitle(tables, title) {
  if (!title) return UNKNOWN
  // 采样脚本给的 title 不保证是字符串（解析失败可能是数字），先归一，
  // 别让一次脏样本把整轮 classify 抛出去 —— classifyProc 一直是这么做的。
  const low = String(title).toLowerCase()
  for (const [needle, result] of tables.title) {
    if (matches(needle, low)) return result
  }
  return UNKNOWN
}

export function classifyProc(tables, proc) {
  if (!proc) return UNKNOWN
  const low = String(proc).toLowerCase().replace(/\\/g, '/').split('/').pop()
  for (const [needle, result] of tables.proc) {
    if (matches(needle, low)) return result
  }
  return UNKNOWN
}

export function classifyDomain(tables, title) {
  if (!title) return UNKNOWN
  const low = String(title).toLowerCase()
  for (const [needle, result] of tables.domain) {
    if (matches(needle, low)) return result
  }
  return UNKNOWN
}

export function isBrowser(tables, proc) {
  if (!proc) return false
  const base = String(proc).toLowerCase().replace(/\\/g, '/').split('/').pop()
  return tables.browsers.has(base)
}

/** 统一分类入口：进程名优先，其次浏览器域名，最后标题。 */
export function classify(tables, { title, proc }) {
  const byProc = classifyProc(tables, proc)
  if (byProc.category !== 'unknown') return byProc
  if (isBrowser(tables, proc)) {
    const byDomain = classifyDomain(tables, title)
    if (byDomain.category !== 'unknown') return byDomain
  }
  return classifyTitle(tables, title)
}
