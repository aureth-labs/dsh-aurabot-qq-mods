// 模板：提示词占位符替换、模型输出清洗、打印行组装。
import { wrapText } from './layout.mjs'
import { funLines } from './fun.mjs'

export const PLACEHOLDERS = ['date', 'weekday', 'time', 'datetime', 'weekdayNum', 'width', 'paper', 'effective', 'columns', 'name']

const WEEKDAY_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

export function formatDate(now) {
  const d = now instanceof Date ? now : new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    weekday: WEEKDAY_CN[d.getDay()],
    weekdayNum: d.getDay(),
    datetime: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

export function substitute(text, vars) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match
    return String(vars[key])
  })
}

export function templateVars(template, { width, paperMm = 58, effectiveMm = 48, now = new Date() } = {}) {
  return {
    ...formatDate(now),
    // width 保留为「每行字符数」，方便旧提示词继续用
    width: String(width),
    columns: String(width),
    paper: String(paperMm),
    effective: String(effectiveMm),
    name: String(template?.name || ''),
  }
}

export function buildPrompt(template, { width, paperMm, effectiveMm, now = new Date() } = {}) {
  const vars = templateVars(template, { width, paperMm, effectiveMm, now })
  const text = substitute(template?.prompt, vars).trim()
  const system = substitute(template?.system || '你是简洁的中文助理。只输出要打印在小票上的正文，不要 Markdown、不要代码块、不要解释。', vars).trim()
  return { system, text }
}

// 模型经常不听话带 Markdown，这里只做最小清理，保留原文的换行结构。
export function cleanModelText(text, { maxChars = 1200 } = {}) {
  let out = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*```[^\n]*\n?/gm, '')
    .replace(/^\s*```\s*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '· ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const limit = Math.max(20, Number(maxChars) || 1200)
  if (out.length > limit) out = out.slice(0, limit).replace(/\s+$/, '') + '…'
  return out
}

/**
 * 组装要打印的行。标题用倍宽倍高，按半宽折行，避免溢出。
 * 返回 [{ text, style }]，preview 和 ESC/POS 共用。
 */
export function buildLines({
  template,
  body = '',
  width = 32,
  paperMm = 58,
  effectiveMm = 48,
  showHeader = true,
  footer = '',
  qr = '',
  now = new Date(),
  title,
  fun = false,
} = {}) {
  const lines = []
  const vars = templateVars(template, { width, paperMm, effectiveMm, now })
  const heading = String(title || template?.name || '').trim()

  if (showHeader) {
    if (heading) {
      const half = Math.max(4, Math.floor(width / 2))
      const wrapped = wrapText(heading, half)
      for (const line of wrapped) lines.push({ text: line, style: 'title' })
    }
    const stamp = formatDate(now)
    lines.push({ text: `${stamp.date} ${stamp.time} ${stamp.weekday}`, style: 'normal' })
    lines.push({ text: '', style: 'normal' })
  }

  const bodyLines = wrapText(body, width)
  for (const line of bodyLines) lines.push({ text: line, style: 'normal' })

  if (fun) {
    const extras = funLines({ now, name: heading, width })
    if (extras.length) {
      lines.push({ text: '', style: 'normal' })
      for (const text of extras) {
        lines.push({ text, style: text.startsWith('---') ? 'sep' : 'normal' })
      }
    }
  }

  const foot = substitute(footer, vars).trim()
  const qrData = substitute(qr, vars).trim()
  if (foot || qrData) {
    lines.push({ text: '', style: 'normal' })
    lines.push({ text: '-'.repeat(Math.max(8, Math.floor(width))), style: 'sep' })
    if (foot) {
      for (const line of wrapText(foot, width)) lines.push({ text: line, style: 'normal' })
    }
  }

  return { lines, qr: qrData }
}

export function previewText(lines) {
  return lines.map((line) => line.text).join('\n')
}
