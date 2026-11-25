// RSS / Atom 解析与订阅拉取：纯函数 + 一层受控网络访问。
// 来源：本项目自写（无第三方代码）。仅用 Node 内置能力，不引依赖。
//
// 分工：
//   · parseFeed(xml, { source })：把 RSS 2.0 / Atom / RDF 解析成统一的条目数组，纯函数；
//   · extractFeeds / stripHtml / normalizeEntry：清洗与归一化，纯函数；
//   · fetchFeed(url, { fetchImpl, timeoutMs })：一次带超时的抓取，网络错误收敛成 { ok:false }。
//
// 安全边界：拿到的是不可信外部内容——只取标题/摘要/链接，摘要去标签并截断，
// 绝不当指令；上层（index.mjs）再把内容交给引擎时也只给纯文本。

const MAX_TITLE = 200
const MAX_SUMMARY = 500
const MAX_ITEMS = 40

/** 去 CDATA、解常见实体、去标签、压空白。 */
export function stripHtml(text, max = MAX_SUMMARY) {
  let s = String(text ?? '')
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  s = s.replace(/<br\s*\/?>/gi, ' ')
  s = s.replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', mdash: '—', hellip: '…' }

/** 常见 HTML 实体 → 字符；数字实体转码；未知实体原样保留（宁可留着也别吞字）。 */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const n = parseInt(body.slice(2), 16)
      return Number.isFinite(n) ? safeFromCodePoint(n, whole) : whole
    }
    if (body.startsWith('#')) {
      const n = parseInt(body.slice(1), 10)
      return Number.isFinite(n) ? safeFromCodePoint(n, whole) : whole
    }
    const hit = ENTITY_MAP[body.toLowerCase()]
    return hit === undefined ? whole : hit
  })
}

function safeFromCodePoint(n, fallback) {
  try { return String.fromCodePoint(n) } catch { return fallback }
}

/** 取第一个匹配标签的内部文本（去 CDATA 与实体前的原文）。 */
function tagText(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const m = re.exec(xml)
  return m ? m[1] : ''
}

/** 取第一个匹配标签上的属性值（如 link 的 href、enclosure 的 url）。 */
function attr(xml, tag, name) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i')
  const m = re.exec(xml)
  return m ? m[1] : ''
}

/** 拆出顶层 <item> / <entry> 块。 */
function splitEntries(xml) {
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => ({ kind: 'rss', body: m[1] }))
  if (items.length) return items
  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => ({ kind: 'atom', body: m[1] }))
}

/** 频道级标题（RSS 的 channel/title、Atom 的 feed/title）。 */
export function channelTitle(xml) {
  const channel = tagText(xml, 'channel') || tagText(xml, 'feed')
  const title = tagText(channel || xml, 'title')
  return stripHtml(title, 120)
}

/**
 * 解析时间：RSS 用 pubDate（RFC822），Atom 用 updated/published（ISO）。
 * 返回毫秒时间戳，解析不了返回 0（上层按「时间未知」处理，不当成新鲜条目）。
 */
export function parseDate(text) {
  const raw = stripHtml(text, 80)
  if (!raw) return 0
  const t = Date.parse(raw)
  return Number.isFinite(t) && t > 0 ? t : 0
}

/** 单条归一化：标题、摘要、链接、时间、去重键。 */
function normalizeEntry(entry, { kind, source = '', feedTitle = '' }) {
  const body = entry.body
  const title = stripHtml(tagText(body, 'title'), MAX_TITLE)
  // 摘要优先级：description > summary > content:encoded > content
  const summaryRaw = tagText(body, 'description') || tagText(body, 'summary')
    || tagText(body, 'content:encoded') || tagText(body, 'content')
  const summary = stripHtml(summaryRaw, MAX_SUMMARY)
  // 链接：RSS 的 <link> 文本；Atom 的 <link href="...">（优先 alternate）
  let link = stripHtml(tagText(body, 'link'), 400)
  if (!link) link = attr(body, 'link', 'href')
  if (!link) link = attr(body, 'guid', 'href') || stripHtml(tagText(body, 'guid'), 400)
  const guid = stripHtml(tagText(body, 'guid') || tagText(body, 'id'), 400)
  const at = parseDate(tagText(body, 'pubDate') || tagText(body, 'published') || tagText(body, 'updated') || tagText(body, 'dc:date'))
  if (!title && !summary) return null
  // 去重键：guid/id 最稳；没有就用链接；都没有用标题+时间。
  const key = String(guid || link || `${title}|${at}`).slice(0, 300)
  if (!key) return null
  return {
    key: `${source}|${key}`,
    title,
    summary,
    link,
    at,
    feedTitle: feedTitle || '',
    source: source || feedTitle || '',
  }
}

/**
 * 解析一份订阅源。
 * @returns {{ ok:boolean, title:string, items:object[], error?:string }}
 */
export function parseFeed(xml, { source = '' } = {}) {
  const text = String(xml ?? '')
  if (!text.trim()) return { ok: false, title: '', items: [], error: '空内容' }
  if (!/<rss\b|<feed\b|<rdf:RDF\b/i.test(text)) {
    return { ok: false, title: '', items: [], error: '不像 RSS/Atom（可能抓到了网页）' }
  }
  const feedTitle = channelTitle(text)
  const items = []
  for (const entry of splitEntries(text)) {
    const it = normalizeEntry(entry, { kind: entry.kind, source, feedTitle })
    if (it) items.push(it)
  }
  // 最新在前；时间未知（0）的排最后。
  items.sort((a, b) => (b.at || 0) - (a.at || 0))
  return { ok: true, title: feedTitle, items: items.slice(0, MAX_ITEMS) }
}

/** 一行一个订阅源；去掉空行与 # 注释；只认 http(s)。 */
export function extractFeeds(text) {
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (!/^https?:\/\//i.test(line)) continue
    if (!out.includes(line)) out.push(line)
  }
  return out
}

/** 一次带超时的抓取；不跟随到非 http(s)，错误一律收敛。
 *  fetchImpl 是测试注入点（模块测试用 fake 网络）；生产默认走全局 fetch。 */
export async function fetchFeed(url, { fetchImpl = null, timeoutMs = 15000, maxBytes = 2_000_000 } = {}) {
  // 生产路径：网络访问的唯一出口（也是模块能力扫描用来识别 network 的锚点）。
  const doFetch = fetchImpl || ((...args) => fetch(...args))
  if (typeof doFetch !== 'function') return { ok: false, error: '当前环境没有 fetch' }
  if (!/^https?:\/\//i.test(String(url ?? ''))) return { ok: false, error: '只支持 http(s) 订阅源' }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await doFetch(url, {
      signal: controller ? controller.signal : undefined,
      redirect: 'follow',
      headers: {
        // 有些站按 UA 拒爬；带个明确身份，别伪装浏览器。
        'user-agent': 'AurabotRSS/1.0 (+https://github.com/aureth-labs/dsh-aurabot-qq-mods)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
      },
    })
    if (!res || !res.ok) return { ok: false, error: `HTTP ${res ? res.status : '???'}` }
    const buf = await res.arrayBuffer()
    if (buf.byteLength > maxBytes) return { ok: false, error: '内容超限' }
    const xml = new TextDecoder('utf-8').decode(buf)
    return { ok: true, xml }
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || /abort/i.test(String(error.message)))
    return { ok: false, error: aborted ? '超时' : String(error && error.message ? error.message : error).slice(0, 120) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
