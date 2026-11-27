// 公众号把每期日历放进同一个合集，合集列表不用登录就能读到。先读它来定位当天的文章，不经过搜狗。
// 这是微信内部用的接口，不是给第三方的正式接口：参数或返回结构变了，这里要跟着改。
import { decodeBasic, imagesFromHtml, pickCalendarImage } from './article.mjs'
import { BROWSER_UA, pinnedUrl, readBody, shortError, signalWithTimeout } from './http.mjs'
import { ACCOUNT, beijing, titleMatches } from './time.mjs'

const HOSTS = ['mp.weixin.qq.com']
// 公众号「摸鱼人日历」的账号标识和日历合集的编号。号主换了合集就要更新。
export const ALBUM_BIZ = 'MzAxOTYyMzczNA=='
export const ALBUM_ID = '3743225907507462153'

export function albumListUrl() {
  return `https://mp.weixin.qq.com/mp/appmsgalbum?action=getalbum&__biz=${ALBUM_BIZ}&album_id=${ALBUM_ID}&count=20&f=json`
}

/** 解析合集列表。接口每次最多给 20 条，最新的在前。 */
export function parseAlbum(raw) {
  let data
  try { data = JSON.parse(String(raw || '')) } catch { return { ok: false, items: [], error: '合集返回的不是 JSON' } }
  const status = data?.base_resp || {}
  if (Number(status.ret ?? 0) !== 0) return { ok: false, items: [], error: `合集接口报错 ${status.errmsg || status.ret}` }
  const list = data?.getalbum_resp?.article_list
  if (!Array.isArray(list)) return { ok: false, items: [], error: '合集返回里没有文章列表' }
  const items = list
    .map(item => ({ title: decodeBasic(item?.title), url: String(item?.url || ''), ts: Number(item?.create_time) || 0 }))
    .filter(item => item.title && item.url)
  return { ok: true, items }
}

/** 合集给的是 http 链接，换成 https。只认微信文章页的 /s 地址。 */
export function articleUrl(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { return '' }
  if (url.protocol === 'http:') url.protocol = 'https:'
  const target = pinnedUrl(url.href, HOSTS)
  if (!target) return ''
  return /^\/s(?:\/|$)/.test(new URL(target).pathname) ? target : ''
}

function publishedMs(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return 0
  return ts > 1e12 ? ts : ts * 1000
}

/** 标题日期和发布时间都要对上今天。 */
export function findTodayArticle(items, stamp) {
  for (const item of items || []) {
    if (!titleMatches(item.title, stamp)) continue
    const ms = publishedMs(item.ts)
    if (!ms || beijing(new Date(ms)).date !== stamp.date) continue
    return item
  }
  return null
}

/** 从文章页脚本变量里读账号名、标题和发布时间，用来核对打开的确实是这一篇。 */
export function articleMeta(html) {
  const pick = pattern => {
    const matched = String(html || '').match(pattern)
    return matched ? decodeBasic(matched[1]) : ''
  }
  return {
    nickname: pick(/\bvar\s+nickname\s*=\s*(?:htmlDecode\(\s*)?["']([^"']*)["']/),
    title: pick(/\bvar\s+msg_title\s*=\s*["']([^"']*)["']/),
    ct: Number(pick(/\bvar\s+ct\s*=\s*["'](\d+)["']/)) || 0,
  }
}

async function getText(url, { fetchImpl, signal, maxBytes, accept }) {
  const target = pinnedUrl(url, HOSTS)
  if (!target) return { ok: false, error: '地址不在微信公众平台的域名下' }
  try {
    const response = await fetchImpl(target, {
      redirect: 'follow',
      signal: signalWithTimeout(signal, 20000),
      headers: { 'user-agent': BROWSER_UA, accept, 'accept-language': 'zh-CN,zh;q=0.9' },
    })
    if (!pinnedUrl(response.url || target, HOSTS)) return { ok: false, error: '微信把请求带到了别的站点' }
    if (!response.ok) return { ok: false, error: `微信 HTTP ${response.status}` }
    const text = (await readBody(response, maxBytes)).toString('utf8')
    return { ok: true, text }
  } catch (error) {
    return { ok: false, error: `微信请求失败：${shortError(error)}` }
  }
}

/**
 * 读合集列表，找到今天的文章，再从文章页取日历图。
 * missing 为 true 表示合集读到了，但里面还没有今天的文章；其余失败过一会可以重试。
 */
export async function calendarFromAlbum(stamp, { fetchImpl = (...args) => fetch(...args), signal } = {}) {
  const list = await getText(albumListUrl(), { fetchImpl, signal, maxBytes: 2_000_000, accept: 'application/json, text/plain, */*' })
  if (!list.ok) return { ok: false, missing: false, error: list.error }
  const album = parseAlbum(list.text)
  if (!album.ok) return { ok: false, missing: false, error: album.error }
  const hit = findTodayArticle(album.items, stamp)
  if (!hit) return { ok: false, missing: true, error: '合集里还没有今天的摸鱼人日历' }
  const target = articleUrl(hit.url)
  if (!target) return { ok: false, missing: false, error: '合集里的文章地址不是微信文章页' }
  // 文章页约 4MB。普通请求偶尔拿到「环境异常」页，不破解，交给外层重试。
  const page = await getText(target, { fetchImpl, signal, maxBytes: 6_000_000, accept: 'text/html,application/xhtml+xml' })
  if (!page.ok) return { ok: false, missing: false, error: page.error }
  if (/环境异常/.test(page.text)) return { ok: false, missing: false, error: '微信文章页提示环境异常，稍后重试' }
  const imageUrl = pickCalendarImage(imagesFromHtml(page.text))
  if (!imageUrl) return { ok: false, missing: false, error: '文章里没有找到日历图' }
  const meta = articleMeta(page.text)
  if (meta.nickname && meta.nickname !== ACCOUNT) return { ok: false, missing: false, error: `打开的账号是「${meta.nickname}」，不是摸鱼人日历` }
  if (meta.ct && beijing(new Date(meta.ct * 1000)).date !== stamp.date) return { ok: false, missing: false, error: '文章不是今天的' }
  if (meta.title && !titleMatches(meta.title, stamp)) return { ok: false, missing: false, error: '文章标题对不上今天' }
  return { ok: true, source: 'album', title: meta.title || hit.title, imageUrl, articleUrl: target }
}
