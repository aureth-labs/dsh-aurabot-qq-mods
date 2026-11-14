// 红果短剧站点适配层。浏览器开到一个独立资料目录里，登录一次长期用；
// 数据在页面上下文里取（fetch 自带签名 / 登录态）。
//
// 设计要点：
//   1. 推荐池统一走榜单页（每页约 20 部，卡片可见、标题齐全）
//   2. 取数走详情页 / 播放页，不放宽成「首页散点卡片」
//   3. 登录态藏在 HttpOnly cookie 里，走 CDP 读，不猜 DOM
import { VERIFY_PROBE_GENERIC } from './probe.mjs'

// 榜单页当推荐池：每页 20 部、卡片可见、<a aria-label="查看片名"> 标题齐全。
// 首页的散点卡片和 ?tab=feed 的竖向 swiper 都不适合自动化（后者滑动只动播放器层，
// 窗口在屏幕外时视频也不加载），所以统一走详情页模式。
const HG_HOME = 'https://hongguoduanju.com/rank/hot-drama'
const HG_POOLS = [
  'https://hongguoduanju.com/rank/hot-drama',
  'https://hongguoduanju.com/rank/hot-real-drama',
  'https://hongguoduanju.com/rank/hot-comic-drama',
  'https://hongguoduanju.com/rank/hot-ai-drama'
]

/** 从当前页抓所有剧集链接（<a> 里 aria-label 就是片名，卡片里的 img 就是竖版海报）。 */
const PICK_DRAMAS = `(() => {
  const out = []
  const seen = new Set()
  for (const a of document.querySelectorAll('a[href*="series_id="]')) {
    const href = a.href
    if (!href || seen.has(href)) continue
    seen.add(href)
    const label = String(a.getAttribute('aria-label') || '').replace(/^查看/, '').trim()
    const img = a.querySelector('img')
    const title = label || String((img && img.alt) || '').trim() || String(a.textContent || '').trim()
    // 封面：卡片海报（640×914 竖版，~tplv-shrink:640:0.webp，**不带签名参数、长期有效**）
    const raw = String((img && (img.currentSrc || img.src)) || '').trim()
    const cover = /novel-pic|drama|poster/i.test(raw) && !/seo\\/hongguo/i.test(raw) ? raw.slice(0, 300) : ''
    if (title) out.push({ href, title: title.slice(0, 60), cover })
  }
  return out
})()`

/** 截弹窗（登录二维码 / 验证码）；弹窗不在就截整页。 */
function shotOf (b, selectors) {
  return async function loginShot () {
    const box = await b.evaluate(`(() => {
      const sels = ${JSON.stringify(selectors)}
      let n = null
      for (const s of sels) { n = document.querySelector(s); if (n) break }
      if (!n) return null
      const r = n.getBoundingClientRect()
      return r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
    })()`).catch(() => null)
    return b.screenshot(box || undefined).catch(() => '')
  }
}

