// 可选的自建 RSS。用户填了地址就优先用；失败再退回合集和搜狗。
// 订阅地址是用户自己的，抓取前默认拒绝本机和内网，避免被当成内网探针。
// 自建 RSS 常跑在局域网或本机，所以留一个「允许内网 RSS」开关，由用户自己打开。
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { imagesFromHtml, pickCalendarImage, decodeBasic } from './article.mjs'
import { readBodyTail, shortError, signalWithTimeout } from './http.mjs'
import { beijing, titleMatches } from './time.mjs'

const PRIVATE_ADDR = [
  /^0\./, /^127\./, /^10\./, /^172\.(?:1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^::1$/i, /^f[cd][0-9a-f]{2}:/i, /^fe[89ab][0-9a-f]:/i,
]

/** allowPrivate 为 true 时不拦本机和内网地址；协议和账号密码的限制始终保留。 */
export async function assertPublicHttp(value, { allowPrivate = false } = {}) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { throw new Error('RSS 地址不是合法链接') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('RSS 地址必须是 HTTP(S)')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Error('RSS 地址没有主机名')
  if (!allowPrivate && /^(localhost|.*\.localhost)$/i.test(host)) throw new Error('RSS 地址不能指向本机')
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
  if (!addresses.length) throw new Error('RSS 地址解析不到')
  if (!allowPrivate) {
    for (const { address } of addresses) {
      if (PRIVATE_ADDR.some(pattern => pattern.test(address))) throw new Error('RSS 地址指向内网，已拒绝')
    }
  }
  url.hash = ''
  return url.href
}

// 自建 RSS 多半输出全文，一期里可能带几十张图，所以最多留 10MB。
// 超过时不整条放弃，只保留末尾 10MB：新的文章排在后面（we-mp-rss 就是从旧到新排的），
// 今天的文章在末尾这一段里。全部读完累计到 50MB 还没完就不再读。
const RSS_MAX_MB = 10
const RSS_MAX_BYTES = RSS_MAX_MB * 1_000_000
const RSS_TOTAL_MAX_BYTES = RSS_MAX_BYTES * 5

function unwrap(text) {
  return String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

function tag(block, name) {
  const matched = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  return matched ? matched[1] : ''
}

function entryHtml(block) {
  const chunks = [tag(block, 'content:encoded'), tag(block, 'description'), tag(block, 'content')].map(unwrap).filter(Boolean)
  return chunks.find(chunk => /mmbiz\.qpic\.cn/.test(chunk)) || chunks[0] || ''
}

function entryLink(block) {
  const text = decodeBasic(tag(block, 'link'))
  if (/^https?:\/\//i.test(text)) return text
  const links = [...block.matchAll(/<link\b([^>]*?)\/?\s*>/gi)]
  for (const link of links) {
    const href = link[1].match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1]
    if (href) return unwrap(href).replace(/&amp;/g, '&')
  }
  return ''
}

function entryTime(block) {
  const raw = decodeBasic(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date'))
  const at = Date.parse(raw)
  return Number.isFinite(at) && at > 0 ? at : 0
}

/**
 * 解析 RSS 2.0 / Atom。正文保留 HTML，后面还要从里面拿图片。
 * partial 为 true 表示给的是末尾一段，开头的 <rss>、<channel> 已经不在了，不再按它们判断。
 */
export function parseFeed(xml, { partial = false } = {}) {
  const text = String(xml || '')
  if (!text.trim()) return { ok: false, title: '', items: [], error: '空内容' }
  if (!partial && !/<rss\b|<feed\b|<rdf:RDF\b/i.test(text)) return { ok: false, title: '', items: [], error: '不像 RSS/Atom' }
  const items = []
  const blocks = text.match(/<item\b[^>]*>[\s\S]*?<\/item>|<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || []
  for (const block of blocks) {
    const title = decodeBasic(tag(block, 'title')).slice(0, 200)
    if (!title) continue
    items.push({ title, link: entryLink(block), at: entryTime(block), html: entryHtml(block) })
  }
  items.sort((a, b) => (b.at || 0) - (a.at || 0))
  return { ok: true, title: decodeBasic(tag(text, 'title')), items }
}

export function findToday(items, stamp) {
  for (const item of items || []) {
    if (!titleMatches(item.title, stamp) || !item.at) continue
    if (beijing(new Date(item.at)).date !== stamp.date) continue
    return item
  }
  return null
}

/** 正文里的日历图。allowedOrigin 是 RSS 自己的站点，图片被 RSS 改写到那里时也认。 */
export function imageFromEntry(entry, allowedOrigin = '') {
  return pickCalendarImage(imagesFromHtml(entry?.html || ''), { allowedOrigin })
}

/** RSS 地址所在的站点，用来认 RSS 自己服务器上的图片。 */
export function feedOrigin(value) {
  try { return new URL(String(value || '')).origin } catch { return '' }
}

export async function calendarFromRss(rssUrl, stamp, { fetchImpl = (...args) => fetch(...args), signal, allowPrivate = false } = {}) {
  const configured = String(rssUrl || '').trim().split(/\s+/)[0] || ''
  if (!configured) return { ok: false, missing: true, error: '' }
  let target = ''
  try { target = await assertPublicHttp(configured, { allowPrivate }) } catch (error) {
    return { ok: false, missing: false, error: error.message }
  }
  let xml = ''
  let truncated = false
  let finalUrl = target
  try {
    const response = await fetchImpl(target, {
      redirect: 'follow',
      signal: signalWithTimeout(signal, 15000),
      headers: {
        'user-agent': 'AurabotMoyuCalendar/1.0',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
      },
    })
    if (!response?.ok) return { ok: false, missing: false, error: `RSS HTTP ${response?.status ?? ''}` }
    try { await assertPublicHttp(response.url || target, { allowPrivate }) } catch (error) {
      return { ok: false, missing: false, error: error.message }
    }
    finalUrl = response.url || target
    const body = await readBodyTail(response, RSS_MAX_BYTES, RSS_TOTAL_MAX_BYTES)
    xml = body.bytes.toString('utf8')
    truncated = body.truncated
  } catch (error) {
    return { ok: false, missing: false, error: `RSS 拉取失败：${shortError(error)}` }
  }
  // 只留了末尾一段时，最前面那一条缺了开头，解析时匹配不到整条，会整条丢掉，不会拿半篇文章去取图。
  const feed = parseFeed(xml, { partial: truncated })
  if (!feed.ok) return { ok: false, missing: false, error: `RSS ${feed.error}` }
  const entry = findToday(feed.items, stamp)
  if (!entry) {
    // 开头被丢掉时没找到不算「今天没有」，没读到的部分里有没有今天还不知道。
    if (truncated) return { ok: false, missing: false, error: `RSS 超过 ${RSS_MAX_MB}MB，末尾 ${RSS_MAX_MB}MB 里没有今天的摸鱼人日历` }
    return { ok: false, missing: true, error: 'RSS 里没有今天的摸鱼人日历' }
  }
  const origin = feedOrigin(finalUrl)
  const imageUrl = imageFromEntry(entry, origin)
  if (!imageUrl) return { ok: false, missing: false, error: 'RSS 今天的文章里没有日历图' }
  // imageOrigin 交给下载这一步：RSS 服务器上的图片只认同一个来源。note 用来说明内容被截断过。
  return {
    ok: true,
    source: 'rss',
    title: entry.title,
    imageUrl,
    articleUrl: entry.link || '',
    imageOrigin: origin,
    note: truncated ? `超过 ${RSS_MAX_MB}MB，只保留末尾 ${RSS_MAX_MB}MB` : '',
  }
}
