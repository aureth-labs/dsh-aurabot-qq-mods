// 新闻采集与校验：仅使用 Node 内置能力。
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
export const LEGACY_FEEDS = 'https://www.chinanews.com.cn/rss/scroll-news.xml\nhttps://www.chinanews.com.cn/rss/world.xml\nhttps://feeds.bbci.co.uk/zhongwen/simp/rss.xml'
export const PREVIOUS_FEEDS = [
  'https://www.chinanews.com.cn/rss/scroll-news.xml',
  'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml',
  'https://www.theguardian.com/uk/technology/rss',
  'https://www.theguardian.com/science/rss',
  'https://www.ithome.com/rss/',
  'https://www.solidot.org/index.rss',
  'https://sspai.com/feed',
  'https://www.nasa.gov/feed/',
].join('\n')
export const FEED_PRESETS = [
  { url: 'https://www.chinanews.com.cn/rss/china.xml', name: '中新网', topic: '国内' },
  { url: 'https://www.chinanews.com.cn/rss/society.xml', name: '中新网', topic: '国内社会、民生' },
  { url: 'https://www.chinanews.com.cn/rss/finance.xml', name: '中新网', topic: '经济、产业、金融' },
  { url: 'https://www.ithome.com/rss/', name: 'IT之家', topic: '科技、AI、数码（仅选国内事件）' },
  { url: 'https://www.solidot.org/index.rss', name: 'Solidot', topic: '科技、科学、开源（仅选国内事件）' },
  { url: 'https://sspai.com/feed', name: '少数派', topic: '数字生活、工具（仅选国内事件）' },
]
export const DEFAULT_FEEDS = FEED_PRESETS.map(feed => feed.url).join('\n')

export function plain(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim()
}

export function httpURL(value) {
  const url = new URL(String(value).trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('新闻链接必须是 HTTP(S) 地址')
  url.hash = ''
  return url.href
}

export function beijing(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

export function parseFeed(xml, source, now = Date.now()) {
  const tag = (block, name) => block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || ''
  const entries = String(xml).match(/<item\b[^>]*>[\s\S]*?<\/item>|<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || []
  return entries.flatMap(block => {
    try {
      const title = plain(tag(block, 'title')).slice(0, 200)
      const links = [...block.matchAll(/<link\b([^>]*?)\/?\s*>/gi)].map(match => {
        const attr = name => match[1].match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1]
        return { href: attr('href'), rel: attr('rel'), type: attr('type') }
      })
      const alternate = links.find(item => item.href && (!item.rel || item.rel === 'alternate') && (!item.type || /html/i.test(item.type)))
      const rawLink = plain(tag(block, 'link')) || plain(alternate?.href)
      if (!rawLink) return []
      const link = httpURL(new URL(rawLink, source).href)
      const published = new Date(plain(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated'))).getTime()
      if (!title || !Number.isFinite(published) || published > now + 300000 || now - published > 48 * 3600000) return []
      const preset = FEED_PRESETS.find(feed => feed.url === source)
      return [{ title, link, published, source: preset?.name || new URL(source).hostname, topic: preset?.topic || '自定义来源', excerpt: plain(tag(block, 'description') || tag(block, 'summary')).slice(0, 1600) }]
    } catch { return [] }
  })
}

// 用户可自定义新闻源地址，抓取前先拒绝内网/本机目标，避免模块被当成内网探针。
const PRIVATE_ADDR = [
  /^0\./, /^127\./, /^10\./, /^172\.(?:1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^::1$/i, /^f[cd][0-9a-f]{2}:/i, /^fe[89ab][0-9a-f]:/i,
]
export async function assertPublicTarget(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Error('新闻地址没有主机名')
  if (/^(localhost|.*\.localhost)$/i.test(host)) throw new Error('新闻地址不能指向本机')
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
  if (!addresses.length) throw new Error('新闻地址解析不到')
  for (const { address } of addresses) {
    if (PRIVATE_ADDR.some((re) => re.test(address))) throw new Error('新闻地址指向内网，已拒绝')
  }
}

export async function fetchText(url, signal, maxBytes = 2_000_000) {
  const target = httpURL(url)
  await assertPublicTarget(new URL(target))
  const response = await fetch(target, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    headers: { 'User-Agent': 'Aurabot-News/1.0', Accept: 'application/rss+xml, application/atom+xml, text/html, application/xml, text/xml' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new Error('新闻页面超过大小限制')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel().catch(() => {}) }
  const bytes = Buffer.concat(chunks)
  const charset = response.headers.get('content-type')?.match(/charset=([^;\s]+)/i)?.[1]
    || bytes.subarray(0, 300).toString().match(/encoding=["']([^"']+)/i)?.[1] || 'utf-8'
  try { return new TextDecoder(charset).decode(bytes) } catch { return bytes.toString('utf8') }
}

export async function collect(settings, signal, log) {
  const feeds = [...new Set(String(settings.feeds || DEFAULT_FEEDS).split(/\s+/).filter(Boolean))].slice(0, 8)
  const warnings = []
  const results = await Promise.all(feeds.map(async url => {
    try {
      const items = parseFeed(await fetchText(url, signal), url)
      if (!items.length) throw new Error('没有最近48小时内的有效新闻')
      return items
    } catch (e) { warnings.push(`${url}：${e.message}`); return [] }
  }))
  for (const warning of warnings) log.warn('新闻源不可用', warning)
  results.forEach(items => items.sort((a, b) => b.published - a.published))
  const candidates = []
  const seen = new Set()
  const publishers = new Set(results.flat().map(item => item.source))
  const perPublisher = Math.max(5, Math.ceil(30 / Math.max(1, publishers.size)))
  const counts = new Map()
  for (let i = 0; i < 30 && candidates.length < 30; i++) {
    for (const items of results) {
      const item = items[i]
      if (!item || seen.has(item.link) || seen.has(item.title) || (counts.get(item.source) || 0) >= perPublisher) continue
      seen.add(item.link); seen.add(item.title)
      counts.set(item.source, (counts.get(item.source) || 0) + 1)
      candidates.push({ ...item, id: candidates.length + 1 })
      if (candidates.length >= 30) break
    }
  }
  if (candidates.length < 3) throw new Error('可用的近期新闻不足3条，请检查新闻源或稍后重试')
  const queue = [...candidates]
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length && !signal.aborted) {
      const item = queue.shift()
      try {
        const html = await fetchText(item.link, signal)
        const body = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
          || html.match(/<div\b[^>]*class=["'][^"']*(?:left_zw|content_text|article-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
        item.body = body ? plain(body).slice(0, 3500) : ''
      } catch { item.body = '' }
    }
  }))
  signal.throwIfAborted()
  return { candidates, warnings }
}

export function validateBrief(raw, candidates, count, domesticOnly = false) {
  const text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed.items)) throw new Error('模型没有返回有效新闻列表')
  const used = new Set()
  const items = []
  for (const entry of parsed.items) {
    if (domesticOnly && entry.domestic !== true) continue
    const source = candidates.find(item => item.id === Number(entry.id))
    if (!source || used.has(source.id) || typeof entry.headline !== 'string' || typeof entry.summary !== 'string') continue
    const headline = plain(entry.headline).slice(0, 28)
    const summary = plain(entry.summary).slice(0, 100)
    if (!headline || !summary) continue
    used.add(source.id)
    items.push({ headline, summary, link: source.link, source: source.source, published: source.published, evidence: source.body ? '正文及RSS' : 'RSS标题及摘要' })
    if (items.length >= count) break
  }
  if (items.length < 3) throw new Error('模型返回的可核对新闻不足3条，本次未生成图片')
  return items
}
