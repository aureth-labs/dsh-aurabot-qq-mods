// 红果短剧业务层：定时 tick → 到点 run() → 拿推荐流 → 逐个真播一集 →
// 让模型看着画面写感受 → QQ 私聊分享。风控 / 没登录就停，第二天再试。
const __lib = globalThis.aurabot.lib
const { readJson, writeJson } = __lib('core/store.js')
const { isSilence } = __lib('chat/reply.js')
const { permOf } = __lib('chat/access.js')
// 能"看图"的底层通道：核心 llm 直接支持 images（附件服务登记后模型适配层才认）
let askModel = null
try { ({ askModel } = __lib('core/llm.js')) } catch (error) { /* 老版本没有就算了，退回纯文字 */ }

import { createBrowser } from './browser.mjs'
import { createSite } from './site.mjs'

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const between = (min, max) => Math.floor(min + Math.random() * Math.max(0, max - min))

export function createHongguo ({ getConfig, hub, memory, log, dataDir, site: injected, browser: injectedBrowser, now = Date.now, wait, dsh } = {}) {
  const cfg = () => getConfig().hongguo
  const sleep = wait || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const owner = () => getConfig().ownerName || '主人'
  const dir = dataDir || ((...p) => p.join('/'))

  const browser = injectedBrowser || createBrowser({
    profileDir: dir('edge-profile'),
    browserPath: () => cfg().browserPath,
    log,
    now,
    useEgo: () => getConfig().browser?.useDshSidebar === true
  })
  const site = injected || createSite({ browser, log })

  // 启动时就把"能不能看图"说清楚，省得以后又靠猜：没法看图就只能读简介和热评
  if (askModel && dsh) log?.info?.('红果：看图通道就绪（播放时抓帧 → 交给模型自己看画面）')
  else log?.warn?.(`红果：没有看图通道（askModel=${!!askModel} dsh=${!!dsh}），这轮只能靠简介和热评`)

  const file = () => dir('hongguo.json')
  const load = () => readJson(file(), () => ({ day: '', watched: 0, shares: 0, seen: [], history: [], lastRun: 0, pauseDay: '', pauseReason: '' }))
  const save = (s) => writeJson(file(), s)
  const record = (s, item) => { s.history = [...(s.history || []), { ts: now(), ...item }].slice(-200) }

  const paused = (s) => s.pauseDay === dayKey(new Date(now()))
  function pauseAll (s, why) {
    s.pauseDay = dayKey(new Date(now()))
    s.pauseReason = String(why || '').slice(0, 120)
    log.warn('红果今天先停：', s.pauseReason)
  }

  async function think (prompt) {
    const out = await hub.runSystemTurn('hongguo', 'QQ · 刷红果', `【刷红果短剧，不是聊天，这一轮不会发到聊天里】\n${prompt}`, { timeoutMs: 180000 })
    return typeof out === 'string' ? out : String(out?.text ?? out ?? '')
  }

  /** 配置里指定的"看画面用的模型"（形如 xdpool/glm-5.3）。没配返回 null，就用默认模型。 */
  function visionTarget () {
    const custom = String(cfg().visionModel || '').trim()
    const m = custom.match(/^([\w.-]+)\s*[/:]\s*([\w.\-:]+)$/)
    return m ? { provider: m[1], model: m[2] } : null
  }

  /** 自检：随便挑一部剧，真播十几秒抓一帧，问她"画面里有什么"。
   *  用来确认当前模型到底能不能看懂图 —— 不能就别装作看过。 */
  async function visionTest () {
    if (!askModel || !dsh) return { ok: false, message: `没有看图通道（askModel=${!!askModel} dsh=${!!dsh}）` }
    const ready = await site.ensure().catch((error) => ({ ok: false, message: error.message }))
    if (!ready.ok) return { ok: false, message: ready.message || '浏览器打不开' }
    const feed = await site.feed().catch(() => [])
    const t = feed[0]
    if (!t) return { ok: false, message: '推荐里没找到剧' }

    const w = await site.play(t.href, 15000, { frames: 1 })
    if (!w?.frames?.length) return { ok: false, message: '没抓到画面帧' }

    const target = visionTarget()
    try {
      const out = await askModel(dsh, {
        system: '只输出 JSON，不要解释。',
        text: `这是红果短剧《${t.title}》的一帧画面。用一句话如实说出画面里有什么（人物/物体/字幕/场景），再给个类型判断。只输出 JSON：{"saw":"画面里有什么","genre":"什么类型的故事"}`,
        images: [{ data: w.frames[0], mediaType: 'image/jpeg' }],
        maxTokens: 300,
        temperature: 0.3,
        ...(target ? { model: target } : {})
      })
      const m = String(out || '').match(/\{[\s\S]*\}/)
      const got = m ? JSON.parse(m[0]) : null
      return {
        ok: true,
        title: t.title,
        model: target ? `${target.provider}/${target.model}` : '默认模型',
        saw: got?.saw || String(out || '').slice(0, 200),
        genre: got?.genre || '',
        seconds: w.seconds,
        info: '她能看懂画面 —— 感想和"要不要推给你"都是看着画面判断的'
      }
    } catch (error) {
      return { ok: false, message: `模型看不懂画面：${error.message}` }
    }
  }

  /** 让她"真的看一遍"：把播放时抓的画面帧 + 真实热评喂进去，自己判断好不好看、值不值得推。
   *  带图失败（模型不支持视觉 / 附件服务不认）自动退回"简介 + 热评"，结果里用 sawFrames 标出来，
   *  免得以后又变成"假装看过"。 */
  async function analyze (v, shareLeft = 0) {
    const imgs = (v.frames || []).map((b64) => ({ data: b64, mediaType: 'image/jpeg' }))
    const hot = (v.comments || []).slice(0, 6)
    const text = [
      `剧名：《${v.title}》`,
      v.intro ? `平台简介：${v.intro}` : '',
      `我刚刚真播了 ${v.sec} 秒${imgs.length ? `，附上这一集的 ${imgs.length} 张画面截图` : '（这一集没截到画面）'}。`,
      hot.length ? `真实观众热评（按点赞排序）：\n${hot.map((x, i) => `${i + 1}. ${x.text}（${x.likes} 赞）`).join('\n')}` : '',
      '',
      `看完自己判断：这剧画面里到底在发生什么、好不好看、${owner()}会不会喜欢。`,
      shareLeft > 0
        ? `觉得好看、而且${owner()}会喜欢，就写一句想私聊发给${owner()}的话（口语一点，带自己的感觉，别写成推荐语）。觉得一般或不好看就把 share 留空 —— 别为了发而发。`
        : '这次没有分享额度了，share 留空。',
      '只输出 JSON：{"plot":"画面里实际在发生什么（人物、场景、动作、氛围），不要复述简介","score":1到10的整数,"good":true或false,"why":"好看/不好看的理由，要结合画面和热评","feeling":"你自己看的时候的感受，一句话","share":"要发给他的话，否则空字符串","remember":"值得记住的一件事，没有就空字符串"}'
    ].filter(Boolean).join('\n')

    const system = '你正在红果短剧上自己挑剧看，不是给别人写评测。说话就像自己看完随手记一句。只输出 JSON。'
    let out = ''
    let sawFrames = false

    if (imgs.length && askModel && dsh) {
      // 看懂画面优先用配置里指定的视觉模型；没配或它也失败，再退回默认模型
      const target = visionTarget()
      const tries = target ? [target, null] : [null]
      for (const t of tries) {
        try {
          out = await askModel(dsh, { system, text, images: imgs, maxTokens: 700, temperature: 0.7, ...(t ? { model: t } : {}) })
          if (out && out.trim()) { sawFrames = true; break }
        } catch (error) {
          log.debug(`带画面分析失败（${t ? `${t.provider}/${t.model}` : '默认模型'}）：`, error.message)
          out = ''
        }
      }
    }
    if (!out || !out.trim()) {
      // 没图通道：退回纯文字（简介 + 热评）。sawFrames 保持 false，别让人以为"看过画面了"
      out = await (askModel && dsh
        ? askModel(dsh, { system, text, maxTokens: 600, temperature: 0.7 })
        : think(`【刷红果短剧】\n${text}`))
    }

    let got = null
    try {
      const m = String(out || '').match(/\{[\s\S]*\}/)
      got = m ? JSON.parse(m[0]) : null
    } catch (error) { log.debug('红果分析 JSON 解析失败：', error.message) }

    return {
      plot: String(got?.plot || '').slice(0, 200),
      score: Math.min(10, Math.max(1, Number(got?.score) || 0)),
      good: got?.good === true,
      why: String(got?.why || '').slice(0, 160),
      feeling: String(got?.feeling || '').slice(0, 120),
      share: String(got?.share || '').trim().slice(0, 200),
      remember: String(got?.remember || '').slice(0, 100),
      sawFrames
    }
  }

  /** 真正跑一轮：拿推荐 → 逐个真播一集 → 让模型写感受 → QQ 私聊分享。 */
  async function run ({ force = false, ownerAsked = false } = {}) {
    const c = cfg()
    if (busy) return { ok: false, message: '正在刷' }
    if (!c.enabled && !force) return { ok: false, message: '红果没打开' }
    busy = true
    const s = load()
    try {
      if (paused(s)) return { ok: false, message: `今天先停着：${s.pauseReason || '有验证没处理'}` }
      const leftToday = Math.max(0, c.maxWatchPerDay - s.watched)
      if (leftToday <= 0) return { ok: false, message: `今天已经看了 ${s.watched} 部（上限 ${c.maxWatchPerDay}）` }

      // 先把浏览器接上（没开就拉起来）。不先 ensure 的话，浏览器关着时下面读到
      // 的全是"没连上"，会被误判成"没登录"，主人点「刷一轮」永远刷不动。
      const ready = await site.ensure().catch((error) => ({ ok: false, message: error.message }))
      if (!ready.ok) return { ok: false, message: ready.message || '浏览器打不开' }

      // 没登录就停（分享的前提是有号在刷）
      const st = await site.verify()
      if (st) { pauseAll(s, st); return { ok: false, message: st } }
      const me = await site.self()
      if (!me) return { ok: false, message: '红果还没登录，先在面板里扫码' }

      const feed = await site.feed().catch((error) => { log.debug('红果推荐流失败：', error.message); return [] })
      const seen = new Set(s.seen)
      const list = feed.filter((x) => x.href && !seen.has(x.href)).slice(0, Math.min(c.perRun, leftToday))
      if (!list.length) { s.lastSkipReason = '推荐里没有新剧'; return { ok: false, message: s.lastSkipReason } }

      // 逐个点开：详情页拿剧名/简介/封面 → 播放页真播一集（顺手抓画面帧）→ 读真实热评
      const looked = []
      for (const it of list) {
        try {
          const d = await site.detail(it.href)
          const want = between(c.dwellMin, c.dwellMax) * 1000
          // 真播：/player/<sid> 里静音播 want 毫秒，途中抓 3 帧。播不起来就抛错 —— 不能把"没看成"记成看过
          const w = await site.play(it.href, want, { frames: 3 })
          if (!w.ok) throw new Error(`只播了 ${w.seconds} 秒（目标 ${w.wanted} 秒），没看成`)
          // 热评：网页版只能看不能发，但正好当"真实观众反馈"喂给模型
          const cmts = await site.comments(6).catch(() => [])
          looked.push({
            href: it.href, title: d.title || it.title, intro: d.intro || '', cover: d.cover || it.cover || '',
            sec: w.seconds, frames: w.frames || [], comments: cmts
          })
          s.watched++
          s.seen = [...s.seen.filter((x) => x !== it.href), it.href].slice(-500)
          log.info(`红果看了《${d.title || it.title}》${w.seconds} 秒，抓 ${w.frames?.length || 0} 帧，热评 ${cmts.length} 条`)
        } catch (error) {
          log.debug(`看 ${it.href} 失败：`, error.message)
          const why = await site.verify().catch(() => '')
          if (why) { pauseAll(s, why); break }
        }
        save(s)
      }
      if (!looked.length) { s.lastSkipReason = '一部都没播起来'; return { ok: false, message: s.lastSkipReason } }

      // 逐部"真的看一遍"：画面帧 + 真实热评 → 她自己判断剧情好不好看、值不值得推
      const g = getConfig()
      const canShare = permOf(g, 'hongguoShareOwner') !== 'off' && !!g.ownerQQ
      let shared = 0
      let sawFrames = 0
      for (const v of looked) {
        let verdict = null
        try {
          verdict = await analyze(v, Math.max(0, c.maxSharesPerDay - s.shares))
        } catch (error) {
          log.warn(`红果《${v.title}》没分析出来：`, error.message)
        }
        if (verdict?.sawFrames) sawFrames++
        if (verdict?.remember) memory?.addEvent?.({ text: `看红果短剧《${v.title}》：${verdict.remember}`, tags: ['红果'], importance: 0.35 })

        // 只有"看过 + 觉得好看"才推。不好看就不推 —— 别为了分享而分享
        const share = verdict?.share && verdict.good ? verdict.share : ''
        if (share && !isSilence(share) && canShare && s.shares < c.maxSharesPerDay) {
          try {
            // 推的时候带一句她自己看到的画面/评价，让分享有信息量
            const why = verdict.why ? `（${verdict.why}）` : ''
            await hub.sendText(`private:${g.ownerQQ}`, `${share}${why}\n${v.href}`)
            shared++
            s.shares++
            record(s, { kind: 'share', title: v.title, href: v.href, cover: v.cover, sec: v.sec, score: verdict.score, text: share.slice(0, 80), via: 'qq' })
            log.info(`红果分享了《${v.title}》（${verdict.score} 分）`)
          } catch (error) { log.warn('红果分享没发出去：', error.message) }
        } else if (verdict && !verdict.good && verdict.share) {
          log.info(`《${v.title}》${verdict.score} 分，她觉得一般，不推`)
        }
        record(s, {
          kind: 'watch', title: v.title, href: v.href, cover: v.cover, sec: v.sec,
          score: verdict?.score || 0, plot: verdict?.plot || '', good: !!verdict?.good, saw: !!verdict?.sawFrames
        })
      }
      s.lastRun = now()
      save(s)
      const totalSec = looked.reduce((n, x) => n + (x.sec || 0), 0)
      const eye = sawFrames ? `，其中 ${sawFrames} 部是看着画面分析的` : '（这一轮没看成画面，只读了简介和热评）'
      return {
        ok: true, watched: looked.length, shared, seconds: totalSec, sawFrames,
        message: `看了 ${looked.length} 部（实际播放 ${totalSec} 秒）${eye}${shared ? `，推给你 ${shared} 部` : '，没有值得推的'}`
      }
    } finally {
      busy = false
    }
  }

  let busy = false
  let tickBusy = false

  /** 每分钟一跳：醒着时间 + 到间隔 + 没超上限才跑。 */
  async function tick () {
    const g = getConfig()
    const c = g.hongguo
    if (!c?.enabled || !g.enabled) return
    const h = new Date().getHours()
    if (h < g.speakUp.awakeFrom || h >= g.speakUp.awakeTo) return
    if (tickBusy || busy) return
    const s = load()
    if (paused(s)) return
    if (s.watched >= c.maxWatchPerDay) return
    if (now() - (s.lastRun || 0) < c.intervalHours * 3600_000) return
    tickBusy = true
    try { await run({}).catch((error) => log.warn('红果刷一轮出错：', error.message)) } finally { tickBusy = false }
  }

  /** 面板：开始登录（截二维码）。 */
  async function loginStart () {
    return site.loginStart().catch((error) => ({ ok: false, message: error.message }))
  }
  /** 面板：登录轮询。 */
  async function loginPoll () {
    const r = await site.loginPoll().catch((error) => ({ ok: false, message: error.message }))
    if (r.loggedIn) { const s = load(); s.pauseDay = ''; s.pauseReason = ''; save(s) }
    return r
  }
  /** 面板：显示 / 收起浏览器窗口（处理验证、扫码时挪出来，处理完收回去）。
   *  出错要把原因带回去 —— 之前这里吞掉返回值，面板一律提示成功，看着就是"点了没反应"。 */
  async function show (visible = true) {
    try {
      const moved = await site.show(Boolean(visible))
      if (visible) return { ok: true, message: '窗口挪到屏幕上了，处理完点「收起窗口」' }
      return { ok: true, message: moved === false ? '浏览器本来就没开，不用收' : '窗口收起来了' }
    } catch (error) {
      return { ok: false, message: error.message || (visible ? '浏览器调不出来' : '窗口收不起来') }
    }
  }
  /** 面板：现在手动刷一轮。 */
  async function runOnce () { return run({ force: true, ownerAsked: true }) }
  /** 面板：看过什么。 */
  function recent (limit = 10) {
    const s = load()
    return (s.history || []).slice(-limit).reverse()
  }

  /** 补封面：展示墙之前刷的老记录没有 cover，按 href 去详情页取一次（只补封面，不动别的）。
   *  一次最多 12 部（每部要跳一次页面，太多会等到怀疑人生）；再点一次接着补。 */
  async function backfillCovers () {
    const s = load()
    const need = [...new Set((s.history || []).filter((x) => x.href && !x.cover).map((x) => x.href))]
    if (!need.length) return { ok: true, done: 0, total: 0, message: '封面都齐了' }
    const ready = await site.ensure().catch((error) => ({ ok: false, message: error.message }))
    if (!ready.ok) return { ok: false, done: 0, left: need.length, message: ready.message || '浏览器打不开' }
    const todo = need.slice(0, 12)
    let done = 0
    for (const href of todo) {
      try {
        const d = await site.detail(href)
        if (!d?.cover) continue
        // 同一部剧在记录里可能有多条（看过 + 分享过），一起补
        s.history = (s.history || []).map((x) => (x.href === href ? { ...x, cover: d.cover } : x))
        done++
        save(s)
      } catch (error) { log.debug(`补封面失败 ${href}：`, error.message) }
    }
    const left = Math.max(0, need.length - done)
    if (!done) return { ok: false, done, left, message: '一部都没补上（可能剧下架了）' }
    return { ok: true, done, left, message: `补了 ${done} 部封面${left ? `，还有 ${left} 部，再点一次` : ''}` }
  }

  async function dispose () { await browser.close().catch(() => {}) }

  return { run, runOnce, tick, loginStart, loginPoll, show, recent, backfillCovers, visionTest, dispose, site: () => site }
}
