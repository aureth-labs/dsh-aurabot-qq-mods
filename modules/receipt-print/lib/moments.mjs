// 说说（空间动态）监听：从 diary 模块的 history 里挑出新条目，并收集配图。
import { existsSync } from 'node:fs'

const IMAGE_KEYS = ['images', 'pics', 'photos', 'pictures', 'media', 'attachments']

export function timeOf(value) {
  const normalize = (n) => {
    if (!Number.isFinite(n) || n <= 0) return 0
    // 秒级时间戳（10 位）自动补成毫秒
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
  }
  if (typeof value === 'number') return normalize(value)
  if (value instanceof Date) return normalize(value.getTime())
  const text = String(value || '').trim()
  if (!text) return 0
  const n = Number(text)
  if (Number.isFinite(n) && n > 0) return normalize(n)
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? normalize(parsed) : 0
}

/**
 * 从历史里挑出比 lastAt 新的说说，并按时间从旧到新排。
 * watermark 是这批里最新的时间，即使某些条目因为仅自己可见被跳过也要推进，
 * 免得以后打开开关又把旧说说补打出来。
 */
export function pickNewMoments(list, lastAt, { includeSelf = false } = {}) {
  const rows = (Array.isArray(list) ? list : [])
    .map((row) => ({ row, at: timeOf(row?.at ?? row?.time ?? row?.createdAt) }))
    .filter((item) => item.row && item.at > 0)
    .sort((a, b) => a.at - b.at)
  const watermark = rows.length ? rows[rows.length - 1].at : (Number(lastAt) || 0)
  const fresh = rows.filter((item) => item.at > (Number(lastAt) || 0))
  const printable = fresh
    .filter((item) => includeSelf || String(item.row.visibility || '').toLowerCase() !== 'self')
    .map((item) => item.row)
  return { rows: printable, watermark }
}

function pushSource(out, value) {
  if (!value) return
  if (typeof value === 'string') {
    const text = value.trim()
    if (text) out.push(text)
    return
  }
  if (typeof value === 'object') {
    pushSource(out, value.url || value.src || value.file || value.path || value.image || '')
  }
}

/**
 * 收集说说里的图片：结构化字段（images/pics/...）+ 正文里的 Markdown 图片和图片直链。
 * 宿主没给图片字段时，正文里的图片链接也能兜住。
 */
export function extractImageSources(row) {
  const out = []
  for (const key of IMAGE_KEYS) {
    const value = row?.[key]
    if (Array.isArray(value)) value.forEach((item) => pushSource(out, item))
    else pushSource(out, value)
  }
  const text = String(row?.text || '')
  const markdown = /!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g
  let match
  while ((match = markdown.exec(text))) pushSource(out, match[1])
  const bare = /(?:https?:\/\/|\/)[^\s"'()<>]+\.(?:png|jpe?g)(?:\?[^\s"'()<>]*)?/gi
  while ((match = bare.exec(text))) pushSource(out, match[0])
  return [...new Set(out)]
}

export function imageTypeOf(buffer) {
  if (!buffer || buffer.length < 4) return ''
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg'
  return ''
}

export function localImageExists(src) {
  try {
    return !/^https?:/i.test(src) && !/^data:/i.test(src) && existsSync(src)
  } catch {
    return false
  }
}
