// 先 RSS，不行再搜狗定位并用浏览器打开文章。不关闭浏览器，它是别的模块共用的。
import { readArticle } from './article.mjs'
import { wait } from './http.mjs'
import { calendarFromRss } from './rss.mjs'
import { locateArticle } from './sogou.mjs'
import { ACCOUNT, beijing, titleMatches } from './time.mjs'

export const BROWSER_HINT = '没装或没打开「逛网页」（browser-ops）。请到模块市场安装它，并在它的面板打开总开关；开了站点白名单时加入 mp.weixin.qq.com。也可以改填 RSS 地址，这样就不需要浏览器。'

function browserHint(message) {
  const text = String(message || '')
  if (!text || /总开关|没开|没连接|不可用/.test(text)) return BROWSER_HINT
  if (text.includes('白名单')) return `${text}。请加入 mp.weixin.qq.com，或把白名单留空`
  return text
}

function unixMs(ct) {
  const value = Number(ct)
  if (!Number.isFinite(value) || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

/**
 * 找到今天的日历图地址。
 * missing 为 true 表示来源正常，但今天确实还没有文章；其余失败过一会可以重试。
 */
export async function resolveCalendar({ stamp, rssUrl, fetchImpl, browser, getBrowser, signal, sleep, attempts, intervalMs } = {}) {
  const notes = []
  const configured = String(rssUrl || '').trim()
  let rssHardFail = false
  if (configured) {
    const rss = await calendarFromRss(configured, stamp, { fetchImpl, signal })
    if (rss.ok) return rss
    if (rss.error) notes.push(rss.error)
    rssHardFail = !rss.missing
  }
  const located = await locateArticle(stamp, { fetchImpl, signal })
  if (!located.ok) {
    const error = [...notes, located.error].filter(Boolean).join('；')
    // RSS 自己出错时，不能因为搜狗还没收录就当成「今天没有」。
    return { ok: false, missing: Boolean(located.missing) && !rssHardFail, error }
  }
  if (!/^https:\/\/mp\.weixin\.qq\.com\/s(\?|$)/.test(located.articleUrl)) {
    return { ok: false, missing: false, error: '文章地址不是微信文章页' }
  }
  // RSS 已经成功时不会走到这里。浏览器只在真要打开文章时才取，避免白开一轮。
  let opened = browser
  if (opened === undefined && getBrowser) {
    try { opened = getBrowser() } catch (error) {
      return { ok: false, missing: false, error: browserHint(error?.message) }
    }
  }
  if (!opened || typeof opened.launch !== 'function' || typeof opened.navigate !== 'function' || typeof opened.evaluate !== 'function') {
    return { ok: false, missing: false, error: BROWSER_HINT }
  }
  try {
    const launched = await opened.launch('摸鱼人日历')
    if (!launched?.ok) return { ok: false, missing: false, error: browserHint(launched?.message) }
    const nav = await opened.navigate(located.articleUrl)
    if (!nav?.ok) return { ok: false, missing: false, error: browserHint(nav?.message || '文章页打开失败') }
    const article = await readArticle(opened, { sleep: sleep || wait, signal, attempts, intervalMs })
    if (!article.ok) return { ok: false, missing: false, error: article.error }
    if (article.nickname && article.nickname !== ACCOUNT) {
      return { ok: false, missing: false, error: `打开的账号是「${article.nickname}」，不是摸鱼人日历` }
    }
    const published = unixMs(article.ct)
    if (published && beijing(new Date(published)).date !== stamp.date) {
      return { ok: false, missing: false, error: '文章不是今天的' }
    }
    if (article.title && !titleMatches(article.title, stamp)) {
      return { ok: false, missing: false, error: '文章标题对不上今天' }
    }
    return {
      ok: true,
      source: 'sogou',
      title: article.title || located.title,
      imageUrl: article.image,
      articleUrl: located.articleUrl,
    }
  } catch (error) {
    return { ok: false, missing: false, error: browserHint(error?.message) }
  }
}
