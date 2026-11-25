// 北京时间与标题日期。匹配规则要同时认「11月19号」和「05月07日」。

export const ACCOUNT = '摸鱼人日历'
const HM = /^([01]\d|2[0-3]):[0-5]\d$/

export function isHm(value) {
  return HM.test(String(value || ''))
}

export function beijing(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]))
  const hour = parts.hour === '24' ? '00' : parts.hour
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
    month: Number(parts.month),
    day: Number(parts.day),
  }
}

function monthDay(stamp) {
  if (Number(stamp?.month) > 0 && Number(stamp?.day) > 0) {
    return { month: Number(stamp.month), day: Number(stamp.day) }
  }
  const matched = String(stamp?.date || '').match(/^\d{4}-(\d{2})-(\d{2})$/)
  if (!matched) return { month: 0, day: 0 }
  return { month: Number(matched[1]), day: Number(matched[2]) }
}

/** 标题必须带「[摸鱼人日历]」，并且日期就是这一天。月份、日期允许补零。 */
export function titleMatches(title, stamp) {
  const text = String(title || '')
  if (!text.includes(`[${ACCOUNT}]`)) return false
  const { month, day } = monthDay(stamp)
  if (!month || !day) return false
  const monthText = String(month).padStart(2, '0')
  const dayText = String(day).padStart(2, '0')
  const pattern = new RegExp(`(?<!\\d)(?:${monthText}|${month})月(?:${dayText}|${day})[号日]`)
  return pattern.test(text)
}

export function searchQuery(stamp) {
  const { month, day } = monthDay(stamp)
  return `${ACCOUNT} ${month}月${day}号`
}
