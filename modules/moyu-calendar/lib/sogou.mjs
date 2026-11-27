// 用搜狗微信搜索定位当天的文章，再从跳转页拼出临时链接。
// 搜狗对非浏览器请求经常直接给验证页，所以搜索用实测能返回结果页的浏览器标识。
// 不提交验证码；遇到验证页就失败，等下一轮再试。Cookie 只留在这一轮内存里。
import { decodeBasic } from './article.mjs'
import { BROWSER_UA, cookieHeader, pinnedUrl, readBody, rememberCookies, shortError, signalWithTimeout, wait } from './http.mjs'
import { ACCOUNT, searchQuery, titleMatches, beijing } from './time.mjs'

const SOGOU = ['weixin.sogou.com']
const RESULT_RE = /<h3>\s*<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="[^"]*\ball-time-y2\b[^"]*"[^>]*>([^<]*)<\/span>[\s\S]*?timeConvert\((['"])(\d+)\4\)/g

export function searchPageUrl(stamp) {
  return `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(searchQuery(stamp))}`
}

export function parseResults(html) {
  const items = []
  // 每次新建正则，避免上次 matchAll 留下的 lastIndex 让下一轮搜空。
  for (const matched of String(html || '').matchAll(new RegExp(RESULT_RE.source, 'g'))) {
    items.push({
      href: matched[1].replace(/&amp;/g, '&'),
      title: decodeBasic(matched[2]),
      account: decodeBasic(matched[3]),
      ts: Number(matched[5]),
    })
  }
  return items
}

function publishedMs(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return 0
  return ts > 1e12 ? ts : ts * 1000
}

/** 账号名、标题日期、发布时间三者都要对上，避免误拿「打工日历」这类号。 */
export function matchToday(items, stamp) {
  for (const item of items || []) {
    if (item.account !== ACCOUNT) continue
    if (!titleMatches(item.title, stamp)) continue
    const ms = publishedMs(item.ts)
    if (!ms || beijing(new Date(ms)).date !== stamp.date) continue
    return item
  }
  return null
}

/** 跳转页用 url += '...' 拼出文章地址，中间可能夹着去掉 @ 的干扰语句。 */
export function parseLinkPage(html) {
  const parts = [...String(html || '').matchAll(/url\s*\+=\s*(['"])(.*?)\1/g)].map(matched => matched[2])
  if (!parts.length) return ''
  const raw = parts.join('').replace(/@/g, '')
  let url
  try { url = new URL(raw) } catch { return '' }
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || !url.pathname.startsWith('/s')) return ''
  return url.href
}

function blocked(html) {
  return /antispider|请输入验证码/.test(String(html || ''))
}

async function fetchHtml(url, { fetchImpl, signal, jar, referer }) {
  const target = pinnedUrl(url, SOGOU)
  if (!target) return { ok: false, missing: false, error: '搜索地址不在搜狗微信域名下' }
  try {
    const headers = {
      'user-agent': BROWSER_UA,
      accept: 'text/html,application/xhtml+xml',
    }
    const cookie = cookieHeader(jar)
    if (cookie) headers.cookie = cookie
    if (referer) headers.referer = referer
    const response = await fetchImpl(target, {
      redirect: 'follow',
      signal: signalWithTimeout(signal, 15000),
      headers,
    })
    const finalUrl = response.url || target
    if (!pinnedUrl(finalUrl, SOGOU)) return { ok: false, missing: false, error: '搜狗把请求带到了别的站点' }
    if (!response.ok) return { ok: false, missing: false, error: `搜狗 HTTP ${response.status}` }
    rememberCookies(jar, response)
    const html = (await readBody(response, 1_500_000)).toString('utf8')
    return { ok: true, html }
  } catch (error) {
    return { ok: false, missing: false, error: `搜狗请求失败：${shortError(error)}` }
  }
}

/** 找到今天这篇文章的临时链接。没有收录时 missing 为 true。 */
export async function locateArticle(stamp, { fetchImpl = (...args) => fetch(...args), signal } = {}) {
  const pageUrl = searchPageUrl(stamp)
  const jar = new Map()
  const search = await fetchHtml(pageUrl, { fetchImpl, signal, jar })
  if (!search.ok) return search
  // 搜狗拦请求时会回一个正文为空的 200，不能当成「没有收录」。
  if (!String(search.html).trim()) return { ok: false, missing: false, error: '搜狗返回了空页面，稍后再试' }
  const items = parseResults(search.html)
  if (blocked(search.html) && !items.length) return { ok: false, missing: false, error: '搜狗要求验证，稍后再试' }
  const hit = matchToday(items, stamp)
  if (!hit) return { ok: false, missing: true, error: '搜狗还没有今天的摸鱼人日历' }
  let linkUrl = ''
  try { linkUrl = new URL(hit.href, 'https://weixin.sogou.com/').href } catch { linkUrl = '' }
  if (!pinnedUrl(linkUrl, SOGOU)) return { ok: false, missing: false, error: '搜索结果链接不在搜狗域名下' }
  const jump = await fetchHtml(linkUrl, { fetchImpl, signal, jar, referer: pageUrl })
  if (!jump.ok) return jump
  const articleUrl = parseLinkPage(jump.html)
  if (!articleUrl) return { ok: false, missing: false, error: '没能从搜狗跳转页解析出文章地址' }
  return { ok: true, articleUrl, title: hit.title }
}

const PAGE_HTML = 'document.documentElement ? document.documentElement.outerHTML : ""'
const PAGE_HREF = 'location.href'

async function readPage(browser, expression) {
  const value = await browser.evaluate(expression)
  return value == null ? '' : value
}

/**
 * 普通请求被搜狗验证页拦住时，用真实浏览器打开同一个搜索地址。
 * 只等页面自己跳转，不填写验证码。
 */
export async function locateWithBrowser(browser, stamp, { sleep = wait, signal, attempts = 8, intervalMs = 1000 } = {}) {
  const pageUrl = searchPageUrl(stamp)
  const opened = await browser.navigate(pageUrl)
  if (!opened?.ok) return { ok: false, missing: false, error: opened?.message || '搜狗搜索页打开失败' }
  let sawVerification = false
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return { ok: false, missing: false, error: '摸鱼日历模块已停止' }
    const html = String(await readPage(browser, PAGE_HTML))
    const items = parseResults(html)
    if (items.length) {
      const hit = matchToday(items, stamp)
      if (!hit) return { ok: false, missing: true, error: '搜狗还没有今天的摸鱼人日历' }
      let linkUrl = ''
      try { linkUrl = new URL(hit.href, 'https://weixin.sogou.com/').href } catch { linkUrl = '' }
      if (!pinnedUrl(linkUrl, SOGOU)) return { ok: false, missing: false, error: '搜索结果链接不在搜狗域名下' }
      const jump = await browser.navigate(linkUrl)
      if (!jump?.ok) return { ok: false, missing: false, error: jump?.message || '搜狗跳转失败' }
      for (let step = 0; step < attempts; step++) {
        if (signal?.aborted) return { ok: false, missing: false, error: '摸鱼日历模块已停止' }
        const href = String(await readPage(browser, PAGE_HREF))
        if (/^https:\/\/mp\.weixin\.qq\.com\/s(\?|$)/.test(href)) {
          return { ok: true, articleUrl: href.split('#')[0], title: hit.title, alreadyOpen: true }
        }
        const parsed = parseLinkPage(String(await readPage(browser, PAGE_HTML)))
        if (parsed) {
          const moved = await browser.navigate(parsed)
          if (!moved?.ok) return { ok: false, missing: false, error: moved?.message || '文章页打开失败' }
          return { ok: true, articleUrl: parsed, title: hit.title, alreadyOpen: true }
        }
        if (step < attempts - 1) await sleep(intervalMs, signal)
      }
      return { ok: false, missing: false, error: '没能从搜狗跳转页解析出文章地址' }
    }
    if (blocked(html)) sawVerification = true
    if (i < attempts - 1) await sleep(intervalMs, signal)
  }
  if (sawVerification) return { ok: false, missing: false, error: '搜狗在浏览器里仍要求验证，稍后再试' }
  return { ok: false, missing: true, error: '搜狗还没有今天的摸鱼人日历' }
}
