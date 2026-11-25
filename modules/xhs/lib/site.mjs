// 小红书网页上的具体操作（DOM 解析 + 接口回执两层）。
// 小红书网页接口带 x-s / x-t 签名，页面里裸 fetch 拿不到签名 —— 所以：
//   读数据走 DOM 解析（首页推荐流、搜索、笔记详情、评论、私信气泡）；
//   写操作走 DOM 点按钮 + browser.waitResponse 等「页面自己发的」接口回执（回执不关心谁签的名）。
// 绝不自造签名、绝不裸 fetch 小红书 /api/ 接口。

import { setTimeout as sleep } from 'node:timers/promises'

const HOME = 'https://www.xiaohongshu.com/'
const CREATOR_PUBLISH = 'https://creator.xiaohongshu.com/publish/publish?source=official'
export const noteLink = (id) => `${HOME}explore/${id}`

const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0 }
const clean = (t, max = 300) => [...String(t ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('')

/** 比较可见文字时去掉空白与零宽字符（输入框会把半句话当完整，核对时要宽松一点）。 */
const comparable = (t) => String(t || '').normalize('NFC').replace(/[\s\u00a0\u200b\u200d\ufe0f]/g, '')
const typedEqual = (actual, expected) => comparable(actual) === comparable(expected)

/**
 * 从一段文字里认笔记：完整链接（/explore/<id> 或 /discovery/item/<id>，24 位十六进制）、
 * xhslink.com 短链、裸 24 位十六进制。认不出返回 null。
 */
export function findNoteId(text) {
  const s = String(text || '')
  const m = s.match(/xiaohongshu\.com\/(?:explore|discovery\/item)\/([0-9a-f]{24})/)
  if (m) return { noteId: m[1] }
  const short = s.match(/https?:\/\/xhslink\.com\/[A-Za-z0-9_-]+\/?/)
  if (short) return { short: short[0] }
  const bare = s.trim().match(/^([0-9a-f]{24})$/)
  if (bare) return { noteId: bare[1] }
  return null
}

/** 短链跳一下（最多 5 跳），拿到笔记 id；拿不到返回 ''。 */
export async function resolveShort(url, fetchImpl = fetch) {
  let cur = url
  for (let i = 0; i < 5; i++) {
    const r = await fetchImpl(cur, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' }, signal: AbortSignal.timeout(10000) })
    const loc = r.headers.get('location')
    if (!loc) break
    cur = new URL(loc, cur).toString()
    const id = findNoteId(cur)
    if (id?.noteId) return id.noteId
  }
  return ''
}

/** 数字概览：1.2万 → 12000（她看的都是同一把尺子）。 */
const wan = (n) => (n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万' : String(n))

/** 一篇笔记交给她看的样子：标题、作者、赞藏评数、正文节选、热评。 */
export function digestOf(note, comments = []) {
  const n = note || {}
  return [
    `《${n.title || '（无标题）'}》 作者：${n.author || '?'}  赞 ${wan(num(n.likes))}  藏 ${wan(num(n.collects))}  评论 ${wan(num(n.comments))}${n.isVideo ? '  视频' : '  图文'}`,
    n.desc && n.desc !== n.title ? `正文：${n.desc}` : '',
    comments.length ? '热评：\n' + comments.map((c) => `  ${c.name}：${c.text}（${wan(num(c.likes))} 赞）`).join('\n') : '',
  ].filter(Boolean).join('\n')
}

/**
 * 页面上现在有没有看得见的验证码 / 滑块。每次现查，不留标记。
 * 尺寸 > 200×150 且可见才算（广告位上的小图标不算）。
 */
export const VERIFY_PROBE = `(() => {
  const big = (n) => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 200 && r.height > 150 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.1 }
  const nodes = [...document.querySelectorAll('.captcha-container, [class*="captcha"], iframe[src*="captcha"], iframe[src*="verify"]')]
  const hit = nodes.find(big)
  if (!hit) return ''
  const t = (hit.innerText || '').slice(0, 60)
  return t || '页面弹了验证码'
})()`

export function createSite({ browser, log }) {
  const b = browser

  /** 浏览器连上并停在小红书域名下。 */
  async function ensure() {
    const r = await b.open()
    if (!r.ok) return r
    const href = String(await b.evaluate('location.href').catch(() => ''))
    if (!/^https:\/\/www\.xiaohongshu\.com/.test(href)) {
      await b.goto(HOME)
      await sleep(1500)
    }
    return { ok: true }
  }

  /** 现在有没有验证码；有就返回原因文本，没有返回 ''。 */
  const verify = () => b.evaluate(VERIFY_PROBE).then((v) => (typeof v === 'string' ? v : '')).catch(() => '')

  /** 有验证码就直接抛，写操作前置闸门。 */
  async function checkVerify() {
    const why = await verify()
    if (why) throw Object.assign(new Error('要验证：' + why), { code: 'verify' })
  }

  /**
   * 当前登录的号；没登录 / 拿不到返回 null。
   * 登录态的可靠来源是 HttpOnly cookie web_session（页面里 document.cookie 读不到它，
   * /api/sns/web/v2/user/me 裸调会 500，__INITIAL_STATE__ 是页面加载那一刻的静态快照、
   * 扫码后不会变）——所以经 CDP Network.getAllCookies 读，userId 藏在 web_session 前 8 位十六进制。
   * 昵称尽力从页面头像区取，取不到就空串（不影响「已登录」判定）。
   */
  async function self() {
    try {
      const list = await b.cookies?.(/xiaohongshu\.com/) || []
      const sess = list.find((c) => c.name === 'web_session' && String(c.value || '').trim())
      if (!sess) return null
      const hex = String(sess.value).slice(0, 8)
      const userId = /^[0-9a-f]{8}$/i.test(hex) ? String(parseInt(hex, 16)) : ''
      // 昵称：页面右上角头像区（登录后才有），拿不到就空串——不拿它当登录判据
      const nickname = String(await b.evaluate(`(() => {
        const n = document.querySelector('.user-info .name, .side-bar .user .name, [class*="user-name"], .reds-name')
        return (n && n.innerText || '').trim().slice(0, 40)
      })()`).catch(() => '') || '')
      return { userId, nickname }
    } catch (error) {
      log?.warn?.('读小红书登录状态失败：', error?.message || error)
      return null
    }
  }

  /**
   * 推荐流 / 搜索结果共用的卡片解析：卡内任意带 /explore/<id> 的链接（真实页面是
   * section.note-item 里的 a[href]，不带 cover 类）、标题、作者、封面图。
   * xsec_token 一并带出来——不带 token 打开笔记会被小红书拦成「笔记不存在」。
   */
  async function parseCards(max = 20) {
    const list = await b.evaluate(`(() => {
      const out = [], seen = new Set()
      const cards = document.querySelectorAll('section.note-item')
      const roots = cards.length ? cards : document.querySelectorAll('section, div.card, [class*="note"]')
      for (const card of roots) {
        // 卡片里有多个 a：第一个常是 style="display:none" 的空链接（不带 token）！
        // 必须优先取带 xsec_token 的那个，否则拿到的 noteId 打开就是 404。
        const links = [...card.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]')]
        const a = links.find((x) => /[?&]xsec_token=[^&]{10,}/.test(x.getAttribute('href') || ''))
          || links.find((x) => (x.getAttribute('style') || '').indexOf('none') < 0)
          || links[0]
        if (!a) continue
        const href = a.getAttribute('href') || ''
        const m = href.match(/\\/(?:explore|discovery\\/item)\\/([0-9a-f]{24})/)
        if (!m || seen.has(m[1])) continue
        seen.add(m[1])
        const tok = href.match(/[?&]xsec_token=([^&]+)/)
        const txt = (sel) => (card.querySelector(sel)?.innerText || '').trim()
        out.push({
          noteId: m[1],
          xsecToken: tok ? decodeURIComponent(tok[1]) : '',
          title: (txt('.title') || txt('[class*="title"]') || '').slice(0, 80),
          author: (txt('.author .name') || txt('[class*="author"] .name') || txt('[class*="name"]') || '').slice(0, 40),
          cover: card.querySelector('img')?.src || '',
          liked: Boolean(card.querySelector('[class*="like-wrapper"][class*="active"], [class*="like"][class*="active"]')),
        })
        if (out.length >= ${max}) break
      }
      return out
    })()`).catch(() => [])
    const list2 = Array.isArray(list) ? list.slice(0, max) : []
    // 记下每篇的 xsecToken，后面 openNote / like / comment 打开时自动带上
    for (const c of list2) if (c.xsecToken) tokens.set(String(c.noteId), c.xsecToken)
    return list2
  }

  /** 首页 / 探索页推荐流。已在对应页就不刷新（刷新会把没看完的冲走）。 */
  async function feed() {
    await checkVerify()
    const href = String(await b.evaluate('location.href').catch(() => ''))
    if (!/^https:\/\/www\.xiaohongshu\.com\/(explore)?/.test(href)) {
      await b.goto(HOME + 'explore')
    }
    await b.waitFor('section.note-item', 12000)
    // 卡片是懒加载的：先滚两屏把内容催出来，再解析，parseCards 内部有兜底滚动重试
    let cards = await parseCards(20)
    if (!cards.length) {
      await b.evaluate('window.scrollBy(0, 900)').catch(() => {})
      await new Promise((r) => setTimeout(r, 1500))
      cards = await parseCards(20)
    }
    return cards
  }

  /** 搜索：goto 搜索结果页，解析同 feed。 */
  async function search(keyword) {
    await checkVerify()
    await b.goto(HOME + 'search_result?keyword=' + encodeURIComponent(String(keyword || '')))
    await b.waitFor('section.note-item', 12000)
    let cards = await parseCards(20)
    if (!cards.length) {
      await b.evaluate('window.scrollBy(0, 900)').catch(() => {})
      await new Promise((r) => setTimeout(r, 1500))
      cards = await parseCards(20)
    }
    return cards
  }

  // 最近一次从推荐流 / 搜索结果里解析出来的 noteId → xsecToken。
  // 小红书网页版打开笔记必须带 xsec_token（不带会被拦成 404「当前笔记暂时无法浏览」），
  // 而 token 只有卡片链接里才有（有时卡片初始 href 不带，点进去时页面自己补上）。
  // 这里记一份，openNote 不显式给 token 时自动复用。
  const tokens = new Map()

  /**
   * 打开一篇笔记。三条路，按可靠性排序：
   * 1) 已有 xsecToken → 直接带 token 跳转；
   * 2) 当前在推荐流/搜索页 → **点那张卡片**（真实用户路径；页面点击时自己带 token 打开，
   *    这是唯一在「卡片 href 不带 token」的真机环境下能成功的路）；
   * 3) 都不行 → 裸链接跳转（大概率 404，如实报错）。
   */
  async function openNote(id, xsecToken = '') {
    const noteId = String(id)
    if (!/^[0-9a-f]{24}$/.test(noteId)) throw new Error('笔记 id 不对')
    await checkVerify()
    const tok = xsecToken || tokens.get(noteId) || ''

    if (tok) {
      await b.goto(`${noteLink(noteId)}?xsec_token=${encodeURIComponent(tok)}&xsec_source=pc_feed`)
    } else {
      // 在列表页上点这张卡片：先找到卡片，用真鼠标点（页面自己会带授权参数打开）
      const box = await b.evaluate(`(() => {
        for (const card of document.querySelectorAll('section.note-item')) {
          const a = card.querySelector('a[href*="/explore/${noteId}"], a[href*="/discovery/item/${noteId}"]')
          if (!a) continue
          a.scrollIntoView({ block: 'center' })
          const r = a.getBoundingClientRect()
          return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
        }
        return null
      })()`).catch(() => null)
      if (box) {
        await b.click(box.x, box.y)
        await sleep(2500)
      }
      // 点完没跳（或本来就不在列表页）才退回裸链接
      const href = String(await b.evaluate('location.href').catch(() => ''))
      if (!href.includes(noteId)) await b.goto(noteLink(noteId))
    }

    const ok = await b.waitFor('#detail-title', 12000) || await b.waitFor('.note-container', 6000)
    const href = String(await b.evaluate('location.href').catch(() => ''))
    if (/\/404|error_code=/.test(href)) {
      throw Object.assign(new Error('这篇笔记打不开（小红书返回 404「当前笔记暂时无法浏览」，多是缺访问令牌或被风控）'), { code: 'note404' })
    }
    const why = await verify()
    if (why) throw Object.assign(new Error('要验证：' + why), { code: 'verify' })
    if (!ok) throw Object.assign(new Error('笔记页面没出来（可能删了、私密或要登录）'), { code: 'note404' })
  }

  /**
   * 读一篇笔记：标题 / 正文（截 800）/ 作者 / 赞藏评数 / 是否视频，从交互栏的 count 文本转数字；
   * 热评从 .comment-item 收（最多 8 条）。滚两屏再收 —— 图文笔记的评论是懒加载的。
   */
  async function readNote(id) {
    await openNote(id)
    // 滚两屏，触发评论 / 图片懒加载
    for (let i = 0; i < 2; i++) {
      await b.evaluate('window.scrollBy(0, Math.round(window.innerHeight * 0.9))').catch(() => {})
      await sleep(600)
    }
    await b.evaluate('window.scrollTo(0, 0)').catch(() => {})
    await sleep(400)
    const data = await b.evaluate(`(() => {
      const txt = (sel) => (document.querySelector(sel)?.innerText || '').trim()
      // 交互栏里 like / collect / chat 三块的 count 文本；有些版本只有数字角标（.total）
      const countOf = (sel) => {
        const box = document.querySelector(sel)
        if (!box) return 0
        const t = (box.querySelector('.count')?.innerText || box.querySelector('.total')?.innerText || box.innerText || '').trim()
        return t
      }
      const comments = []
      // 真机实测：评论是 .parent-comment 为单元、正文在 .content；.comment-item 在网页版并不存在
      const items = document.querySelectorAll('.comment-item, .parent-comment')
      for (const item of items) {
        if (comments.length >= 8) break
        const name = (item.querySelector('.author .name, .name')?.innerText || '').trim()
        const text = (item.querySelector('.content .note-text, .note-text, .content')?.innerText || '').trim()
        if (!text) continue
        const likes = (item.querySelector('.like .count, [class*="like"] .count')?.innerText || '').trim()
        comments.push({ name: name.slice(0, 20), text: text.slice(0, 120), likes })
      }
      return {
        note: {
          noteId: ${JSON.stringify(String(id))},
          title: txt('#detail-title').slice(0, 80),
          desc: (txt('#detail-desc') || txt('.note-text')).slice(0, 800),
          author: txt('.author-wrapper .name').slice(0, 40) || txt('.author-wrapper').split('\\n')[0].slice(0, 40),
          // 真机实测：.like-wrapper / .collect-wrapper / .chat-wrapper 直接挂在页面上，
          // 没有 .interact-container 那一层（原先带前缀的选择器永远取到 0）。
          likes: countOf('.like-wrapper'),
          collects: countOf('.collect-wrapper'),
          comments: countOf('.chat-wrapper'),
          isVideo: Boolean(document.querySelector('video')),
          // 笔记配图：真机实测详情页大图在 .note-slider / .swiper-slide 里，域名 sns-webpic-*.xhscdn.com。
          // 不能按 getBoundingClientRect 过滤（懒加载图没尺寸），按「只在笔记容器内 + 排除头像/图标」取。
          cover: (() => {
            const n = document.querySelector('.note-slider img, .swiper-slide img, .media-container img, .note-content img')
            return n ? (n.getAttribute('data-src') || n.currentSrc || n.src || '') : ''
          })(),
          images: (() => {
            const seen = new Set()
            const out = []
            // 只在笔记主体容器里找，避开整页的头像 / 推荐流缩略图
            const scope = document.querySelector('.note-container, .note-content, #noteContainer, .media-container') || document
            const nodes = scope.querySelectorAll('img')
            for (const n of nodes) {
              const src = n.getAttribute('data-src') || n.currentSrc || n.src || ''
              if (!src || seen.has(src)) continue
              // 只要 xhscdn 的正图；头像/表情/图标路径里常含 avatar / emoji / icon
              if (!/xhscdn\.com/.test(src)) continue
              if (/avatar|emoji|icon|logo|sprite/i.test(src)) continue
              seen.add(src)
              out.push(src)
              if (out.length >= 9) break
            }
            return out
          })(),
        },
        comments,
      }
    })()`).catch(() => null)
    if (!data?.note) throw new Error('这篇笔记读不出来（可能删了、私密或者页面结构变了）')
    data.note.likes = num(data.note.likes)
    data.note.collects = num(data.note.collects)
    data.note.comments = num(data.note.comments)
    data.comments = data.comments.map((c) => ({ ...c, likes: num(c.likes) }))
    return data
  }

  /**
   * 点赞 / 收藏共用：先挂 waitResponse，再点对应按钮，等页面自己发的接口回执。
   * 只有 code 0 / success true 才算成功；已激活的直接返回 already，不点第二下（会变成取消）。
   */
  async function actOn(id, kind) {
    await openNote(id)
    const name = kind === 'like' ? '点赞' : '收藏'
    // 真机实测：真实 class 是 .like-wrapper / .collect-wrapper，直接挂在页面上，
    // 并没有 .interact-container 这一层（原先带前缀的选择器永远匹配不到 = 老报「找不到按钮」）。
    const sel = `.${kind}-wrapper`
    const btn = await b.waitFor(sel, 8000)
    if (!btn) throw new Error(`页面上找不到${name}按钮`)
    // 已赞/已藏状态：小红书的 class 是 like-active / collect-active，不是 active
    const active = await b.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); return Boolean(n && /(^|\\s)\\w*-?active(\\s|$)/.test(String(n.className))) })()`).catch(() => false)
    if (active) return { ok: true, already: true }
    const resp = b.waitResponse(new RegExp(`/api/sns/web/v1/note/${kind}`), 10000)
    await b.press(sel)
    const r = await resp
    if (!r) {
      // 点完没等到回执：再查一次 class，若已变 active 说明其实成功了（回执可能被风控吞掉）
      const nowActive = await b.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); return Boolean(n && /(^|\\s)\\w*-?active(\\s|$)/.test(String(n.className))) })()`).catch(() => false)
      if (nowActive) return { ok: true }
      throw new Error(`${name}没发出去（没等到小红书的回应）`)
    }
    const code = Number(r.json?.code ?? 0)
    if (!(code === 0 || r.json?.success === true)) {
      throw Object.assign(new Error(`${name}失败（${r.json?.code ?? r.status}）`), { code: r.json?.code ?? r.status })
    }
    return { ok: true }
  }

  const like = (id) => actOn(id, 'like')
  const collect = (id) => actOn(id, 'collect')

  /** 截一篇笔记的图给主人看：能定位笔记容器就截容器，截不到就整页。返回 dataURL 字符串。 */
  async function noteShot(id) {
    await openNote(id)
    if (!(await b.waitFor('.note-container', 8000))) await b.waitFor('#detail-title', 8000)
    const clip = await b.evaluate(`(() => {
      const n = document.querySelector('.note-container') || document.querySelector('.note-content') || document.querySelector('#detail-title')?.closest('[class*="note"]')
      if (!n) return null
      const r = n.getBoundingClientRect()
      return r.width > 0 && r.height > 0 ? { x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.width, height: Math.min(r.height, 4000) } : null
    })()`).catch(() => null)
    return b.screenshot(clip || undefined).catch(() => '')
  }

  // 评论 / 回复的输入框：真机实测是 p.content-input（id = content-textarea），
  // 网页版没有 #post-textarea（那是创作者发布页的）。
  const EDITOR = '#content-textarea, p.content-input'
  // 发送按钮：真机实测是 button.btn.submit，文字「发送」。
  const SEND_BTN = 'button.btn.submit'

  /**
   * 在评论框里真·@一个人：打「@昵称」，等 @ 候选弹层（最多 8s），用 React fiber 回溯
   * （照 douyin site.mjs mention() 的 __reactFiber$ 走法）按 userId 认出这个人点选，
   * 再核对编辑器里出现了提及节点（class 含 mention / at-user）。
   * 认不出就清空评论框，绝不发假 @ —— 抛 code:'mention'。
   * who = { userId, nickname }。
   */
  async function mention(who) {
    await b.type('@' + who.nickname)
    const want = String(who.userId || '')
    const uidOf = `(() => {
      // 从元素回溯 React fiber，.memoizedProps 里找带 userId 的对象（评论候选行）
      const uidOfNode = (n) => {
        const k = Object.keys(n).find((x) => x.startsWith('__reactFiber$'))
        for (let f = k && n[k], j = 0; f && j < 6; f = f.return, j++) {
          const props = f.memoizedProps
          if (!props || typeof props !== 'object') continue
          for (const v of [props.user, props.userInfo, props]) {
            if (v && typeof v === 'object') {
              const id = String(v.userId || v.user_id || v.id || '')
              if (/^\\d+$/.test(id)) return id
            }
          }
        }
        return ''
      }
      return uidOfNode
    })()`
    let picked = null
    for (let i = 0; i < 12 && !picked?.ok; i++) {
      await sleep(500)
      picked = await b.evaluate(`(() => {
        const want = ${JSON.stringify(want)}
        const uidOfNode = ${uidOf}
        // @ 候选弹层：.mention 容器或类名带 at 的浮层
        const box = document.querySelector('.mention') || [...document.querySelectorAll('[class*="at"]')].find((n) => { const r = n.getBoundingClientRect(); return r.width > 100 && r.height > 60 })
        if (!box) return { ok: false }
        const hit = [...box.querySelectorAll('div, li')].reverse().find((n) => { const id = uidOfNode(n); return id && id === want })
        if (!hit) return { ok: false, listed: true }
        for (const t of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 }))
        return { ok: true }
      })()`).catch(() => null)
    }
    await sleep(400)
    // 编辑器里出现了提及节点才算真 @ 上了（class 含 mention / at-user）
    const tagged = await b.evaluate(`[...document.querySelectorAll('p.content-input [class*="mention"], p.content-input [class*="at-user"]')].some((n) => (n.innerText || '').includes(${JSON.stringify('@' + who.nickname)}))`).catch(() => false)
    if (picked?.ok && tagged) return true
    await b.evaluate(`(() => { const e = document.querySelector('p.content-input'); e && e.focus() })()`).catch(() => {})
    await b.clearFocused().catch(() => {})
    throw Object.assign(new Error(picked?.listed ? '@ 候选里没找到主人（可能还没互相关注）' : '@ 候选没弹出来'), { code: 'mention' })
  }

  /**
   * 发评论：等输入框 → focus → 打字 → 核对框内文字（不对就清掉重打，两次不对放弃）→
   * 挂回执 → 点发送（disabled 就回车兜底）→ 回执 code 0 / success true 才算成；失败清空输入框再抛。
   * at = { userId, nickname } 时先真·@（mention 失败整体失败，不发半截）；无 at 行为与 v1 一致。
   */
  async function comment(id, text, { at } = {}) {
    await openNote(id)
    // 评论框平时不出现：先点评论按钮把评论区打开，再等输入框
    if (!(await b.evaluate(`Boolean(document.querySelector(${JSON.stringify(EDITOR)}))`).catch(() => false))) {
      await b.press('.chat-wrapper').catch(() => {})
      await sleep(1200)
    }
    if (!(await b.waitFor(EDITOR, 10000))) throw new Error('页面上找不到评论输入框')
    const focusBox = () => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(EDITOR)}); if (!e) return false; e.focus(); return document.activeElement === e })()`).catch(() => false)
    const boxText = () => b.evaluate(`(document.querySelector(${JSON.stringify(EDITOR)}) || {}).innerText || ''`).catch(() => '')
    if (!(await focusBox())) throw new Error('评论输入框点不进去')
    if (at) await mention(at)
    const expect = at ? '@' + at.nickname + text : text // 框里已经有 @ 提及节点，核对要把它算上
    for (let tries = 0; ; tries++) {
      if (!(await focusBox())) throw new Error('评论输入框点不进去')
      if (at && tries > 0) await mention(at) // 清空重打会把 @ 节点一起清掉，要重新 @
      await b.type(text)
      await sleep(400 + Math.random() * 600)
      if (typedEqual(await boxText(), expect)) break
      await b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(EDITOR)}); e && e.focus() })()`).catch(() => {})
      await b.clearFocused().catch(() => {})
      if (tries >= 1) throw new Error('评论输入框里的字对不上，没发')
    }
    const resp = b.waitResponse(/\/api\/sns\/web\/v1\/comment\/post/, 12000)
    // 真机实测：评论区输入框是 p.content-input，没有 .send-btn 这个稳定锚点。
    // 发送用「点输入框右侧可见的发送区域」→ 退而回车；两种都挂回执。
    // 真机实测：发送按钮是 button.btn.submit（文字「发送」），且必须用 DOM 点击（n.click()）——
    // 这条评论栏在页面里被模糊/遮挡，真鼠标坐标点不到（点了没反应也拿不到回执）。
    const sent = await b.evaluate(`(() => {
      const btns = [...document.querySelectorAll(${JSON.stringify(SEND_BTN)})]
        .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      const hit = btns.find((n) => /发送/.test((n.innerText || '').trim())) || btns[0]
      if (!hit) return false
      hit.click()
      return true
    })()`).catch(() => false)
    if (!sent) throw new Error('找不到评论发送按钮（页面结构可能变了）')
    const r = await resp
    try {
      if (!r) throw new Error('评论没发出去（没等到小红书的回应）')
      const code = Number(r.json?.code ?? 0)
      if (!(code === 0 || r.json?.success === true)) {
        throw Object.assign(new Error(`评论失败（${r.json?.code ?? r.status}）`), { code: r.json?.code ?? r.status })
      }
    } catch (error) {
      // 没发出去的字别留在框里（下次会接在后面，或者被当成草稿）
      await b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(EDITOR)}); e && e.focus() })()`).catch(() => {})
      await b.clearFocused().catch(() => {})
      throw error
    }
    return { ok: true, cid: String(r.json?.data?.comment?.id || '') }
  }

  /** 我自己主页上的笔记：[{ noteId, title }]（最多 20 条）。未登录抛 code:'login'。 */
  async function ownNotes() {
    const me = await self()
    if (!me?.userId) throw Object.assign(new Error('小红书还没登录，看不了自己的笔记'), { code: 'login' })
    await ensure()
    await b.goto(`${HOME}user/profile/${me.userId}`)
    await b.waitFor('section.note-item a[href]', 12000)
    const cards = await parseCards(20)
    return cards.map((c) => ({ noteId: c.noteId, title: c.title }))
  }

  /** 评论行的公共解析：cid 走 fiber props 的 comment.id，userId 走 fiber props；兜底序号+文本 hash。 */
  async function parseCommentRows(max = 30) {
    const rows = await b.evaluate(`(() => {
      const uidOfProps = (props) => {
        for (const v of [props?.user, props?.userInfo, props]) {
          if (v && typeof v === 'object') {
            const id = String(v.userId || v.user_id || v.id || '')
            if (/^\\d+$/.test(id)) return id
          }
        }
        return ''
      }
      // 从元素回溯 fiber：comment 对象挂在中上层节点的 memoizedProps 上（照 douyin readChat 的走法）
      const commentOf = (n) => {
        const k = Object.keys(n).find((x) => x.startsWith('__reactFiber$'))
        for (let f = k && n[k], j = 0; f && j < 8; f = f.return, j++) {
          const props = f.memoizedProps
          if (!props || typeof props !== 'object') continue
          const m = props.comment || props.noteComment
          if (m && typeof m === 'object' && (m.id != null)) {
            return { cid: String(m.id), userId: uidOfProps(m), nickname: String(m.userInfo?.nickname || m.user?.nickname || m.nickname || ''), text: String(m.content || m.text || '') }
          }
        }
        return null
      }
      const out = []
      let i = 0
      for (const item of document.querySelectorAll('.comment-item, .parent-comment')) {
        if (out.length >= ${max}) break
        const text = (item.querySelector('.content .note-text, .note-text, .content')?.innerText || '').trim()
        if (!text) continue
        const m = commentOf(item)
        const name = (item.querySelector('.author .name, .name')?.innerText || '').trim()
        let h = 0
        for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0
        out.push({
          cid: m?.cid || 'c' + i + '_' + h.toString(36),
          userId: m?.userId || '',
          nickname: (m?.nickname || name).slice(0, 40),
          text: text.slice(0, 300),
          idx: i, // 页面上的第几条（cid 是 hash 时靠它定位 DOM）
          _fiber: Boolean(m),
        })
        i++
      }
      return out
    })()`).catch(() => [])
    return Array.isArray(rows) ? rows.slice(0, max).map(({ _fiber, ...r }) => r) : []
  }

  /** 一篇笔记的全部一级评论：[{ cid, userId, nickname, text }]（最多 30 条；子评论本期不展开）。 */
  async function commentsOfNote(id) {
    await openNote(id)
    // 滚 4 屏，评论区是懒加载的
    for (let i = 0; i < 4; i++) {
      await b.evaluate('window.scrollBy(0, Math.round(window.innerHeight * 0.9))').catch(() => {})
      await sleep(700)
    }
    await b.evaluate('window.scrollTo(0, 0)').catch(() => {})
    await sleep(400)
    return parseCommentRows(30)
  }

  /**
   * 回复一条评论：按 cid 定位评论行（fiber props 的 comment.id 优先，兜底文本匹配）→
   * 点该行的「回复」→ 输入框 focus → 打字核对 → 发送（同 comment 的回执判定）。
   * 找不到目标评论抛错。
   */
  async function replyComment(id, cid, text, opts = {}) {
    await openNote(id)
    for (let i = 0; i < 3; i++) {
      await b.evaluate('window.scrollBy(0, Math.round(window.innerHeight * 0.9))').catch(() => {})
      await sleep(500)
    }
    // 定位目标评论行：fiber 里的 comment.id 优先；对不上就按「正文文本」找（cid 常常是我们自己算的 hash，
    // 反查不到 DOM，所以 commentsOfNote 会顺手把 text 带回来，按文本定位才可靠），
    // 最后再按序号兜底（idx 是 commentsOfNote 返回的第几条）。
    const want = JSON.stringify(String(cid || ''))
    const wantText = JSON.stringify(String(opts.text || '').trim().slice(0, 40))
    const wantIdx = Number.isInteger(opts.idx) ? opts.idx : -1
    const found = await b.evaluate(`(() => {
      const want = ${want}
      const wantText = ${wantText}
      const wantIdx = ${wantIdx}
      const commentIdOf = (n) => {
        const k = Object.keys(n).find((x) => x.startsWith('__reactFiber$'))
        for (let f = k && n[k], j = 0; f && j < 8; f = f.return, j++) {
          const m = f.memoizedProps && (f.memoizedProps.comment || f.memoizedProps.noteComment)
          if (m && typeof m === 'object' && m.id != null) return String(m.id)
        }
        return ''
      }
      const items = [...document.querySelectorAll('.comment-item, .parent-comment')]
      let hit = items.find((n) => commentIdOf(n) === want) || items.find((n) => n.querySelector('[data-cid="' + want + '"]'))
      if (!hit && wantText) hit = items.find((n) => ((n.querySelector('.content .note-text, .note-text, .content') || {}).innerText || '').trim().includes(wantText))
      if (!hit && wantIdx >= 0 && items[wantIdx]) hit = items[wantIdx]
      if (!hit) return { found: false, listed: items.length }
      document.querySelectorAll('[data-aurabot="reply-row"]').forEach((x) => x.removeAttribute('data-aurabot'))
      hit.setAttribute('data-aurabot', 'reply-row')
      hit.scrollIntoView({ block: 'center' })
      return { found: true }
    })()`).catch(() => null)
    if (!found?.found) throw new Error(`没找到要回复的那条评论（cid ${cid}，页面上有 ${found?.listed ?? 0} 条）`)
    // 点该行的「回复」（可见文本=回复的最小元素）
    const marked = await b.evaluate(`(() => {
      const row = document.querySelector('[data-aurabot="reply-row"]')
      if (!row) return false
      const all = [...row.querySelectorAll('button,div,span')].filter((n) => (n.innerText || '').trim() === '回复' && n.getBoundingClientRect().width > 0)
      const n = all.sort((a, c) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (c.getBoundingClientRect().width * c.getBoundingClientRect().height))[0]
      if (!n) return false
      document.querySelectorAll('[data-aurabot="reply-btn"]').forEach((x) => x.removeAttribute('data-aurabot'))
      n.setAttribute('data-aurabot', 'reply-btn')
      return true
    })()`).catch(() => false)
    if (!marked) throw new Error('这条评论上没有「回复」按钮')
    await b.press('[data-aurabot="reply-btn"]')
    await sleep(800)
    // 后面的打字核对 / 发送 / 回执判定和 comment 同一条链
    if (!(await b.waitFor('p.content-input', 10000))) throw new Error('回复后没弹出评论输入框')
    const focusBox = () => b.evaluate(`(() => { const e = document.querySelector('p.content-input'); if (!e) return false; e.focus(); return document.activeElement === e })()`).catch(() => false)
    const boxText = () => b.evaluate(`(document.querySelector('p.content-input') || {}).innerText || ''`).catch(() => '')
    for (let tries = 0; ; tries++) {
      if (!(await focusBox())) throw new Error('评论输入框点不进去')
      await b.type(text)
      await sleep(400 + Math.random() * 600)
      if (typedEqual(await boxText(), text)) break
      await b.evaluate(`(() => { const e = document.querySelector('p.content-input'); e && e.focus() })()`).catch(() => {})
      await b.clearFocused().catch(() => {})
      if (tries >= 1) throw new Error('回复输入框里的字对不上，没发')
    }
    const resp = b.waitResponse(/\/api\/sns\/web\/v1\/comment\/post/, 12000)
    // 回复场景的发送按钮：真机实测同样是 button.btn.submit（打上字后 class 从 "btn submit gray" 变成可用）。
    // 用 DOM 点击（真鼠标在这条浮动评论栏上点不到）。等一小会儿让按钮从禁用态转可用。
    let clicked = false
    for (let i = 0; i < 10 && !clicked; i++) {
      clicked = await b.evaluate(`(() => {
        const btns = [...document.querySelectorAll(${JSON.stringify(SEND_BTN)})]
          .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
        const hit = btns.find((n) => /发送/.test((n.innerText || '').trim())) || btns[0]
        if (!hit || hit.disabled) return false
        hit.click()
        return true
      })()`).catch(() => false)
      if (!clicked) await sleep(400)
    }
    if (!clicked) throw new Error('回复发送按钮一直不可点（页面结构可能变了）')
    const r = await resp
    try {
      if (!r) throw new Error('回复没发出去（没等到小红书的回应）')
      const code = Number(r.json?.code ?? 0)
      if (!(code === 0 || r.json?.success === true)) {
        throw Object.assign(new Error(`回复失败（${r.json?.code ?? r.status}）`), { code: r.json?.code ?? r.status })
      }
    } catch (error) {
      await b.evaluate(`(() => { const e = document.querySelector('p.content-input'); e && e.focus() })()`).catch(() => {})
      await b.clearFocused().catch(() => {})
      throw error
    }
    return { ok: true, cid: String(r.json?.data?.comment?.id || cid || '') }
  }

  /**
   * 站内把一篇笔记分享给一个人（分享面板里的笔记卡片 / 链接）：
   * who = { userId, nickname }。点分享按钮 → 等面板 → 「发给朋友」区按 fiber props 的 userId 认行；
   * 最近联系人没有就用面板搜索框搜昵称再认 → 点该行的发送/分享 → 等回执。
   * 已分享过（按钮变「已发送」类）返回 { ok, already: true }；找不到人抛 code:'share'（可能需互关）。
   */
  async function share(id, who) {
    await openNote(id)
    // 分享按钮：.share-wrapper 优先，兜底可见文本「分享」的最小可见元素
    let hit = await b.waitFor('.interact-container .share-wrapper', 5000)
    if (!hit) {
      const marked = await b.evaluate(`(() => {
        const all = [...document.querySelectorAll('button,div,span')].filter((n) => { const s = (n.innerText || '').trim(); return s === '分享' && n.getBoundingClientRect().width > 0 })
        const n = all.sort((a, c) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (c.getBoundingClientRect().width * c.getBoundingClientRect().height))[0]
        if (!n) return false
        document.querySelectorAll('[data-aurabot="share-open"]').forEach((x) => x.removeAttribute('data-aurabot'))
        n.setAttribute('data-aurabot', 'share-open')
        return true
      })()`).catch(() => false)
      if (!marked) throw new Error('页面上找不到分享按钮')
      hit = { marked: true }
    }
    await b.press('.interact-container .share-wrapper, [data-aurabot="share-open"]')
    await sleep(1000)
    // 面板里找目标人那一行：fiber props 带 userId 的；给找到的行做记号
    const findRow = () => b.evaluate(`(() => {
      const want = ${JSON.stringify(String(who.userId || ''))}
      const uidOfNode = (n) => {
        const k = Object.keys(n).find((x) => x.startsWith('__reactFiber$'))
        for (let f = k && n[k], j = 0; f && j < 8; f = f.return, j++) {
          const props = f.memoizedProps
          if (!props || typeof props !== 'object') continue
          for (const v of [props.user, props.userInfo, props]) {
            if (v && typeof v === 'object') {
              const id = String(v.userId || v.user_id || v.id || '')
              if (/^\\d+$/.test(id)) return id
            }
          }
        }
        return ''
      }
      const rows = [...document.querySelectorAll('div, li')].filter((n) => { const r = n.getBoundingClientRect(); return r.width > 150 && r.height > 30 && r.height < 120 && uidOfNode(n) })
      const row = rows.reverse().find((n) => uidOfNode(n) === want)
      if (!row) return { found: false, listed: rows.length }
      // 该行上的可点目标：文本含 发送 / 分享 / 已发送 的最小元素
      const btn = [...row.querySelectorAll('button,div,span')].reverse().find((n) => { const s = (n.innerText || '').trim(); return ['发送', '分享', '已发送'].some((k) => s.includes(k)) })
      if (!btn) return { found: false, listed: rows.length }
      const done = (btn.innerText || '').includes('已发送')
      document.querySelectorAll('[data-aurabot="share-to"]').forEach((x) => x.removeAttribute('data-aurabot'))
      btn.setAttribute('data-aurabot', 'share-to')
      return { found: true, done }
    })()`).catch(() => ({ found: false }))
    let row = await findRow()
    // 最近联系人里没有：用分享面板的搜索框搜昵称再认
    if (!row?.found && who.nickname) {
      const searched = await b.evaluate(`(() => {
        const box = [...document.querySelectorAll('input')].find((n) => /搜索|search/i.test(n.getAttribute('placeholder') || '') && n.getBoundingClientRect().width > 0)
        if (!box) return false
        box.focus()
        box.select()
        return true
      })()`).catch(() => false)
      if (searched) {
        await b.type(who.nickname)
        for (let i = 0; i < 10 && !row?.found; i++) {
          await sleep(600)
          row = await findRow()
        }
      }
    }
    if (!row?.found) throw Object.assign(new Error('分享面板里没找到主人（可能互相没关注、私信不通）'), { code: 'share' })
    if (row.done) return { ok: true, already: true }
    const resp = b.waitResponse(/web\/message|send_msg|\/api\/sns\/web\/v1\/im/, 12000)
    await b.press('[data-aurabot="share-to"]')
    const r = await resp
    if (!r) throw Object.assign(new Error('点了分享，但没等到小红书私信的回应'), { code: 'share' })
    const code = Number(r.json?.code ?? 0)
    if (r.status !== 200 && !(code === 0 || r.json?.success === true)) {
      throw Object.assign(new Error(`站内分享没发出去（HTTP ${r.status}${r.json ? '，码 ' + code : ''}）`), { code: 'share' })
    }
    return { ok: true }
  }

  /** 认一个人：user/profile/<24位> 直接过；其他 http 链接 goto 后最多等 10s 看落没落到主页。 */
  async function profileOf(link) {
    const s = String(link || '').trim()
    if (!s) throw new Error('没给小红书主页链接或用户 id')
    const direct = s.match(/xiaohongshu\.com\/user\/profile\/([0-9a-f]{24})/)?.[1] || (/^[0-9a-f]{24}$/.test(s) ? s : '')
    if (direct) {
      await ensure()
      await b.goto(`${HOME}user/profile/${direct}`)
    } else if (/^https?:\/\//i.test(s)) {
      await b.goto(s)
    } else {
      throw new Error('这个链接不是小红书主页')
    }
    // 跳转 / 重定向完再核对（链接可能经过短链落地）
    for (let i = 0; i < 10; i++) {
      const href = String(await b.evaluate('location.href').catch(() => ''))
      const uid = href.match(/xiaohongshu\.com\/user\/profile\/([0-9a-f]{24})/)?.[1]
      if (uid) {
        const nickname = await b.evaluate(`(document.querySelector('.user-name') || document.querySelector('.info-right .name') || {}).innerText || ''`).catch(() => '')
        return { userId: uid, nickname: clean(nickname, 40) }
      }
      await sleep(1000)
    }
    throw new Error('这个链接不是小红书主页（或者没跳过去）')
  }

  // ---------- 私信（best-effort：网页版结构不稳，拿不准就诚实报错，code 统一 'dm'） ----------
  const dmError = (msg) => Object.assign(new Error(msg + '（小红书网页版私信结构变了，需要人工看看）'), { code: 'dm' })

  /** 打开和某人的私信会话：按对方昵称匹配会话行（nickname 空就没法认人）。 */
  async function openChat(userId, { nickname = '' } = {}) {
    if (!nickname) throw dmError('没有昵称，私信列表里认不出这个人')
    await b.goto(HOME + 'messages')
    // 会话行 = 列表里包含对方昵称文本的可点行；给找到的那行做记号再点
    let found = false
    for (let i = 0; i < 10 && !found; i++) {
      found = await b.evaluate(`(() => {
        const want = ${JSON.stringify(String(nickname))}
        const rows = [...document.querySelectorAll('div, li, a')]
          .filter((n) => (n.innerText || '').includes(want))
          .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 100 && r.height > 40 && r.height < 160 })
        // 取包含昵称的最小行（外层容器也会包含昵称），点击才落在会话上
        const row = rows.sort((a, c) => (a.getBoundingClientRect().height - c.getBoundingClientRect().height))[0]
        if (!row) return false
        document.querySelectorAll('[data-aurabot="conv"]').forEach((x) => x.removeAttribute('data-aurabot'))
        row.setAttribute('data-aurabot', 'conv')
        return true
      })()`).catch(() => false)
      if (!found) await sleep(1000)
    }
    if (!found) throw dmError('网页版没找到私信入口或会话列表里没有这个人')
    await b.press('[data-aurabot="conv"]')
    await sleep(1500)
    const why = await verify()
    if (why) throw Object.assign(new Error('要验证：' + why), { code: 'verify' })
  }

  /** 当前会话里的消息气泡（从旧到新）：{ id, mine, text, at }；结构认不准就返回空数组。 */
  async function readChat() {
    const list = await b.evaluate(`(() => {
      const root = document.querySelector('.message-list') || [...document.querySelectorAll('[class*="message"]')].find((n) => n.querySelectorAll('div').length > 2)
      if (!root) return []
      const out = []
      let i = 0
      for (const n of root.children) {
        const text = (n.innerText || '').trim()
        if (!text) continue
        // 识别方向：气泡通常偏一侧；own / mine 类名优先，没有就按左右位置猜
        const cls = n.getAttribute('class') || ''
        const r = n.getBoundingClientRect()
        const mine = /\\b(mine|own|self|right)\\b/i.test(cls) ? true : /\\b(other|their|left)\\b/i.test(cls) ? false : r.x > window.innerWidth / 2
        const t = text.slice(0, 500)
        // id 用元素序号 + 文本 hash 兜底（网页版气泡没有稳定 id）
        let h = 0
        for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0
        out.push({ id: 'b' + i + '_' + h.toString(36), mine, text: t, at: 0 })
        i++
      }
      return out
    })()`).catch(() => [])
    return Array.isArray(list) ? list : []
  }

  /** 和某人的私信：打开会话、读消息气泡（页面在后台时消息要过一会儿才加载出来）。 */
  async function dms(userId, { nickname = '' } = {}) {
    await openChat(userId, { nickname })
    let list = []
    for (let i = 0; i < 12 && !list.length; i++) {
      list = await readChat()
      if (!list.length) await sleep(1000)
    }
    return list
  }

  /** 在当前打开的会话里发一条私信：打字核对 → 点发送；回执等不到就看气泡里有没有自己的话。 */
  async function sendDm(text) {
    const ok = await b.evaluate(`(() => {
      const e = [...document.querySelectorAll('[contenteditable="true"], textarea')].find((x) => { const r = x.getBoundingClientRect(); return r.width > 100 && r.height > 20 })
      if (!e) return false
      e.setAttribute('data-aurabot', 'dm-edit')
      e.focus()
      return document.activeElement === e
    })()`).catch(() => false)
    if (!ok) throw dmError('私信输入框点不进去')
    const inBox = () => b.evaluate(`(() => { const e = document.querySelector('[data-aurabot="dm-edit"]'); return e ? e.innerText || e.value || '' : '' })()`).catch(() => '')
    // 打完字先核对框里是不是完整的这句，不对就清掉重打一次
    for (let tries = 0; ; tries++) {
      await b.clearFocused().catch(() => {})
      await b.type(text)
      await sleep(400 + Math.random() * 600)
      if (typedEqual(await inBox(), text)) break
      if (tries >= 1) { await b.clearFocused().catch(() => {}); throw dmError('私信输入框里的字对不上，没发') }
    }
    const startedAt = Date.now()
    const resp = b.waitResponse(/web\/message|im\/|send_msg/, 8000)
    await b.pressEnter()
    const r = await resp
    if (r && r.status !== 200) {
      await b.clearFocused().catch(() => {}) // 没发出去的字别留在框里
      throw dmError(`私信没发出去（HTTP ${r.status}）`)
    }
    if (!r) {
      // 等不到回执不代表失败：看气泡里有没有「刚发出去的」自己的这句话
      await sleep(1500)
      const mine = (await readChat()).some((m) => m.mine && typedEqual(m.text, text))
      if (!mine) throw dmError('私信发送状态不确定')
      log?.info?.(`私信回执没等到，气泡里已出现发送内容，视为成功（${Date.now() - startedAt}ms）`)
    }
    return { ok: true }
  }

  /** 截二维码弹窗区域（登录弹窗可见块），没有就整页。 */
  async function loginShot() {
    const box = await b.evaluate(`(() => {
      const n = document.querySelector('.login-container') || [...document.querySelectorAll('[class*="login"]')].find((x) => { const r = x.getBoundingClientRect(); return r.width > 200 && r.height > 150 })
      if (!n) return null
      const r = n.getBoundingClientRect()
      return r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
    })()`).catch(() => null)
    return b.screenshot(box || undefined).catch(() => '')
  }

  /** 开始扫码登录：已登录直接返回；否则点「登录」，等二维码出来。 */
  async function loginStart() {
    const ok = await ensure()
    if (!ok.ok) return ok
    const me = await self()
    if (me) return { ok: true, loggedIn: true, me }
    // 「登录」按钮：可见文本=登录，取最小（最像按钮）的那个，先做记号再点
    const marked = await b.evaluate(`(() => {
      const all = [...document.querySelectorAll('button,div,span,a')].filter((n) => (n.innerText || '').trim() === '登录' && n.getBoundingClientRect().width > 0)
      const n = all.sort((a, c) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (c.getBoundingClientRect().width * c.getBoundingClientRect().height))[0]
      if (n) n.setAttribute('data-aurabot', 'login')
      return Boolean(n)
    })()`).catch(() => false)
    if (marked) await b.press('[data-aurabot="login"]')
    await b.waitFor('[class*="login"] img, [class*="login"] canvas', 12000)
    return { ok: true, loggedIn: false, shot: await loginShot() }
  }

  /** 扫码中途看一眼：登上了就返回号，要验证就给验证截图，没登上给最新的弹窗截图。 */
  async function loginPoll() {
    if (!b.connected()) return { ok: true, loggedIn: false, shot: '' }
    const why = await verify()
    if (why) return { ok: true, loggedIn: false, shot: await loginShot() }
    const me = await self().catch(() => null)
    if (me) return { ok: true, loggedIn: true, me }
    return { ok: true, loggedIn: false, shot: await loginShot() }
  }

  /**
   * 发帖（只在 duty 明确批准后调）：创作者中心 → 上传图文 tab → 塞图片 → 填标题 / 正文 →
   * 核对两框文字 → 挂回执点发布 → 回执 code 0 / success 才算成；失败清文案抛 code:'publish'。
   */
  async function publish({ title, desc, imagePaths }) {
    const t = clean(title, 20)
    const d = clean(desc, 1000)
    if (!t) throw Object.assign(new Error('标题不能为空'), { code: 'publish' })
    if (!Array.isArray(imagePaths) || !imagePaths.length) throw Object.assign(new Error('至少要有一张图（图文帖）'), { code: 'publish' })
    await b.goto(CREATOR_PUBLISH)
    // 「上传图文」tab：可见文本含「图文」，取最小那个
    const marked = await b.evaluate(`(() => {
      const all = [...document.querySelectorAll('button,div,span,li,[role="tab"]')].filter((n) => { const s = (n.innerText || '').trim(); return s.includes('图文') && s.length < 20 && n.getBoundingClientRect().width > 0 })
      const n = all.sort((a, c) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (c.getBoundingClientRect().width * c.getBoundingClientRect().height))[0]
      if (n) n.setAttribute('data-aurabot', 'publish-tab')
      return Boolean(n)
    })()`).catch(() => false)
    if (!marked) throw Object.assign(new Error('创作者中心里没找到「上传图文」入口'), { code: 'publish' })
    await b.press('[data-aurabot="publish-tab"]')
    await sleep(1000)
    if (!(await b.waitFor('#title-textarea, input[placeholder*="标题"]', 12000))) throw Object.assign(new Error('发帖页没就绪（没等到标题框）'), { code: 'publish' })
    // 图片必须是本机真实路径，setFiles 会触发页面的 change 事件
    if (!(await b.setFiles('input[type=file]', imagePaths.map(String)))) throw Object.assign(new Error('没找到图片上传的文件框'), { code: 'publish' })
    // 等上传有反应（标题框一直在，等正文框出现即可）
    await b.waitFor('#post-textarea', 20000)
    // 填标题：点进框 → 全选清掉 → 打字
    const fillBox = (sel, text) => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.focus(); return document.activeElement === e })()`).then(async (ok) => { if (!ok) return false; await b.clearFocused().catch(() => {}); await b.type(text); return true })
    if (!(await fillBox('#title-textarea, input[placeholder*="标题"]', t))) throw Object.assign(new Error('标题框点不进去'), { code: 'publish' })
    if (!(await fillBox('#post-textarea', d))) throw Object.assign(new Error('正文框点不进去'), { code: 'publish' })
    // 核对两框文字
    const readBack = await b.evaluate(`(() => {
      const t = document.querySelector('#title-textarea, input[placeholder*="标题"]')
      const d = document.querySelector('#post-textarea')
      return { t: t ? t.innerText || t.value || '' : '', d: d ? d.innerText || d.value || '' : '' }
    })()`).catch(() => ({}))
    if (!typedEqual(readBack.t, t) || !typedEqual(readBack.d, d)) {
      throw Object.assign(new Error(`发布文案核对不上（标题框「${clean(readBack.t, 40)}」正文框「${clean(readBack.d, 60)}」）`), { code: 'publish' })
    }
    const resp = b.waitResponse(/post|publish/, 15000)
    // 发布按钮：可见文本含「发布」，取最小那个；找不到就抛
    const btnOk = await b.evaluate(`(() => {
      const all = [...document.querySelectorAll('button,div,span')].filter((n) => { const s = (n.innerText || '').trim(); return s === '发布' && n.getBoundingClientRect().width > 0 })
      const n = all.sort((a, c) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (c.getBoundingClientRect().width * c.getBoundingClientRect().height))[0]
      if (!n) return false
      document.querySelectorAll('[data-aurabot="publish-btn"]').forEach((x) => x.removeAttribute('data-aurabot'))
      n.setAttribute('data-aurabot', 'publish-btn')
      return true
    })()`).catch(() => false)
    if (!btnOk) throw Object.assign(new Error('页面上找不到发布按钮'), { code: 'publish' })
    await b.press('[data-aurabot="publish-btn"]')
    const r = await resp
    try {
      if (!r) throw new Error('发布没发出去（没等到小红书的回应）')
      const code = Number(r.json?.code ?? 0)
      if (!(code === 0 || r.json?.success === true)) throw new Error(`发布失败（${r.json?.code ?? r.status}）`)
    } catch (error) {
      throw Object.assign(new Error('小红书发帖失败：' + error.message), { code: 'publish' })
    }
    return { ok: true }
  }

  return {
    ensure, verify, self, feed, search, openNote, readNote, like, collect, comment, share,
    noteShot, ownNotes, commentsOfNote, replyComment,
    profileOf, dms, sendDm, loginShot, loginStart, loginPoll, publish,
    screenshot: () => b.screenshot().catch(() => ''), show: (v) => b.show(v), connected: () => b.connected(),
  }
}
