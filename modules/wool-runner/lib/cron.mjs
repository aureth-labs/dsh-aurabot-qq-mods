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
    // L（当月最后一天）、W（最近工作日）、#（第几个星期几）等扩展占位无法精确求值，
    // 这里按「该字段任意值」处理，避免整条表达式因为扩展语法被判无效而丢掉任务。
    if (/^[lw]$/i.test(part.trim()) || /^\d+#\d+$/.test(part.trim())) {
      for (let n = min; n <= max; n++) values.add(n)
      continue
    }
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

// 常见快捷语法（@daily / @hourly 等），青龙脚本里偶尔出现
const MACROS = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

export function parseCron(expression) {
  // 去掉行尾注释（半角/全角分号）与包裹的引号/反引号，避免 `cron:1 1 1 1 *; 说明` 这类写法解析失败
  let raw = String(expression || '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .split(/[;；]/)[0]
    .trim()
  if (!raw) throw new Error('Cron 不能为空，请填写 5 或 6 个字段的表达式')
  const macro = MACROS[raw.toLowerCase()]
  if (macro) raw = macro
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

// 单个 cron 字段：* ? 数字 名称，可带范围 -、步长 /，以及逗号列举（6,18）
const ATOM_RE = String.raw`(?:\*|\?|\d+|[a-z]+)(?:\-(?:\d+|[a-z]+))?(?:\/(?:\d+))?`
const FIELD_RE = new RegExp('^' + ATOM_RE + String.raw`(?:,` + ATOM_RE + ')*$', 'i')

/**
 * 从「从关键字之后开始」的文本里取出 cron 表达式。
 *
 * 脚本仓库里的写法很杂，尾巴可能跟文件名、中文说明、引号或注释符。
 * 这里不做一次性贪婪正则，而是从起点逐个 token 累加：
 * 每累加一个字段就试解析一次，凑到 5 或 6 个合法字段即返回，
 * 遇到第一个不合法 token 立即停止。这样 `cron 17 18 * * *  gqft.js`
 * 和 `cron 0 6,18 * * *  好奇车生活.js` 都能正确截断。
 */
function takeFields(text, from) {
  let pending = ''
  const rest = String(text).slice(from)
  // 允许紧贴的冒号/等号（cron:1 1 1 1 *）
  const startAt = rest.search(/[^\s:=:：]/)
  if (startAt < 0) return ''
  const body = rest.slice(startAt)
  // 只在同一行内取字段：跨行会把注释下一行的 `*` 当成第 6 个字段
  const line = body.split(/\r?\n/)[0]
  const tokens = line.split(/[ \t]+/)
  const seen = []
  for (const token of tokens) {
    if (!token) continue
    const clean = token.replace(/["'`]+$/, '').replace(/^["'`]+/, '').replace(/[,;；)）]+$/, '')
    if (!clean) break
    if (!FIELD_RE.test(clean)) break
    seen.push(clean)
    if (seen.length < 5) continue
    if (seen.length > 6) break
    // 5 或 6 个字段都可以：先记下 5 字段的结果，若能凑成 6 字段且合法则优先用 6
    try {
      const raw = parseCron(seen.join(' ')).raw
      if (seen.length === 6) return raw
      // 5 字段合法时先暂存，继续看能否凑成 6 字段
      if (!pending) pending = raw
      continue
    } catch { if (seen.length === 6) break }
  }
  return pending
}

// 关键字：cron / 定时 / crontab / schedule
const KEYWORDS = [/cron/gi, /定时/g, /crontab/gi, /schedule/gi]
// 引号包裹的完整表达式：cron = "15 2 * * *" / cron: `0 8 * * *`
const QUOTED = /(?:cron|crontab|schedule)\s*[:=]?\s*(["'`])([^"'`\r\n]+)\1/i

export function extractCron(source) {
  const text = String(source || '').slice(0, 16_000)
  // 引号里是完整表达式，优先按原样解析
  const quoted = text.match(QUOTED)
  if (quoted) {
    try { return parseCron(quoted[2]).raw } catch {}
  }
  // 每个关键字的所有出现位置都要试：脚本里可能有说明性文字先出现
  const spots = []
  for (const re of KEYWORDS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      spots.push(m.index + m[0].length)
      if (spots.length > 400) break
    }
  }
  spots.sort((a, b) => a - b)
  for (const at of spots) {
    const raw = takeFields(text, at)
    if (raw) return raw
  }
  return ''
}
