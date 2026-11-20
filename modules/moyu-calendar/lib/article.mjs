// 从文章 HTML 或浏览器页面里找出日历图。
// 页面表达式只读标题、时间和图片地址，不点击、不填写验证码。
import { wait } from './http.mjs'

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—' }

/** 去 CDATA 和标签，解开常见实体。用于标题和账号名，不用于还要取图片的正文。 */
export function decodeBasic(text) {
  let value = String(text ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  value = value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try { return String.fromCodePoint(code) } catch { return whole }
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
  return value.replace(/\s+/g, ' ').trim()
}

function unescapeHtml(text) {
  let value = String(text ?? '')
  for (let i = 0; i < 2; i++) {
    const next = value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, '&')
    if (next === value) break
    value = next
  }
  return value
}

function attr(tag, name) {
  const matched = tag.match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'))
  return matched ? matched[2].replace(/&amp;/g, '&') : ''
}

/** 正文里的图片。优先 data-src（微信懒加载），其次 src。 */
export function imagesFromHtml(html) {
  const source = unescapeHtml(html)
  const images = []
  for (const tag of source.match(/<img\b[^>]*>/gi) || []) {
    const src = attr(tag, 'data-src') || attr(tag, 'src')
    if (!src) continue
    images.push({ src, w: Number(attr(tag, 'data-w')) || 0, ratio: Number(attr(tag, 'data-ratio')) || 0 })
  }
  return images
}

/** 日历图是竖版大图。横幅和 gif 表情排除；没有竖版时用第一张微信图。 */
export function pickCalendarImage(images) {
  const list = []
  for (const image of images || []) {
    let src = String(image?.src || '').trim()
    if (src.startsWith('//')) src = `https:${src}`
    src = src.split('#')[0]
    if (!/^https:\/\/mmbiz\.qpic\.cn\//i.test(src)) continue
    if (/wx_fmt=gif|\.gif(?:$|\?)/i.test(src)) continue
    list.push({ src, w: Number(image?.w) || 0, ratio: Number(image?.ratio) || 0 })
  }
  const portrait = list.find(image => image.w >= 400 && image.ratio >= 1.2)
  return (portrait || list[0])?.src || ''
}

// 在微信文章页执行。环境异常是微信的验证页，这里只报告，不尝试通过验证。
export const ARTICLE_EXPR = `(() => {
  const text = document.body ? document.body.innerText : ''
  const imgs = []
  for (const img of document.querySelectorAll('img')) {
    imgs.push({
      src: img.getAttribute('data-src') || img.getAttribute('src') || '',
      w: Number(img.getAttribute('data-w') || 0),
      ratio: Number(img.getAttribute('data-ratio') || 0),
    })
  }
  return {
    blocked: text.includes('环境异常'),
    title: document.title || '',
    nickname: typeof nickname === 'string' ? nickname.trim() : '',
    ct: Number(typeof ct === 'undefined' ? 0 : ct) || 0,
    imgs,
  }
})()`

/**
 * 打开文章后轮询，等验证页过去、图片出现。默认大约 15 秒。
 * 一直停在「环境异常」就失败，交给外层过一会再试，不破解验证码。
 */
export async function readArticle(browser, { sleep = wait, signal, attempts = 6, intervalMs = 3000 } = {}) {
  let lastError = '文章页没有返回内容'
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return { ok: false, error: '摸鱼日历模块已停止' }
    try {
      const page = await browser.evaluate(ARTICLE_EXPR)
      const image = pickCalendarImage(page?.imgs || [])
      if (image && !page?.blocked) {
        return {
          ok: true,
          title: page.title || '',
          nickname: page.nickname || '',
          ct: Number(page.ct) || 0,
          image,
        }
      }
      lastError = page?.blocked ? '微信文章页仍提示环境异常，稍后重试' : '文章里没有找到日历图'
    } catch (error) {
      lastError = error?.message ? String(error.message).slice(0, 160) : '文章页读取失败'
    }
    if (i < attempts - 1) await sleep(intervalMs, signal)
  }
  return { ok: false, error: lastError }
}
