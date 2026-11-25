// 价格 ↔ Aurabot「记忆」的桥接层。
//
// 查价（命令 / 工具 / 面板）和后台检查看到的价格，会压成一条带「价格监控」标签的记忆，
// 让她以后被问到「上次那台多少钱」时能想起来；记忆带有效期，过了就自动失效。
//
// 只调用 memory 模块的公开导出（add / update / remove / list），不 import 插件内部源码。
// 老版本记忆模块不认识 validUntil 时退回「删旧写新」，保证有效期真的生效；
// 记忆模块被关掉或没装时安静跳过，查价本身照常返回结果。

export const MEMORY_TAG = '价格监控'
export const MEMORY_SOURCE = 'price-watch'
export const MEMORY_TEXT_LIMIT = 200
// 保留时长按**分钟**算：默认 30 分钟，0 = 永久。
// 用分钟是因为价格是有时效的——「半小时前查的 899」和「三天前查的 899」不是一回事，
// 记忆留太久反而会让她拿一个过期的价格当真。
export const TTL_DEFAULT_MINUTES = 30
export const TTL_MIN_MINUTES = 0
export const TTL_MAX_MINUTES = 5256000 // 10 年，够用又不会溢出

const oneLine = (value) => String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()

const short = (value, max) => {
  const text = oneLine(value)
  const limit = Math.max(1, Number(max) || 1)
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text
}

const money = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  return '¥' + String(Math.round(n * 100) / 100)
}

/** 保留分钟数归一：0 = 永久；坏值按默认 30 分钟。整数分钟。 */
export function normalizeTtlMinutes (value, fallback = TTL_DEFAULT_MINUTES) {
  if (value === null || value === undefined || value === '') {
    const f = Number(fallback)
    return Number.isFinite(f) ? Math.min(TTL_MAX_MINUTES, Math.max(TTL_MIN_MINUTES, Math.round(f))) : TTL_DEFAULT_MINUTES
  }
  const n = Number(value)
  if (!Number.isFinite(n)) return normalizeTtlMinutes('', fallback)
  return Math.min(TTL_MAX_MINUTES, Math.max(TTL_MIN_MINUTES, Math.round(n)))
}

/** 有效期的毫秒时间戳；0 分钟（永久）返回 undefined，交给记忆模块按「没有结束时间」处理。 */
export function validUntilFor (ttlMinutes, now = Date.now()) {
  const minutes = normalizeTtlMinutes(ttlMinutes)
  if (minutes <= 0) return undefined
  const base = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  return base + minutes * 60000
}

/** 把人能读的保留时长写出来：30 分钟 / 2 小时 / 1 天 / 永久。 */
export function ttlLabel (ttlMinutes) {
  const minutes = normalizeTtlMinutes(ttlMinutes)
  if (minutes <= 0) return '长期有效'
  if (minutes < 60) return minutes + ' 分钟'
  if (minutes < 1440) {
    // 一天以内：整小时说「2 小时」，否则「1 小时 30 分钟」
    return minutes % 60 === 0 ? (minutes / 60) + ' 小时' : Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分钟'
  }
  const days = Math.floor(minutes / 1440)
  const restMinutes = minutes % 1440
  if (!restMinutes) return days + ' 天'
  const restHours = Math.floor(restMinutes / 60)
  const rest = restMinutes % 60
  if (restHours && rest) return days + ' 天 ' + restHours + ' 小时 ' + rest + ' 分钟'
  if (restHours) return days + ' 天 ' + restHours + ' 小时'
  return days + ' 天 ' + rest + ' 分钟'
}

/** 记忆里显示的时间：11-12 10:30（北京时间）。 */
export function memoryClock (ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  const pad = (x) => String(x).padStart(2, '0')
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/**
 * 一条查价记忆的正文（不超过 200 字，和记忆模块的单条上限一致）。
 * key 只在内部用来认领同一条记忆，不写进正文。
 */
export function priceMemoryText (record, opts = {}) {
  if (!record) return ''
  const title = short(record.title || record.query || '', 52)
  const price = money(record.price)
  if (!title || !price) return ''
  const mall = short(record.mall || '未知平台', 12)
  const at = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Number(record.at) || Date.now()
  const parts = ['价格：' + title + '，' + mall + ' ' + price + '（' + memoryClock(at) + ' 查）']
  const lowest = Number(record.lowest)
  if (Number.isFinite(lowest) && lowest > 0 && lowest < Number(record.price) - 0.001) parts.push('本插件记录最低 ' + money(lowest))
  const previous = Number(record.previous)
  const drop = Number(record.drop)
  if (Number.isFinite(drop) && drop > 0) {
    parts.push('比上次便宜 ' + money(drop))
  } else if (Number.isFinite(previous) && previous > Number(record.price) + 0.001) {
    parts.push('上次 ' + money(previous))
  }
  if (record.isNewLow === true) parts.push('这次是记录里的最低价')
  return short(parts.join('，'), MEMORY_TEXT_LIMIT)
}

/** 一条记忆的归属键：同款商品（指纹）算同一条，认不出来才退回查询词。 */
export function priceMemoryKey (record) {
  if (!record) return ''
  const key = oneLine(record.key)
  if (key) return key
  const title = oneLine(record.title || record.query).toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '')
  return title ? title.slice(0, 80) : ''
}

