// 先 RSS，再读公众号合集，最后搜狗定位。文章页由逛网页打开。不关闭浏览器，它是别的模块共用的。
import { readArticle } from './article.mjs'
import { calendarFromAlbum } from './album.mjs'
import { wait } from './http.mjs'
import { calendarFromRss } from './rss.mjs'
import { locateArticle, locateWithBrowser } from './sogou.mjs'
import { ACCOUNT, beijing, titleMatches } from './time.mjs'

export const BROWSER_HINT = '没装或没打开「逛网页」（browser-ops）。请到模块市场安装它，并在它的面板打开总开关；开了站点白名单时加入 mp.weixin.qq.com 和 weixin.sogou.com。也可以改填 RSS 地址，这样就不需要浏览器。'

// 取图的来源代码对应的说法。日志、状态和面板都用这一份。
const SOURCE_LABEL = { rss: 'RSS', album: '合集', sogou: '搜狗', cache: '缓存' }

export function sourceLabel(code) {
  const text = String(code || '').trim()
  return SOURCE_LABEL[text] || text || '未知'
}

/** 把每一试过的来源写成一行：RSS：没有今天的文章 → 合集：成功。 */
export function traceText(trace) {
  return (trace || []).map(step => {
    if (step.ok) return step.note ? `${sourceLabel(step.source)}：成功（${step.note}）` : `${sourceLabel(step.source)}：成功`
    if (step.missing) return `${sourceLabel(step.source)}：没有今天的文章`
    const error = String(step.error || '').replace(/\s+/g, ' ').trim()
    return `${sourceLabel(step.source)}：${error ? error.slice(0, 40) : '失败'}`
  }).join(' → ')
}

/**
 * 找到今天的日历图地址。
 * missing 为 true 表示来源正常，但今天确实还没有文章；其余失败过一会可以重试。
 * trace 是按顺序试过的每一路和各自的结果，成功失败都带上。
 */
export async function resolveCalendar({ stamp, rssUrl, rssAllowPrivate = false, fetchImpl, browser, getBrowser, signal, sleep, attempts, intervalMs } = {}) {
  const notes = []
  // 每试一路就记一步，日志里能看到为什么没用上前一路。
  const trace = []
  const finish = (source, result) => {
    // stepError 是这一路自己的结果；搜狗失败时的 error 里还拼着前面几路的原因，不适合重复记。
    // note 是成功时的附加说明，例如 RSS 太大只读了前面一部分。
    const { stepError, note, ...rest } = result
    trace.push({ source, ok: Boolean(result.ok), missing: Boolean(result.missing), error: stepError ?? result.error ?? '', note: note || '' })
    return { ...rest, trace }
  }
  const configured = String(rssUrl || '').trim()
  let rssHardFail = false
  if (configured) {
    const rss = await calendarFromRss(configured, stamp, { fetchImpl, signal, allowPrivate: rssAllowPrivate === true })
    if (rss.ok) return finish('rss', rss)
    if (rss.error) notes.push(rss.error)
    rssHardFail = !rss.missing
    finish('rss', rss)
  }
  // 合集不用登录也不经搜狗，直接请求文章页取图，排在搜狗前面。它自己出错时不算「今天没有」。
  const album = await calendarFromAlbum(stamp, { fetchImpl, signal })
  if (album.ok) return finish('album', album)
  if (album.error) notes.push(album.error)
  const albumHardFail = !album.missing
  finish('album', album)
  const found = await viaSogou({ stamp, notes, rssHardFail, albumHardFail, fetchImpl, browser, getBrowser, signal, sleep, attempts, intervalMs })
  return finish('sogou', found)
}

/** 搜狗这一段：普通请求搜，遇到验证页改用逛网页搜，再用逛网页打开文章。不填写验证码。 */
async function viaSogou({ stamp, notes, rssHardFail, albumHardFail, fetchImpl, browser, getBrowser, signal, sleep, attempts, intervalMs }) {
  let located = await locateArticle(stamp, { fetchImpl, signal })
  let opened = browser
  const ensureBrowser = async () => {
    if (opened === undefined && getBrowser) {
      try { opened = getBrowser() } catch (error) {
        return { ok: false, missing: false, error: browserHint(error?.message) }
      }
    }
    if (!opened || typeof opened.launch !== 'function' || typeof opened.navigate !== 'function' || typeof opened.evaluate !== 'function') {
      return { ok: false, missing: false, error: BROWSER_HINT }
    }
    const launched = await opened.launch('摸鱼人日历')
    if (!launched?.ok) return { ok: false, missing: false, error: browserHint(launched?.message) }
    return { ok: true }
  }
  // 普通请求遇到验证页时，改用逛网页打开同一个搜索地址。不填写验证码。
  if (!located.ok && /验证/.test(located.error || '')) {
    const ready = await ensureBrowser()
    if (!ready.ok) return ready
    located = await locateWithBrowser(opened, stamp, { sleep: sleep || wait, signal })
  }
  if (!located.ok) {
    const error = [...notes, located.error].filter(Boolean).join('；')
    // RSS 或合集自己出错时，不能因为搜狗还没收录就当成「今天没有」。
    return { ok: false, missing: Boolean(located.missing) && !rssHardFail && !albumHardFail, error, stepError: located.error }
  }
  if (!/^https:\/\/mp\.weixin\.qq\.com\/s(\?|$)/.test(located.articleUrl)) {
    return { ok: false, missing: false, error: '文章地址不是微信文章页' }
  }
  try {
    const ready = await ensureBrowser()
    if (!ready.ok) return ready
    if (!located.alreadyOpen) {
      const nav = await opened.navigate(located.articleUrl)
      if (!nav?.ok) return { ok: false, missing: false, error: browserHint(nav?.message || '文章页打开失败') }
    }
    const article = await readArticle(opened, {
      sleep: sleep || wait,
      signal,
      attempts,
      intervalMs,
      // 同一个浏览器标签可能还停在昨天的文章上，标题不是今天就继续等页面换掉。
      accept: (page) => titleMatches(page.title, stamp),
    })
    if (!article.ok) {
      if (article.title && !titleMatches(article.title, stamp)) {
        const seen = String(article.title).replace(/\s+/g, ' ').slice(0, 40)
        return { ok: false, missing: false, error: `文章标题对不上今天（打开的是：${seen}）` }
      }
      return { ok: false, missing: false, error: article.error }
    }
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

function browserHint(message) {
  const text = String(message || '')
  if (!text || /总开关|没开|没连接|不可用/.test(text)) return BROWSER_HINT
  if (text.includes('白名单')) return `${text}。请加入 mp.weixin.qq.com 和 weixin.sogou.com，或把白名单留空`
  return text
}

function unixMs(ct) {
  const value = Number(ct)
  if (!Number.isFinite(value) || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}
