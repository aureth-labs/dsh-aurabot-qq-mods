// 说说（空间动态）监听：从 diary 模块的 history 里挑出新条目，并收集配图。
import { existsSync } from 'node:fs'

const IMAGE_KEYS = ['images', 'pics', 'photos', 'pictures', 'media', 'attachments']

/** 说说自己的网址：优先宿主给的 url，其次用 uin + tid 拼 QQ 空间地址。 */
export function momentUrl(row) {
  const direct = String(row?.url || row?.link || row?.jumpUrl || '').trim()
  if (direct) return direct
  const tid = String(row?.tid ?? row?.id ?? '').trim()
  if (!tid) return ''
  if (/^https?:\/\//i.test(tid)) return tid
  const uin = String(row?.uin ?? row?.userId ?? row?.qq ?? row?.hostUin ?? '').trim()
  if (/^[A-Za-z0-9_-]+$/.test(tid) && /^\d{5,12}$/.test(uin)) return `https://user.qzone.qq.com/${uin}/mood/${tid}`
  return ''
}

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

const stamp = (at) => (at > 0 ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '未记录')

/**
 * 把「说说自动打印」的现状翻译成人话，排查为什么没自动打。
 * diary 状态：ok / missing（宿主没有 diary 模块）/ old（没有 history）/ error（读取抛错）
 */
export function describeMoments({ auto = true, includeSelf = false, diary = 'ok', error = '', list = [], lastAt = 0, seeded = false } = {}) {
  const lines = [`说说自动打印：${auto ? '开着' : '关着'}${includeSelf ? '（含仅自己可见）' : '（跳过仅自己可见）'}`]
  if (diary === 'missing') lines.push('diary 模块：找不到，宿主没开这个内置模块，读不到说说')
  else if (diary === 'old') lines.push('diary 模块：没有 history() 接口，宿主版本太旧')
  else if (diary === 'error') lines.push(`读取说说失败：${error || '未知错误'}`)
  else {
    const rows = Array.isArray(list) ? list : []
    const times = rows.map((row) => timeOf(row?.at ?? row?.time ?? row?.createdAt)).filter((at) => at > 0)
    lines.push(`读到 ${rows.length} 条说说，最新一条 ${stamp(times.length ? Math.max(...times) : 0)}`)
    const { rows: pending, watermark } = pickNewMoments(rows, lastAt, { includeSelf })
    lines.push(`已打印到 ${stamp(lastAt)}${seeded ? '' : '（还没初始化，下次检查只记位置、不补打旧的）'}`)
    lines.push(pending.length ? `待打印 ${pending.length} 条` : '没有新的说说')
    if (pending.length && watermark > lastAt) lines.push('水位会在打完这批后推进')
    const hidden = pickNewMoments(rows, lastAt, { includeSelf: true }).rows.length - pending.length
    if (hidden > 0) lines.push(`另有 ${hidden} 条「仅自己可见」被跳过，要打就在设置里打开「连仅自己可见的一起打」`)
  }
  lines.push('后台每 30 秒查一次；刚发完等半分钟，或用 /打印机 补打 立刻打一次。')
  return lines.join('\n')
}

export function imageTypeOf(buffer) {  if (!buffer || buffer.length < 4) return ''
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
