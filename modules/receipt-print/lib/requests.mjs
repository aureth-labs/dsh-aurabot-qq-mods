// 消息打印：从 QQ 消息里抠出文字、图片和链接，把网页正文抽成小票能用的纯文本。

const decodeCQ = (s) => s
  .replace(/&#44;/g, ',')
  .replace(/&#91;/g, '[')
  .replace(/&#93;/g, ']')
  .replace(/&amp;/g, '&')

/** 把 msg.raw.message（数组或 CQ 字符串）统一成分段数组。 */
export function messageSegments(msg) {
  const source = msg?.raw?.message
  if (Array.isArray(source)) return source
  if (typeof source !== 'string') return []
  const out = []
  let end = 0
  for (const m of source.matchAll(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g)) {
    if (m.index > end) out.push({ type: 'text', data: { text: decodeCQ(source.slice(end, m.index)) } })
    const data = Object.fromEntries(m[2].slice(1).split(',').filter(Boolean).map((field) => {
      const cut = field.indexOf('=')
      return [field.slice(0, cut), decodeCQ(field.slice(cut + 1))]
    }))
    out.push({ type: m[1], data })
    end = m.index + m[0].length
  }
  if (end < source.length) out.push({ type: 'text', data: { text: decodeCQ(source.slice(end)) } })
  return out
}

/** 消息里的纯文字；宿主已经给 text 时直接用，兜底去掉 CQ 码和占位符。 */
export function messageText(msg) {
  const segments = messageSegments(msg)
  if (segments.length) return segments.filter((s) => s.type === 'text').map((s) => s.data?.text || '').join('').trim()
  return String(msg?.text || '')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/\[图片\]|\[表情包\]/g, '')
    .trim()
}

/** 消息里的图片：优先 url，只有 file 的交给调用方用 get_image 换。 */
export function messageImages(msg) {
  const out = []
  for (const seg of messageSegments(msg)) {
    if (seg.type !== 'image' && seg.type !== 'mface') continue
    if (seg.data?.url) out.push(String(seg.data.url))
    else if (seg.data?.file) out.push({ file: String(seg.data.file) })
  }
  for (const extra of msg?.images || []) {
    if (typeof extra === 'string') out.push(extra)
    else if (extra?.url) out.push(String(extra.url))
  }
  return out
}

export function firstUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s"'<>）)]+/i)
  return match ? match[0] : ''
}

// 只有明确说「打印」才出纸：普通聊天、随手发的图片和链接都不碰。
const PRINT_CALL = [
  '打印', '打出来', '打下来', '打一份', '打一张', '打一下',
  '打这个', '打这张', '打这些', '打那些', '打成小票', '打张小票', '打一份小票',
  '印出来', '印一下', '印一张', '出小票', '出张小票',
].join('|')

// 「打印机」「打印纸」不是指令
const PRINT_PREFIX = new RegExp(
  `^(?:请|麻烦|帮我|帮忙|给我|替我|你)?\\s*(?:把)?\\s*(?:${PRINT_CALL})`
  + '(?!机|纸|头|设|店|铺|厂|费|量|状态|记录|任务|队列|服务|不了|没|过)'
  + '\\s*(?:一下|下|一张|一份|一个|个|出来|吧|呗|了|啦)?'
  + '\\s*[:：,，。.!！~～\\-]*\\s*',
)

// 「把这段打印出来」把内容放在中间
const PRINT_WRAP = new RegExp(
  `^(?:请|麻烦|帮我|帮忙|给我|替我)?\\s*把\\s*([\\s\\S]+?)\\s*(?:打印|打出来|印出来|打成小票)`
  + '(?!机|纸|头|设)'
  + '\\s*(?:一下|出来|吧|呗|了|啦)?\\s*[。.!！~～]?\\s*$',
)

// 去掉指令词后只剩「这个 / 这张图 / 图片」这类指代，就当没正文
const DEICTIC = /^(?:[这那]?[张段个篇份]?(?:图|图片|照片|附件|文件|链接|网页|文章|内容|东西|文字|小票)?|它|它们|全部|都|一起|以上|以下|谢谢|吧|呗|好的?|可以)(?:吧|呗|了|啦|呀|啊|哈|谢谢)*$/

/**
 * 识别「特别嘱咐打印」的消息：返回去掉指令词后的正文，没说打印就返回 null。
 * 例：「打印 今天开会」→ { text: '今天开会' }；「帮我打印这张」+ 图片 → { text: '' }。
 */
export function parsePrintIntent(raw) {
  const source = String(raw || '').trim()
  if (!source) return null
  if (/^(?:别|不要|不用|先别|无需|不需要|不想)/.test(source)) return null
  let rest = ''
  if (PRINT_PREFIX.test(source)) {
    rest = source.replace(PRINT_PREFIX, '')
  } else {
    const wrapped = source.match(PRINT_WRAP)
    if (!wrapped) return null
    rest = wrapped[1]
  }
  rest = rest.trim().replace(/[。.!！~～]+$/, '').trim()
  if (DEICTIC.test(rest)) rest = ''
  return { text: rest }
}

// 消息里出现这些词才值得让模型判断；普通聊天不调用模型。
const PRINT_KEYWORD = /打印|打出来|打下来|印出来|出小票|打成小票|打一张|打一份/

export function looksLikePrintRequest(raw) {
  const source = String(raw || '').trim()
  if (!source || /^[/／]/.test(source)) return false
  if (/^(?:别|不要|不用|先别|无需|不需要|不想)/.test(source)) return false
  return PRINT_KEYWORD.test(source)
}

/** 模型确认要打印后，尽量把「帮我打印」「打印一下」这类指令词去掉，只留正文。 */
export function stripPrintInstructions(raw) {
  let text = String(raw || '').trim()
  text = text.replace(/^(?:请|麻烦|帮我|帮忙|给我|替我|能不能|可以|能否|可不可以|你)+/u, '')
  text = text.replace(/^(?:把)?\s*(?:打印|打出来|打下来|印出来|出小票|打成小票|打一张|打一份|打一下)(?!机|纸|头)\s*/u, '')
  text = text.replace(/(?:帮我|给我|替我)?\s*(?:打印|打出来|打下来|印出来|出小票|打成小票)(?!机|纸|头)(?:一下|下|一张|一份|一个|个|出来|吧|呗|了|啦)?[。.!！~～]?\s*$/u, '')
  text = text.trim().replace(/[。.!！~～]+$/, '').trim()
  if (DEICTIC.test(text)) text = ''
  return text
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, code) => {
    if (code[0] === '#') {
      const num = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1))
      return Number.isFinite(num) && num > 0 && num < 0x110000 ? String.fromCodePoint(num) : all
    }
    const key = code.toLowerCase()
    return Object.hasOwn(ENTITIES, key) ? ENTITIES[key] : all
  })
}

/** 网页 → { title, text }：优先 article/main/body，去掉脚本样式和标签。 */
export function htmlToText(html) {
  const raw = String(html || '')
  const title = decodeEntities((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ')).trim()
  const body = raw.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    || raw.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    || raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    || raw
  const cleaned = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(cleaned)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, index, all) => line && !(index > 0 && line === all[index - 1]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}

/** 超长截断，末尾标一句「后略」，避免一张小票打十几米。 */
export function clipText(text, maxChars) {
  const body = String(text || '').trim()
  const limit = Math.max(80, Number(maxChars) || 0)
  if (body.length <= limit) return { text: body, clipped: false }
  return { text: `${body.slice(0, limit)}…（后略）`, clipped: true }
}