/**
 * 本地记录丢了（删过 state.json、换过数据目录）时，按「价格：标题」认领记忆里已有的那一条，
 * 免得同一件商品每查一次就多一条。认不出来返回 null，交给调用方新建。
 */
export function findPriceMemory (memory, record) {
  if (!memory || typeof memory.list !== 'function' || !record) return null
  const prefix = '价格：' + short(record.title || record.query || '', 52)
  if (prefix.length <= 3) return null
  const titleKey = priceMemoryKey({ title: record.title || record.query })
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '')
  try {
    const tagged = (memory.list('') || []).filter((item) => item && Array.isArray(item.tags) && item.tags.includes(MEMORY_TAG))
    const exact = tagged.find((item) => oneLine(item.displayText || item.text).startsWith(prefix))
    if (exact) return exact
    if (!titleKey) return null
    return tagged.find((item) => normalize(item.displayText || item.text).includes(normalize(titleKey))) || null
  } catch (error) {
    return null
  }
}

/**
 * 写入 / 刷新一条查价记忆。
 * previousId 是从本地记录里带来的记忆 id：还在就直接更新，文本和有效期变了就删旧写新，
 * 保证老版本记忆模块（不认识 validUntil）也能拿到新的有效期。
 * 返回 { ok, id, action } 或 { ok:false, skipped }。
 */
export function syncPriceMemory (memory, record, opts = {}) {
  if (!memory || typeof memory.add !== 'function') return { ok: false, skipped: 'memory-unavailable' }
  const text = priceMemoryText(record, opts)
  if (!text) return { ok: false, skipped: 'empty' }
  const validUntil = validUntilFor(record && record.ttlMinutes === undefined ? opts.ttlMinutes : record.ttlMinutes, opts.now)
  const previousId = oneLine(opts.previousId)
  const importance = Number.isFinite(Number(opts.importance)) ? Number(opts.importance) : 0.45
  const tags = [MEMORY_TAG, '价格']
  const existing = previousId ? { id: previousId } : findPriceMemory(memory, record)
  let refreshed = false
  if (existing && typeof memory.update === 'function') {
    try {
      const out = memory.update(existing.id, { text, validUntil })
      // item 里没有 validUntil：说明这个版本的记忆模块还不认有效期，删掉重写
      if (out && out.ok !== false) {
        const applied = out.item ? out.item.validUntil : undefined
        if (!validUntil || (Number(applied) === Number(validUntil))) return { ok: true, id: existing.id, action: 'updated' }
        refreshed = true
      }
    } catch (error) {}
    try { if (typeof memory.remove === 'function') memory.remove(existing.id) } catch (error) {}
  } else if (existing && typeof memory.remove === 'function') {
    try { memory.remove(existing.id) } catch (error) {}
  }
  let added = null
  try {
    added = memory.add({
      text,
      tags,
      importance,
      source: MEMORY_SOURCE,
      chatId: oneLine(opts.chatId),
      ...(validUntil ? { validUntil } : {}),
    })
  } catch (error) {
    return { ok: false, message: error && error.message ? error.message : String(error) }
  }
  if (!added || added.ok === false) return { ok: false, message: (added && added.message) || '写入价格记忆失败' }
  return { ok: true, id: String(added.id || added.updated || ''), action: refreshed ? 'refreshed' : 'created' }
}

/** 只删这个模块自己写的价格记忆（本地记录全丢了时按标签认领）。 */
export function forgetPriceMemories (memory, opts = {}) {
  if (!memory || typeof memory.remove !== 'function') return 0
  const ids = Array.isArray(opts.ids) ? opts.ids.map((id) => oneLine(id)).filter(Boolean) : []
  let removed = 0
  for (const id of ids) {
    try {
      const out = memory.remove(id)
      if (out && out.ok !== false) removed++
    } catch (error) {}
  }
  return removed
}

/** 列表里属于价格监控的条目（面板 / 命令展示用）。 */
export function listPriceMemories (memory) {
  if (!memory || typeof memory.list !== 'function') return []
  try {
    const items = memory.list('') || []
    return items
      .filter((item) => item && Array.isArray(item.tags) && item.tags.includes(MEMORY_TAG))
      .map((item) => ({
        id: String(item.id || ''),
        text: oneLine(item.displayText || item.text),
        at: Number(item.at) || 0,
        validUntil: Number(item.validUntil) || 0,
      }))
      .sort((a, b) => b.at - a.at)
  } catch (error) {
    return []
  }
}

/** 记忆模块当前能不能写：拿不到导出、或被总开关关掉都算不能。 */
export function memoryWritable (api) {
  try {
    if (api && typeof api.config === 'function') {
      const cfg = api.config()
      if (cfg && cfg.memory && cfg.memory.enabled === false) return null
    }
  } catch (error) {}
  try {
    const memory = api && typeof api.use === 'function' ? api.use('memory') : null
    return memory && typeof memory.add === 'function' ? memory : null
  } catch (error) {
    return null
  }
}

export default { MEMORY_TAG, MEMORY_SOURCE, TTL_DEFAULT_MINUTES, normalizeTtlMinutes, validUntilFor, ttlLabel, priceMemoryText, priceMemoryKey, findPriceMemory, syncPriceMemory, forgetPriceMemories, listPriceMemories, memoryWritable, memoryClock }
