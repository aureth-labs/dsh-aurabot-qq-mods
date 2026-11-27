// 日期与周期计算。插件的聊天流水按本机时区的自然日分片，这里也用本机时区。

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 本机时区的 YYYY-MM-DD。无效日期返回空串。 */
export function dayKey(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input)
  if (!Number.isFinite(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 给定自然日的前一天。跨月、跨年、闰年都由 Date 处理。 */
export function prevDayKey(day) {
  if (!DAY_RE.test(String(day || ''))) return ''
  const [y, m, d] = String(day).split('-').map(Number)
  return dayKey(new Date(y, m - 1, d - 1, 12, 0, 0))
}

function hourOf(resetHour) {
  const n = Math.trunc(Number(resetHour))
  if (!Number.isFinite(n)) return 0
  return Math.min(23, Math.max(0, n))
}

/**
 * 当前所属周期日。
 * resetHour = 3 表示每天凌晨 3 点后算新的一天；3 点前仍属于昨天。
 * 这样插件半夜没开机、早上才启动，也会补做昨天的重置。
 */
export function periodOf(now = new Date(), resetHour = 0) {
  const d = new Date(now)
  if (!Number.isFinite(d.getTime())) return ''
  if (d.getHours() < hourOf(resetHour)) d.setDate(d.getDate() - 1)
  return dayKey(d)
}

/** 下一次到点的时间戳（毫秒），面板显示用。 */
export function nextResetAt(now = new Date(), resetHour = 0) {
  const d = new Date(now)
  d.setHours(hourOf(resetHour), 0, 0, 0)
  if (d.getTime() <= new Date(now).getTime()) d.setDate(d.getDate() + 1)
  return d.getTime()
}