export function createSite ({ browser, log }) {
  const b = browser
  const loginShot = shotOf(b, ['#login-panel-new', '[class*="login"]', '[class*="qrcode"]'])

  /** 浏览器连上并停在红果域名下（页面请求才带登录态）。 */
  async function ensure () {
    const r = await b.open()
    if (!r.ok) return r
    const href = String(await b.evaluate('location.href').catch(() => ''))
    if (!/^https:\/\/[^/]*hongguoduanju\.com/.test(href)) {
      await b.goto(HG_HOME)
      await b.evaluate(() => {}).catch(() => {}) // 等一拍
      await new Promise((r2) => setTimeout(r2, 1500))
    }
    return { ok: true }
  }

  /** 当前登录的号；没登录返回 null。
   *  红果的登录态全在 HttpOnly cookie 里（sessionid / sid_guard / uid_tt），
   *  document.cookie 读不到，靠 DOM 猜头像也猜不准 —— 所以走 CDP 读 cookie 判定。
   *  未登录时站点只会种 ttwid（匿名设备号），没有 sessionid；扫码成功才出现。 */
  async function self () {
    try {
      const list = await b.cookies(['hongguoduanju.com'])
      const get = (...names) => {
        for (const n of names) { const v = list.find((x) => x.name === n)?.value; if (v) return v }
        return ''
      }
      const sid = get('sessionid', 'sessionid_ss', 'sid_tt')
      if (!sid || sid.length < 8) return null
      const uid = get('uid_tt', 'uid_tt_ss')
      // 昵称能读到就带上，读不到不影响登录判定
      const nickname = String(await b.evaluate(`(() => {
        const el = document.querySelector('[class*="pc-profile"] [class*="name"], [class*="nickname"], [class*="user-name"], [class*="userName"]')
        return el ? (el.textContent || '').trim().slice(0, 40) : ''
      })()`).catch(() => '') || '')
      return { nickname, uid }
    } catch (error) {
      log.debug('红果登录态检测失败：', error.message)
      return null
    }
  }

  /** 推荐池：当前页 + 几个榜单页汇总（每页约 20 部，去重后一次能拿到几十部）。
   *  红果的卡片都用 CSS Module 类名（pc-xxx-哈希），`class*="card"` 命不中；
   *  真正的剧集链接一律是 /detail?series_id=…，标题在 <a aria-label="查看片名">。 */
  async function feed () {
    const out = []
    const seen = new Set()
    const add = (list) => {
      for (const it of list || []) {
        if (!it?.href || !it.title || seen.has(it.href)) continue
        seen.add(it.href)
        out.push(it)
      }
    }
    // 当前页先抓一次（ensure 已经把浏览器停在榜单页了，省一次跳转）
    add(await b.evaluate(PICK_DRAMAS).catch(() => []))
    for (const url of HG_POOLS) {
      if (out.length >= 60) break
      const cur = String(await b.evaluate('location.href').catch(() => ''))
      if (cur.startsWith(url)) continue
      await b.goto(url).catch(() => {})
      await new Promise((r) => setTimeout(r, 1200))
      add(await b.evaluate(PICK_DRAMAS).catch(() => []))
    }
    return out
  }

  /** 剧集详情：剧名在 <h1>，简介在 p.pc-hero-desc-*（以「简介：」开头），封面在 og:image。 */
  async function detail (href) {
    const cur = String(await b.evaluate('location.href').catch(() => ''))
    if (!href || (cur !== href && !cur.startsWith(href))) await b.goto(href).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
    return b.evaluate(`(() => {
      const t = document.querySelector('h1')
      const d = document.querySelector('p[class*="hero-desc"]') || document.querySelector('[class*="desc"]')
      // 封面优先 og:image（和榜单卡片同一张 640×914），没有再在页面里找海报图
      const og = document.querySelector('meta[property="og:image"], meta[name="og:image"]')
      let cover = og && og.content ? String(og.content) : ''
      if (!cover) {
        const im = [...document.querySelectorAll('img')].find((i) => /novel-pic\\/.+shrink/i.test(i.currentSrc || i.src))
        cover = im ? String(im.currentSrc || im.src) : ''
      }
      return {
        title: String((t || {}).textContent || '').trim().slice(0, 60),
        intro: String((d || {}).textContent || '').replace(/^简介[：:]/, '').trim().slice(0, 200),
        cover: cover.slice(0, 300),
      }
    })()`).catch(() => ({ title: '', intro: '', cover: '' }))
  }

  /** 从 <video> 抓一帧（canvas，缩到长边 720，JPEG 0.62）。拿不到（还没解码 / CORS）就返回空串。 */
  const GRAB_FRAME = `(() => {
    const v = document.querySelector('video')
    if (!v || !v.videoWidth) return ''
    try {
      const cap = 720
      const sc = Math.min(1, cap / Math.max(v.videoWidth, v.videoHeight))
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(v.videoWidth * sc))
      c.height = Math.max(1, Math.round(v.videoHeight * sc))
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
      const url = c.toDataURL('image/jpeg', 0.62)
      return String(url).split(',')[1] || ''
    } catch (e) { return '' }
  })()`

  /** 抓这一集的热评（点右侧「评论」tab）。网页版**只能看不能发**，所以只当"真实观众反馈"用。
   *  返回 [{ user, text, likes }]，按点赞降序，取前 n 条。 */
  async function comments (n = 6) {
    const clicked = await b.evaluate(`(() => {
      const el = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '评论')
      if (!el) return false
      el.click()
      return true
    })()`).catch(() => false)
    if (!clicked) return []
    await new Promise((r) => setTimeout(r, 2500))

    // 评论项结构：一行评论正文 + 上一行用户名 + 下一行点赞数（没有稳定 class，只能按文本块拼）
    const raw = await b.evaluate(`(() => {
      const nums = (s) => /^\\d+$/.test(String(s).trim())
      const lines = (document.body.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean)
      // 从「评论」tab 标记之后开始，跳过 视频/评论 两个 tab 名
      let i = lines.lastIndexOf('评论')
      if (i < 0) return []
      const out = []
      // 评论区形如：正文 / 用户名 / 点赞数 三行一组，也可能是 用户名 / 正文 / 点赞数
      for (let k = i + 1; k < lines.length - 2; k++) {
        const [a, b, c] = [lines[k], lines[k + 1], lines[k + 2]]
        if (nums(c) && a && b && !nums(a) && !nums(b) && a.length > 1) {
          out.push({ user: b.slice(0, 24), text: a.slice(0, 160), likes: Number(c) })
          k += 2
        }
        if (out.length >= 12) break
      }
      return out
    })()`).catch(() => [])

    return (Array.isArray(raw) ? raw : [])
      .filter((x) => x && x.text && x.text.length > 3)
      .sort((x, y) => (y.likes || 0) - (x.likes || 0))
      .slice(0, n)
  }

  /** 真·播放一集，播够 ms 毫秒再走，顺手抓几帧画面。
   *  红果的播放页是 /player/<series_id>（不是 detail 页），<video class="pc-media-*"> 走 MSE（blob:），
   *  页面打开后**自动播放**；实测窗口挪到屏幕外（-2400,-2400）也能继续解码、currentTime 持续推进，
   *  所以收着窗口刷没问题。
   *  ⚠️ 必须静音：播放页默认带声音，不静音会把整台机器的扬声器炸掉。
   *  返回实际播了多少秒 + 抓到的画面帧（base64，给模型"真看"用）。 */
  async function play (href, ms = 30000, { frames = 3 } = {}) {
    const s = String(href || '')
    const sid = (s.match(/series_id=(\d+)/) || s.match(/\/player\/(\d+)/) || [])[1]
    if (!sid) throw new Error('链接里没有 series_id')

    await b.goto(`https://hongguoduanju.com/player/${sid}`).catch(() => {})

    // 等播放器就位（MSE 要等 readyState 到 2 才算能播）
    const VIDEO = `(() => {
      const v = document.querySelector('video')
      if (!v) return { ok: false, why: 'no-video' }
      return { ok: true, paused: v.paused, readyState: v.readyState, duration: v.duration, currentTime: v.currentTime, muted: v.muted }
    })()`
    let st = null
    for (let i = 0; i < 24; i++) {
      st = await b.evaluate(VIDEO).catch(() => null)
      if (st?.ok && st.readyState >= 2) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!st?.ok) throw new Error('播放页没有 video')

    // 静音 + 确保在播（自动播放策略可能把带声音的挡下来）
    const kick = () => b.evaluate(`(() => {
      const v = document.querySelector('video')
      if (!v) return false
      v.muted = true
      if (v.paused) { v.play && v.play().catch(() => {}) }
      return true
    })()`).catch(() => false)
    await kick()

    const t0 = Date.now()
    let last = Number(st.currentTime) || 0
    const shots = []
    const wantFrames = Math.max(0, Number(frames) || 0)
    // 抓帧时刻：多设一倍的点（过场空镜会被跳过，留余量补抓）
    const markCount = wantFrames * 2 + 1
    const marks = wantFrames
      ? Array.from({ length: markCount }, (_, i) => Math.round((ms * (i + 1)) / (markCount + 1)))
      : []
    // 空镜（黑场/纯色过场）压出来的 JPEG 很小，这种帧给模型看毫无信息量，直接丢掉
    const MIN_FRAME_CHARS = 9000
    let nextMark = 0
    while (Date.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 1500))
      const cur = await b.evaluate(VIDEO).catch(() => null)
      if (!cur?.ok) break
      if (cur.paused) {
        if (Date.now() - t0 > ms - 4000) break // 快结束了不再折腾
        await kick()
      }
      last = Number(cur.currentTime) || last
      while (nextMark < marks.length && Date.now() - t0 >= marks[nextMark] && shots.length < wantFrames) {
        const img = await b.evaluate(GRAB_FRAME).catch(() => '')
        if (img && img.length >= MIN_FRAME_CHARS) shots.push(img)
        nextMark++
      }
    }
    // 一帧都没抓到就补一张（暗场/纯色的剧也得给模型看一眼，总比没有强）
    if (wantFrames && !shots.length) {
      const img = await b.evaluate(GRAB_FRAME).catch(() => '')
      if (img) shots.push(img)
    }

    const seconds = Math.round(last)
    const wanted = Math.round(ms / 1000)
    // 播了不到 1/3 就当没看成（防止"点了播放但一直停在 0"被记成看过）
    return { seconds, wanted, ok: seconds >= Math.max(8, wanted * 0.3), frames: shots }
  }

  /** 现在有没有验证码；有就返回原因。 */
  const verify = () => b.evaluate(VERIFY_PROBE_GENERIC).catch(() => '')

  /** 开始登录：已登录直接返回；否则试着点登录入口，截二维码。 */
  async function loginStart () {
    const ok = await ensure()
    if (!ok.ok) return ok
    const me = await self()
    if (me) return { ok: true, loggedIn: true, me }
    // 通用「登录」按钮探测
    await b.evaluate(`(() => {
      const all = [...document.querySelectorAll('button,div,span,a')].filter((n) => /登录|登陆/.test(n.textContent || '') && n.getBoundingClientRect().width > 0)
      const n = all.sort((a, c) => a.getBoundingClientRect().width - c.getBoundingClientRect().width)[0]
      if (n) n.setAttribute('data-aurabot', 'login')
      return Boolean(n)
    })()`).catch(() => false)
    await b.press('[data-aurabot="login"]').catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
    return { ok: true, loggedIn: false, shot: await loginShot() }
  }

  /** 登录中途看一眼：登上了返回号，没登上给最新截图。 */
  async function loginPoll () {
    if (!b.connected()) return { ok: true, loggedIn: false, shot: '' }
    const me = await self()
    if (me) return { ok: true, loggedIn: true, me }
    return { ok: true, loggedIn: false, shot: await loginShot() }
  }

  /** 显示 / 收起浏览器窗口（主人处理验证码、扫码时看，处理完收回去）。
   *  不吞错：失败必须让面板报出来，否则又变成"提示调出来了但窗口没动"。
   *  显示时先 ensure()：连接断了要先接回/拉起浏览器，再把窗口挪进屏幕。
   *  收起时反过来：浏览器本来就没开，就别为了收起它先拉起一个。 */
  async function show (visible = true) {
    if (!visible) {
      if (!b.connected()) return false // 没开就是收着的，别为了收起它先拉起一个
      await b.show(false)
      return true
    }
    const r = await ensure()
    if (!r.ok) throw new Error(r.message || '浏览器打不开')
    await b.show(true)
    return true
  }

  return { ensure, self, feed, detail, play, comments, verify, loginStart, loginPoll, show, loginShot }
}
