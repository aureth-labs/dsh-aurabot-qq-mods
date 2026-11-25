// 时区安全的墙上时间。
//
// 踩过的坑：Aurabot 的进程跑在 UTC（容器里没设 TZ），但作息是按本地时间说的——
// 「08:00 起床」被算成 UTC 08:00，面板上就成了 16:00。所以这里不碰进程本地时区，
// 统一按配置的时区（默认 Asia/Shanghai）算墙上时间。
//
// 有完整 ICU 时用 Intl 拿墙上时间；没有就退化成「UTC + 固定偏移」。

const FALLBACK_OFFSET = 480
let zone = 'Asia/Shanghai'
let offsetMinutes = FALLBACK_OFFSET
let formatter = null
let formatterZone = ''

export function configureClock({ timeZone, utcOffsetMinutes } = {}) {
  if (typeof utcOffsetMinutes === 'number' && Number.isFinite(utcOffsetMinutes)) {
    offsetMinutes = Math.max(-720, Math.min(840, utcOffsetMinutes))
  }
  if (typeof timeZone === 'string' && timeZone.trim()) {
    zone = timeZone.trim()
    formatter = null
  }
}

export const clockZone = () => zone
export const clockOffset = () => offsetMinutes

function getFormatter() {
  if (formatter && formatterZone === zone) return formatter
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterZone = zone
  } catch {
    formatter = null
  }
  return formatter
}

/** 这一毫秒在配置时区里的墙上时间。 */
export function wall(ts = Date.now()) {
  const at = Number(ts) || 0
  const fmt = getFormatter()
  if (fmt) {
    const parts = fmt.formatToParts(new Date(at))
    const get = (type) => Number(parts.find((p) => p.type === type)?.value)
    const hour = get('hour')
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: hour === 24 ? 0 : hour,
      minute: get('minute'),
      second: get('second'),
      ms: at,
    }
  }
  const shifted = new Date(at + offsetMinutes * 60_000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    ms: at,
  }
}

/** 墙上时间 → 时间戳。反解两次，跨 DST 也够用。 */
export function toTimestamp({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  let ts = guessUtc - offsetMinutes * 60_000
  for (let i = 0; i < 3; i += 1) {
    const w = wall(ts)
    const targetUtc = Date.UTC(year, month - 1, day, hour, minute, second)
    const actualUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
    const drift = targetUtc - actualUtc
    if (drift === 0) break
    ts += drift
  }
  return ts
}

export function nowMinute(ts = Date.now()) {
  const w = wall(ts)
  return w.hour * 60 + w.minute
}

export function clockText(ts) {
  if (!ts) return '--:--'
  const w = wall(ts)
  return `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`
}

/** 今天 / 明天 / 后天 / 具体日期。 */
export function dayLabel(ts, now = Date.now()) {
  if (!ts) return ''
  const a = wall(ts)
  const b = wall(now)
  const aDay = Date.UTC(a.year, a.month - 1, a.day)
  const bDay = Date.UTC(b.year, b.month - 1, b.day)
  const delta = Math.round((aDay - bDay) / 86_400_000)
  if (delta === 0) return '今天'
  if (delta === 1) return '明天'
  if (delta === 2) return '后天'
  return `${String(a.month).padStart(2, '0')}-${String(a.day).padStart(2, '0')}`
}

/** 今天（配置时区）的 00:00 时间戳。 */
export function startOfDay(ts = Date.now()) {
  const w = wall(ts)
  return toTimestamp({ year: w.year, month: w.month, day: w.day, hour: 0, minute: 0, second: 0 })
}

/** 下一个「墙上 HH:MM」的时间戳；已经过了就顺延到明天。 */
export function nextWallTime(minuteOfDay, ts = Date.now()) {
  const w = wall(ts)
  const nowMin = w.hour * 60 + w.minute
  const dayShift = nowMin >= minuteOfDay ? 1 : 0
  const base = new Date(Date.UTC(w.year, w.month - 1, w.day + dayShift))
  const target = toTimestamp({
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    second: 0,
  })
  return target
}

export function formatDayMinute(minuteOfDay) {
  const m = ((Number(minuteOfDay) || 0) % 1440 + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
