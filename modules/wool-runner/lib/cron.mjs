const NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

function numberOf(raw) {
  const n = NAMES[String(raw).toLowerCase()] ?? Number(raw)
  if (!Number.isInteger(n)) throw new Error(`无效 cron 数字：${raw}`)
  return n
}

function fieldOf(text, min, max) {
  const values = new Set()
  for (const part of String(text).split(',')) {
    const m = part.match(/^(\*|\?|\d+|[a-z]+)(?:-(\d+|[a-z]+))?(?:\/(\d+))?$/i)
    if (!m) throw new Error(`无效 cron 字段：${part}`)
    const start = m[1] === '*' || m[1] === '?' ? min : numberOf(m[1])
    let end = start
    if (m[1] === '*' || m[1] === '?') end = max
    else if (m[2]) end = numberOf(m[2])
    else if (m[3]) end = max
    const step = Math.max(1, Number(m[3] || 1))
    if (start < min || end > max || start > end) throw new Error(`cron 字段越界：${part}`)
    for (let n = start; n <= end; n += step) values.add(n)
  }
  return values
}

export function parseCron(expression) {
  const raw = String(expression || '').trim().replace(/^['"]|['"]$/g, '')
  const fields = raw.split(/\s+/)
  if (fields.length !== 5 && fields.length !== 6) throw new Error('cron 需要 5 或 6 个字段')
  const six = fields.length === 6
  const at = six ? fields : ['0', ...fields]
  return {
    raw, six,
    second: fieldOf(at[0], 0, 59), minute: fieldOf(at[1], 0, 59), hour: fieldOf(at[2], 0, 23),
    day: fieldOf(at[3], 1, 31), month: fieldOf(at[4], 1, 12), week: fieldOf(at[5], 0, 7),
    dayAny: at[3] === '*' || at[3] === '?', weekAny: at[5] === '*' || at[5] === '?',
  }
}

export function cronMatches(cron, date = new Date()) {
  const c = typeof cron === 'string' ? parseCron(cron) : cron
  const week = date.getDay()
  const weekMatch = c.week.has(week) || (week === 0 && c.week.has(7))
  const dayMatch = c.day.has(date.getDate())
  const domDow = c.dayAny && c.weekAny ? true : c.dayAny ? weekMatch : c.weekAny ? dayMatch : dayMatch || weekMatch
  return c.second.has(date.getSeconds()) && c.minute.has(date.getMinutes()) && c.hour.has(date.getHours())
    && c.month.has(date.getMonth() + 1) && domDow
}

export function extractCron(source) {
  const text = String(source || '').slice(0, 16_000).replace(/\/\*(?=\s)|(?<!\S)\*\/(?!\d)/g, ' ')
  const patterns = [
    /\bcron\s*[=:]\s*["'`]([^"'`\r\n]+)["'`]/i,
    /\bcron\s+["'`]([^"'`\r\n]+)["'`]/i,
    /\bcron\s*[:=]?[ \t]+((?:[\d*,\/?a-z-]+[ \t]+){4,5}[\d*,\/?a-z-]+)/i,
    /定时\s*[:：]?[ \t]*((?:[\d*,\/?a-z-]+[ \t]+){4,5}[\d*,\/?a-z-]+)/i,
  ]
  for (const re of patterns) {
    const match = text.match(re)
    if (!match) continue
    try { return parseCron(match[1]).raw } catch {}
  }
  return ''
}
