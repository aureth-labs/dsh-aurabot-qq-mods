// 可选的自建 RSS。用户填了地址就优先用；失败再退回搜狗。
// 订阅地址是用户自己的，抓取前拒绝本机和内网，避免被当成内网探针。
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { imagesFromHtml, pickCalendarImage, decodeBasic } from './article.mjs'
import { readBody, shortError, signalWithTimeout } from './http.mjs'
import { beijing, titleMatches } from './time.mjs'

const PRIVATE_ADDR = [
  /^0\./, /^127\./, /^10\./, /^172\.(?:1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^::1$/i, /^f[cd][0-9a-f]{2}:/i, /^fe[89ab][0-9a-f]:/i,
]

export async function assertPublicHttp(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { throw new Error('RSS 地址不是合法链接') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('RSS 地址必须是 HTTP(S)')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host || /^(localhost|.*\.localhost)$/i.test(host)) throw new Error('RSS 地址不能指向本机')
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
  if (!addresses.length) throw new Error('RSS 地址解析不到')
  for (const { address } of addresses) {
    if (PRIVATE_ADDR.some(pattern => pattern.test(address))) throw new Error('RSS 地址指向内网，已拒绝')
  }
  url.hash = ''
  return url.href
}

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

/** 解析 RSS 2.0 / Atom。正文保留 HTML，后面还要从里面拿图片。 */
export function parseFeed(xml) {
  const text = String(xml || '')
  if (!text.trim()) return { ok: false, title: '', items: [], error: '空内容' }
  if (!/<rss\b|<feed\b|<rdf:RDF\b/i.test(text)) return { ok: false, title: '', items: [], error: '不像 RSS/Atom' }
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

export function imageFromEntry(entry) {
  return pickCalendarImage(imagesFromHtml(entry?.html || ''))
}

export async function calendarFromRss(rssUrl, stamp, { fetchImpl = (...args) => fetch(...args), signal } = {}) {
  const configured = String(rssUrl || '').trim().split(/\s+/)[0] || ''
  if (!configured) return { ok: false, missing: true, error: '' }
  let target = ''
  try { target = await assertPublicHttp(configured) } catch (error) {
    return { ok: false, missing: false, error: error.message }
  }
  let xml = ''
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
    try { await assertPublicHttp(response.url || target) } catch (error) {
      return { ok: false, missing: false, error: error.message }
    }
    xml = (await readBody(response, 2_000_000)).toString('utf8')
  } catch (error) {
    return { ok: false, missing: false, error: `RSS 拉取失败：${shortError(error)}` }
  }
  const feed = parseFeed(xml)
  if (!feed.ok) return { ok: false, missing: false, error: `RSS ${feed.error}` }
  const entry = findToday(feed.items, stamp)
  if (!entry) return { ok: false, missing: true, error: 'RSS 里没有今天的摸鱼人日历' }
  const imageUrl = imageFromEntry(entry)
  if (!imageUrl) return { ok: false, missing: false, error: 'RSS 今天的文章里没有日历图' }
  return { ok: true, source: 'rss', title: entry.title, imageUrl, articleUrl: entry.link || '' }
}
