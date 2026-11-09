// 小黑盒业务层：信息流 / 帖子详情 / 热榜 / 搜索 / 点赞 / 评论 / 发帖（带图）/ 删帖 / 配额。
//
// 几条硬经验（实测踩出来的，别改）：
//   · 发帖 link_tag：11=文章（富文本、行内插图真正夹在文字中间）、27=图文（图片被挤到文末）、28=动态（只能纯文本）
//   · topic_ids 必须是真的分区 id（7214 / 18745 / 806933），乱填一直报「错误的帖子类型」
//   · 帖详情和搜索频繁访问会触发验证码 → 分档限速，遇到风控停止所有普通请求
//   · 图片走腾讯云 COS 四步直传，任何一步失败都只是少一张图，不打断发帖

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HeyboxClient, HeyboxError, cosSign, newDeviceId, WEB_BASE, TOPICS } from './api.mjs'
import { POST_STYLES, DEFAULT_POST_STYLE, styleOf, stylePrompt } from './styles.mjs'
import { startQrLogin, pollQrLogin, verifyCookie } from './qr.mjs'
import { createVerifier } from './verify.mjs'

const { dataDir } = globalThis.aurabot.lib('core/store.js')

const HOME = process.env.USERPROFILE || os.homedir()
const CRED_DIR = path.join(HOME, '.heybox-ai')
const CRED_FILE = path.join(CRED_DIR, 'credentials.json')

const DEFAULT_STATE = {
  // 本机固定的设备指纹：首次运行时随机生成并落盘，不跟别人共用
  deviceId: '',
  account: { checkedAt: 0, nickname: '', heyboxId: '', loggedIn: false, message: '' },
  quota: { date: '', like: 0, comment: 0, post: 0, browse: 0, share: 0 },
  history: [],
  lastRun: 0,
  browseAt: 0,
  lastSkipReason: '',
  risk: { level: 0, until: 0, reason: '', at: 0 },
  failures: 0,
  retryAt: 0,
  // 分区缓存：每天拉一次真实分区表（含热门游戏分区）
  topics: { fetchedAt: 0, date: '', list: [] },
  // 话题缓存：每天扫一次信息流，收集创作活动 + 普通话题（都带热度）
  acts: { fetchedAt: 0, date: '', list: [], plain: [] },
}
const RETRY_BACKOFF_MS = [2, 5, 15, 30, 60, 120].map((n) => n * 60_000)

export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function inHours(hour, start, end) {
  if (start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/** 唤醒时段（聊天活跃时间）：跑后台会话 + 到点自动发帖都只看这个窗口。 */
function speakUpWindow(cfg = {}) {
  const awake = cfg.speakUp || {}
  const from = Number(awake.awakeFrom ?? 8)
  const to = Number(awake.awakeTo ?? 23)
  return {
    from: Number.isFinite(from) ? from : 8,
    to: Number.isFinite(to) ? to : 23,
  }
}

function awakeNow(cfg = {}, at = new Date()) {
  const w = speakUpWindow(cfg)
  return inHours(at.getHours() + at.getMinutes() / 60, w.from, w.to)
}

/**
 * 「今天排期里该发的那几篇」各自该在几点发。
 *
 * 把唤醒窗口均分成 N 份，第 i 篇落在第 i 份的起点：
 * 不再「隔 intervalHours 逛一圈才顺带发一篇」——中午前逛满冷却也照样在
 * 自己的时刻点上把当天排期补发掉；到点那一刻如果忙/冷冻/额度没了，
 * 下一分钟 tick 还会看到「该发」，不会漏掉。
 * N 与 pendingPosts 的 owe 口径一致：min(dailyPosts.length, maxPostsPerDay)。
 * @returns {number[]} 升序的「相对唤醒起点的偏移」小时数
 */
function postSlots(cfg = {}) {
  const c = cfg.heybox || {}
  const plan = Array.isArray(c.dailyPosts) ? c.dailyPosts : []
  const cap = Math.max(0, Math.floor(Number(c.maxPostsPerDay) || 0))
  const n = Math.min(plan.length, cap)
  if (n <= 0) return []
  const { from, to } = speakUpWindow(cfg)
  const span = (to - from + 24) % 24 || 24
  const out = []
  // 返回的是**相对唤醒起点**的偏移小时（不是钟点）：第 0 篇 = 一醒来就该发
  for (let i = 0; i < n; i++) out.push(Number(((i * span) / n).toFixed(2)))
  return out
}

// 跨午夜时，凌晨归属于前一天开始的峰时段。
/** 服务端只认 user_pkey，浏览器里复制到的常常只有 pkey：补一条同值的。 */
export function normalizeCookie(raw) {
  const s = String(raw || '').trim()
  if (!s || /(?:^|;\s*)user_pkey=/i.test(s)) return s
  const key = s.match(/(?:^|;\s*)pkey=([^;\s]+)/i)?.[1]
  return key ? `${s.replace(/;\s*$/, '')}; user_pkey=${key}` : s
}

export function isPeakTime(c = {}, at = new Date()) {
  const h = at.getHours() + at.getMinutes() / 60
  const ranges = [[c.peakStartAM ?? 9, c.peakEndAM ?? 12], [c.peakStartPM ?? 14, c.peakEndPM ?? 18]]
  return ranges.some(([a, b]) => {
    const start = Number(a), end = Number(b)
    if (!Number.isFinite(start) || !Number.isFinite(end) || !inHours(h, start, end)) return false
    const day = start > end && h < end ? (at.getDay() + 6) % 7 : at.getDay()
    return Boolean(c.peakWeekend) || (day !== 0 && day !== 6)
  })
}

function pickJson(out) {
  const text = String(out || '')
  const a = text.indexOf('{'), b = text.lastIndexOf('}')
  try { return a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null } catch { return null }
}

/** 把 blocks 里的正文抽成纯文本（正文是 JSON 块数组，可能是 text / html / img） */
function textOf(value) {
  if (typeof value !== 'string') return ''
  try {
    const blocks = JSON.parse(value)
    if (Array.isArray(blocks)) {
      return blocks.map((b) => {
        if (!b) return ''
        if (b.type === 'text') return b.text || ''
        if (b.type === 'html') return String(b.text || '').replace(/<[^>]+>/g, '')
        return ''
      }).filter(Boolean).join('\n')
    }
  } catch { /* 不是 JSON，原样返回 */ }
  return value
}

const htmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const countWords = (s) => String(s || '').replace(/\s/g, '').length

/** 从各种写法的链接里挖出 link_id（app 端分享的链接里，link_id 可能是 16 进制，如 855a72949646） */
export function linkIdOf(input) {
  const s = String(input || '').trim()
  if (!s) return ''
  // 1) app 端分享链接的 ?link_id=xxx（可能是 16 进制，接口原样接受，不用转十进制）
  let m = s.match(/[?&]link_id=([0-9a-zA-Z]+)/)
  if (m) return m[1]
  // 2) 网页路径 /app/bbs/link/xxx
  m = s.match(/link\/([0-9a-zA-Z]+)/)
  if (m) return m[1]
  // 3) 直接给的 id（数字或 16 进制）
  if (/^[0-9a-zA-Z]{6,}$/.test(s)) return s
  // 4) 兜底：老写法，抠出整串数字
  const digits = s.replace(/\D/g, '')
  return digits.length >= 6 ? digits : ''
}

export function createHeybox({ getConfig, setCookie, hub, memory, log, proactive, stateFile = path.join(HOME, '.dsh', 'heybox-state.json'), credFile = CRED_FILE, now = () => Date.now(), clientFactory = (options) => new HeyboxClient(options), verifier: injectedVerifier, imagegen = null, memeRoot = null, imageDir = null } = {}) {
  let client = null
  let verifier = injectedVerifier || null
  let verifySession = null
  let verifyBusy = false
  let qrSession = null
  let running = false
  let qrStarting = false
  let disposed = false
  const getVerifier = () => verifier ||= createVerifier({ profileDir: dataDir('heybox', 'edge-profile'), browserPath: () => getConfig().heybox?.browserPath || '', log, useEgo: () => getConfig().browser?.useDshSidebar === true })
  const nowMs = () => now()
  const localToday = () => today(new Date(nowMs()))

  /** Cookie 从配置或凭据文件读；配置优先（面板里填的） */
  function cookie() {
    const c = (getConfig().heybox || {}).cookie || ''
    if (c) return normalizeCookie(c)
    try {
      const j = JSON.parse(fs.readFileSync(credFile, 'utf8'))
      return normalizeCookie(Object.entries(j.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; '))
    } catch { return '' }
  }

  function hasLogin() { return /(?:^|;\s*)(?:user_)?pkey=[^;\s]+/.test(cookie()) }

  function saveRisk(info) {
    const st = readState()
    st.risk = { level: info.level, until: info.until, reason: info.reason, at: info.at }
    writeState(st)
  }

  function getClient() {
    if (!client) {
      client = clientFactory({ cookie: cookie(), deviceId: ensureDeviceId(), risk: readState().risk, onRisk: saveRisk, now })
      if (disposed) client.dispose()
    } else client.cookie = cookie()
    return client
  }
  function risk() { return getClient().riskInfo() }

  /** 状态文件：主板数据，掉线也不丢 */
  function readState() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      return { ...DEFAULT_STATE, ...raw, account: { ...DEFAULT_STATE.account, ...raw.account }, quota: { ...DEFAULT_STATE.quota, ...raw.quota } }
    } catch { return { ...DEFAULT_STATE } }
  }

  function writeState(next) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify(next, null, 2))
      return true
    } catch (e) { log?.warn?.('写小黑盒状态失败：' + e.message); return false }
  }

  /** 设备指纹：每台机器随机生成一次并存进状态文件，重启后保持不变 */
  function ensureDeviceId() {
    const st = readState()
    if (/^[0-9a-f]{32}$/.test(String(st.deviceId || ''))) return st.deviceId
    const id = newDeviceId()
    st.deviceId = id
    writeState(st)
    return id
  }

  function quota() {
    const st = readState()
    if (st.quota.date !== localToday()) return { date: localToday(), like: 0, comment: 0, post: 0, browse: 0, share: 0 }
    return { ...DEFAULT_STATE.quota, ...st.quota }
  }

  function bump(kind) {
    const st = readState()
    const q = quota()
    q[kind] = (q[kind] || 0) + 1
    st.quota = q
    writeState(st)
    return q[kind]
  }

  /**
   * 占一个额度：检查 + 计数在**同一次**读改写里完成。
   *
   * ⚠ 以前是「先 left('post') 判断够不够，发完再 bump」。中间要等分区、话题、
   *   上传图片（几十秒），两个人同时叫发帖时两次都能通过检查，于是一天能发超。
   *   现在改成发帖前先占位，失败再退回去（见 post 的 finally）。
   * @returns {{ok: boolean, left: number, cap: number}}
   */
  function reserveQuota(kind) {
    const st = readState()
    const q = quota()
    const c = getConfig().heybox || {}
    const cap = { like: c.likeDaily, comment: c.commentDaily, post: c.maxPostsPerDay, browse: c.maxRunsPerDay, share: c.shareDaily ?? 3 }[kind] ?? 0
    const used = Number(q[kind]) || 0
    const max = Number(cap) || 0
    if (used >= max) return { ok: false, left: 0, cap: max }
    q[kind] = used + 1
    st.quota = q
    writeState(st)
    return { ok: true, left: Math.max(0, max - q[kind]), cap: max }
  }

  /** 退回一个额度（发帖失败时用）。 */
  function releaseQuota(kind) {
    const st = readState()
    const q = quota()
    q[kind] = Math.max(0, (Number(q[kind]) || 0) - 1)
    st.quota = q
    writeState(st)
    return q[kind]
  }

  function left(kind) {
    const c = getConfig().heybox || {}
    const cap = { like: c.likeDaily, comment: c.commentDaily, post: c.maxPostsPerDay, browse: c.maxRunsPerDay, share: c.shareDaily ?? 3 }[kind] ?? 0
    return Math.max(0, (Number(cap) || 0) - (quota()[kind] || 0))
  }

  function pushHistory(item) {
    const st = readState()
    st.history = [{ at: nowMs(), ...item }, ...(st.history || [])].slice(0, 60)
    writeState(st)
  }

  // ── 只读：信息流 / 帖子 / 热榜 / 搜索 / 分区 ─────────────────────────

  async function feed(offset = 0) {
    const d = await getClient().get('/bbs/app/feeds', { pull: 0, offset, dw: 604 })
    const r = d.result || {}
    const list = r.links || r.list || []
    return list.map((x) => ({
      linkId: String(x.linkid ?? x.link_id ?? ''),
      title: String(x.title || ''),
      author: String((x.user && (x.user.username || x.user.nickname)) || ''),
      likes: Number(x.link_like_count ?? x.like_num ?? 0),
      comments: Number(x.comment_num ?? x.comment_count ?? 0),
      topics: (Array.isArray(x.topics) ? x.topics : []).map((t) => String(t.name || '')).filter(Boolean),
    })).filter((x) => x.linkId)
  }

  async function feedReport() {
    const list = await feed(0)
    return {
      ok: true,
      message: list.length
        ? list.map((x) => `[${x.linkId}] ${x.title || '（无标题）'}　by ${x.author}　赞${x.likes} 评${x.comments}`).join('\n')
        : '信息流是空的',
      links: list,
    }
  }

  function findComments(value, depth = 0) {
    if (!value || depth > 4) return null
    if (Array.isArray(value)) {
      if (value.length && value.every((v) => v && typeof v === 'object' && ('commentid' in v || 'comment_id' in v))) return value
      for (const v of value) { const r = findComments(v, depth + 1); if (r) return r }
      return null
    }
    if (typeof value === 'object') {
      for (const k of ['comments', 'comment_list', 'list', 'data']) {
        if (value[k]) { const r = findComments(value[k], depth + 1); if (r) return r }
      }
      for (const v of Object.values(value)) { const r = findComments(v, depth + 1); if (r) return r }
    }
    return null
  }

  async function detail(linkId) {
    const d = await getClient().get('/bbs/app/link/tree', {
      link_id: linkId, page: 1, is_first: 1, index: 1, owner_only: 0, offset: 0, limit: 20, sort_filter: 'hot',
    })
    const r = d.result || {}
    const link = r.link || r
    const user = link.user || {}
    const comments = findComments(r) || []
    return {
      linkId,
      url: `${WEB_BASE}/app/bbs/link/${linkId}`,
      title: String(link.title || ''),
      author: String(user.username ?? user.nickname ?? ''),
      likes: Number(link.link_like_count ?? link.like_num ?? 0),
      body: textOf(link.text) || String(link.description || ''),
      topics: (Array.isArray(link.topics) ? link.topics : []).map((t) => '#' + String(t.name || '') + '#').filter((t) => t.length > 2),
      comments: comments.slice(0, 12).map((c) => ({
        id: String(c.commentid ?? c.comment_id ?? ''),
        user: String((c.user && (c.user.username || c.user.nickname)) || '匿名'),
        likes: Number(c.up ?? c.like_num ?? 0),
        text: String(c.text ?? c.content ?? ''),
        replyId: String(c.replyid ?? c.reply_id ?? '-1'),
      })),
    }
  }

  async function watch(link) {
    const id = linkIdOf(link)
    if (!id) return { ok: false, message: '没看出帖子编号（给帖子链接，或者 /link/ 后面的 id）' }
    const d = await detail(id)
    return {
      ok: true,
      message: [
        `《${d.title || '（无标题）'}》by ${d.author || '未知'}　赞${d.likes}`,
        d.topics.join(' '),
        '',
        d.body.slice(0, 800) || '（无正文）',
        '',
        d.comments.length ? '热评：' : '（还没有评论）',
        ...d.comments.slice(0, 6).map((c) => `· ${c.user}：${c.text.slice(0, 80)}`),
      ].join('\n'),
      url: d.url,
    }
  }

  /** 热榜：接口 result.Lists 是几组，只取「黑盒热议」那组 */
  async function hot(limit = 8) {
    const d = await getClient().get('/bbs/app/api/search/welcome_page/v2', { force_refresh: 'false' })
    const r = d.result || {}
    const groups = r.Lists
    if (!Array.isArray(groups)) throw new HeyboxError('热榜接口结构变了，找不到 Lists', 'schema')
    const target = groups.find((g) => String(g?.head_text || '').includes('热议'))
      || groups.find((g) => Array.isArray(g?.items) && g.items.length)
      || groups[0]
    const items = Array.isArray(target?.items) ? target.items : []
    const list = []
    for (const it of items.slice(0, Math.max(1, Number(limit) || 8))) {
      const text = String(it?.text || '').trim()
      if (text) list.push({ text, tag: String((it?.right_tag && (it.right_tag.text || it.right_tag)) || '').slice(0, 20) })
    }
    return {
      ok: true,
      group: String(target?.head_text || ''),
      list,
      message: [`【${target?.head_text || '热榜'}】`].concat(list.map((x, i) => `${i + 1}. ${x.text}${x.tag ? ' [' + x.tag + ']' : ''}`)).join('\n'),
    }
  }

  /** 搜索按接口分档限速；遇到风控时提示上层停止所有请求。 */
  async function search(query, limit = 8, { sort = 'award_num', timeRange = '7d' } = {}) {
    const q = String(query || '').trim()
    if (!q) return { ok: false, message: '要给个关键词' }
    let d
    try {
      d = await getClient().get('/bbs/app/api/general/search/v1', {
        q, search_type: 'general', is_pull_down: '0', offset: 0,
        limit: Math.max(1, Math.min(Number(limit) || 8, 30)), dw: 744,
        sort_filter: sort, time_range: timeRange,
      })
    } catch (err) {
      if (['captcha', 'cooldown', 'rate_limit'].includes(err.code)) return { ok: false, blocked: true, cooldown: true, message: '小黑盒在冷却中，请先停止请求：' + err.message }
      return { ok: false, blocked: true, message: '搜索失败：' + err.message }
    }
    const r = d.result || {}
    const items = Array.isArray(r.items) ? r.items : []
    const list = items.map((it) => {
      const x = it.link || it.info || it
      return {
        linkId: String(x.linkid ?? x.link_id ?? ''),
        title: String(x.title ?? x.link_title ?? x.text ?? ''),
        likes: Number(x.link_like_count ?? x.like_num ?? x.award_num ?? 0),
        comments: Number(x.comment_num ?? x.comment_count ?? 0),
      }
    }).filter((x) => x.linkId || x.title).slice(0, Number(limit) || 8)
    return {
      ok: true,
      list,
      message: list.length
        ? list.map((x) => `[${x.linkId || '—'}] ${x.title}　赞${x.likes} 评${x.comments}`).join('\n')
        : '没搜到',
    }
  }

  /**
   * 从接口返回里把分区抽成 { id, name, hot, game } 列表。
   * /bbs/app/topic/categories 给三组：为你推荐 / 近期热门 / 我的偏好，都有 children。
   * 近期热门那组最全（几十个，含游戏分区）。
   */
  function extractTopics(result) {
    const r = result || {}
    const groups = ['recommend_for_user_topics', 'latest_hot_topics', 'subscribed_topics']
    const seen = new Map()
    for (const key of groups) {
      const g = r[key]
      const kids = Array.isArray(g?.children) ? g.children : []
      for (const t of kids) {
        const id = String(t?.topic_id ?? t?.id ?? '')
        const name = String(t?.name ?? '').trim()
        if (!id || !name) continue
        const hot = Number(t?.hot?.raw_hot_value ?? 0) || 0
        const game = Boolean(t?.game?.app_id)
        const prev = seen.get(id)
        if (prev) { prev.hot = Math.max(prev.hot, hot); prev.game = prev.game || game; continue }
        seen.set(id, { id, name, hot, game })
      }
    }
    return [...seen.values()]
  }

  /**
   * 分区列表：每天自动刷新一次，缓存在状态文件里。
   * 旧的 /bbs/app/api/topic/index 已废弃（返回 expired），改用 /bbs/app/topic/categories。
   * @param {boolean} force 强制刷新
   */
  async function refreshTopics(force = false) {
    const st = readState()
    const cache = st.topics || {}
    if (!force && cache.date && cache.date === localToday() && Array.isArray(cache.list) && cache.list.length) {
      return { ok: true, cached: true, list: cache.list }
    }
    try {
      const d = await getClient().get('/bbs/app/topic/categories', {})
      const list = extractTopics(d.result)
      if (list.length) {
        const next = readState()
        next.topics = { fetchedAt: nowMs(), date: localToday(), list }
        writeState(next)
        log?.info?.(`小黑盒分区表已更新：${list.length} 个`)
        return { ok: true, cached: false, list }
      }
    } catch (e) {
      log?.warn?.('拉小黑盒分区表失败：' + e.message)
    }
    if (Array.isArray(cache.list) && cache.list.length) return { ok: true, cached: true, stale: true, list: cache.list }
    const fallback = Object.entries(TOPICS).map(([id, name]) => ({ id, name, hot: 0, game: false }))
    return { ok: true, cached: false, fallback: true, list: fallback }
  }

  // ── 话题（创作活动 + 普通话题）：每天扫一次信息流收集 ────────
  //
  // 小黑盒没有公开的「活动/话题列表」接口（试了二十多个路径都是 404）。
  // 但信息流里挂了话题的帖子会带 hashtags，其中 sub_title === '活动' 的是创作活动。
  // 所以扫十几页信息流收集话题，活动再逐个查 /bbs/app/hashtag/feeds 拿 end_ts 判断是否过期。

  /**
   * 刷新话题表（活动 + 普通）。
   * @param {boolean} force 强制刷新
   */
  async function refreshActs(force = false) {
    const st = readState()
    const cache = st.acts || {}
    if (!force && cache.date && cache.date === localToday() && ((cache.list || []).length || (cache.plain || []).length)) {
      return { ok: true, cached: true, list: cache.list || [], plain: cache.plain || [] }
    }
    const found = new Map()
    const plainFound = new Map()
    // 扫 12 页（约 120 条）。实测只扫 4 页只能捡 4 个活动，扫到 120 条能拿 9 个活动 + 近百个普通话题。
    const offsets = []
    for (let o = 0; o <= 110; o += 10) offsets.push(o)
    for (const offset of offsets) {
      try {
        const d = await getClient().get('/bbs/app/feeds', { pull: 0, offset, dw: 604 })
        const list = d.result?.links || d.result?.list || []
        for (const item of list) {
          for (const h of (item.hashtags || [])) {
            const id = String(h.hashtag_id || '')
            const name = String(h.name || '').trim()
            if (!id || !name) continue
            const inAct = h.sub_title === '活动'
              || (item.act_hashtags || []).some((a) => String(a.hashtag_id) === id)
            const bucket = inAct ? found : plainFound
            if (!bucket.has(id)) bucket.set(id, { id, name, seen: 0 })
            bucket.get(id).seen += 1
          }
        }
      } catch (e) {
        log?.warn?.('扫话题失败（offset ' + offset + '）：' + e.message)
        break
      }
    }

    // 活动逐个验证「还在进行」并拿活动名/热度（活动只有十来个，验证得起）
    const nowSec = Math.floor(nowMs() / 1000)
    const actAlive = []
    for (const a of found.values()) {
      if (risk().leftMs > 0) break
      try {
        const d = await getClient().get('/bbs/app/hashtag/feeds', { hashtag_id: a.id, offset: 0, limit: 3 })
        const h = d.result?.hashtag || {}
        const rel = d.result?.related_act_info || {}
        const endTs = Number((h.act_prop || {}).end_ts) || 0
        if (endTs && endTs <= nowSec) continue
        actAlive.push({
          id: a.id, name: a.name,
          actTitle: String(rel.title || ''),
          endTs,
          contentNum: Number((h.num || {}).content_num) || 0,
          seen: a.seen, isAct: true,
        })
      } catch (e) {
        actAlive.push({ id: a.id, name: a.name, actTitle: '', endTs: 0, contentNum: 0, seen: a.seen, isAct: true })
      }
    }

    // 普通话题：只给最常出现的前 20 个补真实热度（100 个逐个查要 80 秒），其余用出现次数当热度
    const plainTop = [...plainFound.values()].sort((x, y) => y.seen - x.seen).slice(0, 20)
    const heatOf = new Map()
    for (const a of plainTop) {
      if (risk().leftMs > 0) break
      try {
        const d = await getClient().get('/bbs/app/hashtag/feeds', { hashtag_id: a.id, offset: 0, limit: 1 })
        const n = Number((d.result?.hashtag?.num || {}).content_num) || 0
        if (n) heatOf.set(a.id, n)
      } catch { /* 拿不到就退回出现次数 */ }
    }
    const plainAlive = [...plainFound.values()].map((a) => ({
      id: a.id, name: a.name, actTitle: '', endTs: 0,
      contentNum: heatOf.get(a.id) || a.seen,
      seen: a.seen, isAct: false,
    }))

    actAlive.sort((x, y) => (y.seen - x.seen) || (y.contentNum - x.contentNum))
    plainAlive.sort((x, y) => (y.contentNum - x.contentNum) || (y.seen - x.seen))
    // 扫到的太少时别把旧缓存冲掉：活动用新的（可能变化），普通话题合并保留
    const prevAct = Array.isArray(cache.list) ? cache.list : []
    const prevPlain = Array.isArray(cache.plain) ? cache.plain : []
    const mergeById = (older, newer) => {
      const m = new Map()
      for (const x of older) m.set(x.id, x)
      for (const x of newer) m.set(x.id, { ...(m.get(x.id) || {}), ...x })
      return [...m.values()]
    }
    // ⚠ 扫不到活动（接口挂了/全过期）时沿用旧列表，但**不能**把 date 写成今天：
    //   那会让面板以为「这份活动表是今天拉到的」，其实里面可能是几天前的过期活动。
    //   沿用旧数据时把 date 留成上次的日期，缓存标记会如实显示为「不是今天」。
    const reusedOld = !actAlive.length && prevAct.length > 0
    const finalAct = actAlive.length ? actAlive : prevAct
    const finalPlain = mergeById(prevPlain, plainAlive)
    const next = readState()
    next.acts = {
      fetchedAt: nowMs(),
      date: reusedOld ? (cache.date || '') : localToday(),
      list: finalAct,
      plain: finalPlain,
      reusedOld,
    }
    writeState(next)
    log?.info?.(`小黑盒话题已更新：活动 ${finalAct.length} 个，普通 ${finalPlain.length} 个`)
    return { ok: true, cached: false, list: finalAct, plain: finalPlain }
  }

  /** 面板/工具用的话题清单：活动在前、普通在后，都带热度 */
  async function actList() {
    const r = await refreshActs(false)
    const act = r.list || []
    const plain = r.plain || []
    const heat = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n))
    const line = (a) => `${a.id} = #${a.name}#${a.actTitle ? '（' + a.actTitle + '）' : ''} · 热度 ${heat(a.contentNum || 0)}`
    const parts = []
    if (act.length) parts.push('【创作活动】', ...act.map(line))
    if (plain.length) parts.push('', '【普通话题】', ...plain.slice(0, 40).map(line))
    return {
      ok: true,
      list: [...act, ...plain], act, plain,
      cached: Boolean(r.cached),
      message: parts.length ? parts.join('\n') : '现在没扫到话题',
    }
  }

  /** 按关键词搜话题（活动优先，其次按热度） */
  async function searchTopics(keyword = '', limit = 20) {
    const kw = String(keyword || '').trim().toLowerCase()
    const r = await refreshActs(false)
    const all = [...(r.list || []), ...(r.plain || [])]
    const hit = kw
      ? all.filter((t) => String(t.name).toLowerCase().includes(kw) || String(t.actTitle || '').toLowerCase().includes(kw))
      : all
    const sorted = hit.sort((x, y) => (y.isAct - x.isAct) || (y.contentNum - x.contentNum))
    return { ok: true, list: sorted.slice(0, Math.max(1, Number(limit) || 20)), total: sorted.length, message: sorted.length ? `匹配到 ${sorted.length} 个话题` : '没匹配到话题' }
  }

  // 规则：活动和普通话题可以一起挂（活动最多 1 个 + 普通最多 3 个，共 4 个）。
  //
  // ⚠ 解析出来的 { id, name } 只是个中间形态。真正发帖时**只发 name 的纯文本数组**
  //   （见 post 里 hashtags 那一行）：服务端拿名字自己匹配成话题，写进帖子的 content_tags。
  //   直接发 { name, hashtag_id } 对象会让 /link/post 回 HTTP 500（这是以前发帖一直失败的真凶）。
  //   实测（2026-11-02）：真实带话题的帖子 hashtags 字段常常是空的，话题在 content_tags 的
  //   style_type=2 项里，protocol 指向 /bbs/hashtag。
  /**
   * 把话题（id 或名字）解析成 { id, name } 列表，供发帖带出去。
   * 规则：活动最多 1 个，普通最多 3 个，可以同时带。
   */
  async function resolveHashtagItems(input) {
    const raw = (Array.isArray(input) ? input : (input ? [input] : []))
      .map((x) => (x && typeof x === 'object' ? (x.id ?? x.hashtag_id ?? x.name) : x))
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
    if (!raw.length) return []
    const r = await refreshActs(false)
    const list = [...(r.list || []), ...(r.plain || [])]
    const acts = []
    const plains = []
    for (const want of raw.slice(0, 6)) {
      // 匹配顺序：id → 完全同名 → 包含关系。
      // ⚠ 包含关系放最后是有原因的：实测「软件推荐」会被模糊匹配成「推荐」，
      //   于是页面上的话题变成「推荐」——名字对不上，等于挂错了。宁可跳过也不要挂错。
      const hit = list.find((a) => a.id === want)
        || list.find((a) => a.name === want)
        || list.find((a) => a.name.includes(want) || want.includes(a.name))
      // ⚠ 整串匹配不上、而它看起来像「名1,名2」那种拼接串时，再按分隔符拆开逐个试。
      //   顺序很关键：先按整串匹配，才不会把合法名字里的空格（如英文话题）拆坏。
      if (!hit && /[,，;；\s]/.test(want)) {
        const parts = want.split(/[,，;；\s]+/).map((x) => x.trim()).filter(Boolean)
        for (const p of parts) {
          const h2 = list.find((a) => a.name === p) || list.find((a) => a.name.includes(p) || p.includes(a.name))
          if (h2 && !plains.some((x) => x.id === String(h2.id)) && plains.length < 3) {
            const nm = String(h2.name || p).trim()
            if (nm && !/^\d+$/.test(nm)) {
              log?.warn?.(`小黑盒：话题「${want}」是按逗号/空格拆开挂的（拆出「${nm}」），检查一下排期里的话题是不是写成了一个串`)
              plains.push({ id: String(h2.id), name: nm })
            }
          }
        }
        continue
      }
      if (!hit) { log?.warn?.(`小黑盒：话题「${want}」不在当前话题表里，跳过`); continue }
      // ⚠ 话题名必须是可读的文字。
      //   几种坏情况：缓存里 name 丢了 / name 其实是 id / name 是纯数字 ——
      //   这些都会让小黑盒页面把话题显示成一串数字。这时回查一次接口拿真名。
      let topicName = String(hit.name || '').trim()
      if (!topicName || /^\d+$/.test(topicName)) {
        try {
          const hd = await getClient().get('/bbs/app/hashtag/feeds', { hashtag_id: String(hit.id), offset: 0, limit: 1 })
          const real = String((hd.result?.hashtag?.name || '').trim())
          if (real && !/^\d+$/.test(real)) topicName = real
        } catch { /* 查不到就保持原样 */ }
      }
      // 还是拿不到真名：宁可跳过也不挂一个数字上去
      if (!topicName || /^\d+$/.test(topicName)) {
        log?.warn?.(`小黑盒：话题「${want}」拿不到可读的名字，跳过（避免页面显示成数字）`)
        continue
      }
      const item = { id: String(hit.id), name: topicName }
      if (hit.isAct) {
        if (acts.length >= 1) { log?.warn?.('小黑盒：创作活动只能挂 1 个，多余的已跳过'); continue }
        acts.push(item)
      } else {
        if (plains.length >= 3) { log?.warn?.('小黑盒：普通话题最多 3 个，多余的已跳过'); continue }
        if (!plains.some((x) => x.id === item.id)) plains.push(item)
      }
    }
    // ⚠ 以前这里有「创作活动和普通话题互斥，只保留活动」的规则。
    //   实测（2026-11-02）名字数组一次可以带多个，服务端会全部写进 content_tags，
    //   真实帖子也常常活动+普通话题同时挂（如「分享我的养鱼日常」+「盒友日常」+「deepseek」）。
    //   所以不再互斥：活动最多 1 个 + 普通最多 3 个，一起带出去，总数不超过 4。
    const out = []
    if (acts.length) out.push(acts[0])
    for (const p of plains.slice(0, 3)) out.push(p)
    return out
  }

  /** 只要 id 的兼容接口（老的调用方用这个） */
  async function resolveHashtags(input) {
    return (await resolveHashtagItems(input)).map((x) => x.id)
  }

  /** 面板/工具用的分区清单 */
  async function topicList() {
    const r = await refreshTopics(false)
    const list = r.list || []
    const msg = list.map((t) => `${t.id} = ${t.name}${t.game ? '（游戏）' : ''}`).join('\n')
    return {
      ok: true, list, cached: Boolean(r.cached), stale: Boolean(r.stale),
      message: msg + (r.fallback ? '（接口没返回，这是内置的三个）' : ''),
    }
  }

  /**
   * 自动挑分区：按正文内容匹配分区名（游戏名优先），挑不到回落默认。
   * 只做名字匹配，宁可回落也不用错分区——挂错分区比不挂更难看。
   */
  async function pickTopicFor(text, fallbackId = '7214') {
    const c = getConfig().heybox || {}
    if (String(c.topicMode || 'manual') !== 'auto') return String(fallbackId)
    const hay = String(text || '')
    if (!hay.trim()) return String(fallbackId)
    const r = await refreshTopics(false)
    const list = Array.isArray(r.list) ? r.list : []
    let best = null
    for (const t of list) {
      const name = String(t.name || '').trim()
      if (!name || name.length < 2) continue
      if (t.id === String(fallbackId)) continue
      if (!hay.includes(name)) continue
      // 命中更长的分区名优先（「影之刃零」比「AI」更有区分度），游戏分区加成
      const score = name.length * 10 + (t.game ? 5 : 0) + Math.min(4, Math.log10((t.hot || 0) + 1))
      if (!best || score > best.score) best = { id: t.id, name, score }
    }
    if (best) {
      log?.info?.(`小黑盒：按内容自动选了分区「${best.name}」(${best.id})`)
      return best.id
    }
    return String(fallbackId)
  }

  // ── 写：点赞 / 评论 / 删帖 ───────────────────────────────────────

  async function like(link) {
    const id = linkIdOf(link)
    if (!id) return { ok: false, message: '没看出帖子编号' }
    if (left('like') <= 0) return { ok: false, message: '今天的点赞额度用完了' }
    await getClient().post('/bbs/app/profile/award/link', { link_id: id, award_type: '1' })
    bump('like')
    pushHistory({ kind: 'like', linkId: id })
    return { ok: true, message: `给 [${id}] 点了个赞`, url: `${WEB_BASE}/app/bbs/link/${id}` }
  }

  async function comment(link, text, { rootId = '-1', replyId = '-1' } = {}) {
    const id = linkIdOf(link)
    if (!id) return { ok: false, message: '没看出帖子编号' }
    const t = String(text || '').trim().slice(0, 100)
    if (!t) return { ok: false, message: '评论内容空了' }
    if (left('comment') <= 0) return { ok: false, message: '今天的评论额度用完了' }
    await getClient().post('/bbs/app/comment/create', { link_id: id, text: t, root_id: String(rootId), reply_id: String(replyId), is_cy: '0' })
    bump('comment')
    pushHistory({ kind: 'comment', linkId: id, text: t })
    return { ok: true, message: `评论发了：${t}`, url: `${WEB_BASE}/app/bbs/link/${id}` }
  }

  async function remove(link) {
    const id = linkIdOf(link)
    if (!id) return { ok: false, message: '没看出帖子编号' }
    await getClient().post('/bbs/app/link/delete', { link_id: id })
    pushHistory({ kind: 'delete', linkId: id })
    return { ok: true, message: `删掉了 [${id}]` }
  }

  // ── 写：发帖（文章模式 + 行内图） ────────────────────────────────

  function imageInfo(buf, filename) {
    const head = buf.slice(0, 8).toString('latin1')
    const isPng = head.includes('PNG')
    const isJpg = buf.slice(0, 2).toString('latin1') === '\u00ff\u00d8'
    return {
      mimetype: isPng ? 'image/png' : isJpg ? 'image/jpeg' : 'image/jpeg',
      name: filename || (isPng ? 'a.png' : 'a.jpg'),
    }
  }

  /**
   * 读图片真实宽高（只解析文件头，不依赖图形库）。
   *
   * ⚠ 这个函数是修「发帖图片被垂直压扁」的关键：以前上传时 width/height 写死 1000x600，
   *   而实际配图多是 1024x1024 方图，小黑盒按 1000:600（1.67:1）去渲染 1:1 的图，
   *   于是人被压扁。必须把真实宽高传给接口。
   * 支持 JPEG / PNG / WebP（表情包和生图基本都是这三种）。解析不出来返回 null，由调用方兜底。
   */
  function imageSize(buf) {
    if (!buf || buf.length < 24) return null
    const b = buf
    try {
      // PNG：IHDR 在偏移 16 起，4 字节宽 + 4 字节高（大端）
      if (b.slice(1, 4).toString('latin1') === 'PNG') {
        const w = b.readUInt32BE(16)
        const h = b.readUInt32BE(20)
        if (w > 0 && h > 0) return { width: w, height: h }
      }
      // WebP：RIFF....WEBP，三种子格式
      if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') {
        const fmt = b.slice(12, 16).toString('latin1')
        if (fmt === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
        if (fmt === 'VP8L') {
          const bits = b.readUInt32LE(21)
          return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
        }
        if (fmt === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
      }
      // JPEG：扫 SOF 段（0xFFC0~0xFFCF，排除 C4/C8/CC）
      if (b.slice(0, 2).toString('latin1') === '\u00ff\u00d8') {
        let off = 2
        while (off + 9 < b.length) {
          if (b[off] !== 0xff) { off++; continue }
          const marker = b[off + 1]
          // SOF 段里带着宽高
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            const h = b.readUInt16BE(off + 5)
            const w = b.readUInt16BE(off + 7)
            if (w > 0 && h > 0) return { width: w, height: h }
          }
          const len = b.readUInt16BE(off + 2)
          if (len < 2) break
          off += 2 + len
        }
      }
    } catch { /* 文件头不认识就交给调用方兜底 */ }
    return null
  }

  /** 腾讯云 COS 四步直传，返回 { url, width, height } */
  async function uploadImage(buf, filename, width, height) {
    const c = getClient()
    const info = imageInfo(buf, filename)
    // 尺寸：显式传的 > 文件头解析的真实值 > 1024x1024（方图，别再默认 1000x600 ——
    // 那个比例会把方图压扁，就是这个 bug 的根源）
    const real = imageSize(buf)
    const W = Number(width) || (real && real.width) || 1024
    const H = Number(height) || (real && real.height) || 1024
    const fileInfos = JSON.stringify([{ name: info.name, mimetype: info.mimetype, fsize: buf.length, width: W, height: H }])

    const step1 = await c.post('/bbs/app/api/qcloud/cos/upload/info/v2', { file_infos: fileInfos, scope: 'bbs', need_cache: '0' })
    const r1 = step1.result || {}
    const key = (r1.keys || [])[0]
    if (!key) throw new HeyboxError('图片上传第一步没拿到 key', 'upload')

    const step2 = await c.post('/bbs/app/api/qcloud/cos/upload/token/v2', {
      bucket: r1.bucket, keys: JSON.stringify([key]), mimetypes: JSON.stringify([info.mimetype]), is_multipart_upload: '0',
    })
    const creds = (step2.result || {}).credentials || {}
    if (!creds.tmpSecretId) throw new HeyboxError('图片上传第二步没拿到临时凭证', 'upload')

    const cosHost = `${r1.bucket}.cos.${r1.region}.myqcloud.com`
    const now = Math.floor(Date.now() / 1000)
    const keyTime = `${now};${now + 180}`
    const auth = cosSign({ secretId: creds.tmpSecretId, secretKey: creds.tmpSecretKey, path: key, host: cosHost, contentLength: buf.length, keyTime })
    await c.putCOS(`https://${cosHost}${key.split('/').map(encodeURIComponent).join('/')}`, buf, {
      contentType: info.mimetype, authorization: auth, sessionToken: creds.sessionToken,
    })

    const step4 = await c.post('/bbs/app/api/qcloud/cos/upload/callback/v2', { keys: JSON.stringify([key]) }, { is_finished: 'true' })
    const url = ((step4.result || {}).preview_urls || [])[0]
    if (!url) throw new HeyboxError('图片上传最后一步没拿到地址', 'upload')
    return { url, width: W, height: H }
  }

  /** 文章模式组装：html 块（行内 <img>）+ 末尾 img 引用块（封面/图库） */
  /** 上传一张图并返回行内 <img> 片段（失败只记日志，不打断发帖） */
  async function uploadInline(seg) {
    try {
      const up = await uploadImage(seg.buf, seg.filename, seg.width, seg.height)
      return { ...up, html: `<p><img data-type="image" data-original="${up.url}" data-width="${up.width}" data-height="${up.height}" data-description=""></p>` }
    } catch (e) {
      log?.warn?.('小黑盒配图上传失败，跳过这张：' + e.message)
      return null
    }
  }

  /**
   * 文章模式组装。三种插图位置：
   *   1) afterIntro —— 首段（自我介绍）之后，文首配图：以大肥鱼形象图为主
   *   2) inline     —— 文章中段，与内容贴合的图（没有就不放）
   *   3) tail       —— 文末，以大肥鱼形象图为主
   * 规则：正文不足 500 字时不放文首图（短文配大图显得凑数）。
   */
  async function buildArticle(segments, opts = {}) {
    const minWords = Number(opts.minWordsForIntroImage) > 0 ? Number(opts.minWordsForIntroImage) : 500
    const paras = []
    const texts = []
    for (const seg of segments || []) {
      if (seg.type !== 'text') continue
      const t = String(seg.text || '').replace(/\n+$/, '')
      if (!t.trim()) continue
      texts.push(t)
      const esc = htmlEscape(t)
      for (const para of esc.split(/\n\s*\n/)) {
        if (para.trim()) paras.push('<p>' + para.trim().replace(/\n/g, '<br>') + '</p>')
      }
    }
    if (!paras.length && !(segments || []).some((x) => x.type === 'img' && x.buf)) {
      throw new HeyboxError('没内容可发', 'input')
    }
    const fullText = texts.join('\n') || '（图片帖）'
    const words = countWords(fullText)
    const canIntroImg = words >= minWords

    const intro = []
    const inline = []
    const tail = []
    for (const seg of segments || []) {
      if (seg.type !== 'img' || !seg.buf) continue
      const pos = seg.position === 'tail' ? 'tail' : (seg.position === 'inline' ? 'inline' : 'afterIntro')
      // 短文不放文首图：这里先判断再上传，别白传一张再丢掉（上传要几十秒、还占接口额度）
      if (pos === 'afterIntro' && !canIntroImg) {
        log?.info?.('正文不足 ' + minWords + ' 字，跳过文首配图：' + seg.filename)
        continue
      }
      const up = await uploadInline(seg)
      if (!up) continue
      if (pos === 'afterIntro') intro.push(up)
      else if (pos === 'inline') inline.push(up)
      else tail.push(up)
    }

    const html = []
    const insertAt = (imgs) => { for (const u of imgs) html.push(u.html) }
    paras.forEach((para, i) => {
      html.push(para)
      if (i === 0) insertAt(intro)
      if (inline.length && i > 0 && i < paras.length - 1) {
        const slots = Math.max(1, Math.min(inline.length, paras.length - 2))
        const per = Math.ceil(inline.length / slots)
        const slotIdx = i - 1
        if (slotIdx < slots) insertAt(inline.slice(slotIdx * per, slotIdx * per + per))
      }
      if (i === paras.length - 1) insertAt(tail)
    })
    if (!paras.length) { for (const u of [...intro, ...inline, ...tail]) html.push(u.html) }
    if (!html.length) throw new HeyboxError('没内容可发', 'input')

    const allImgs = [...intro, ...inline, ...tail]
    const blocks = [{ type: 'html', text: html.join('') }]
    for (const b of allImgs) blocks.push({ type: 'img', url: b.url, width: String(b.width), height: String(b.height) })
    return {
      blocks, fullText, words,
      images: { intro: intro.length, inline: inline.length, tail: tail.length, total: allImgs.length },
      introSkipped: !canIntroImg && words < minWords,
    }
  }

  /** 创作者中心最新帖 id：文章模式一般直接返回 link_id，这个只做兜底 */
  async function latestPostId() {
    try {
      const d = await getClient().get('/bbs/app/author/concept/article/list', {
        article_type: 'all', artilce_state: 'all', sort_filter: 'create_at', offset: 0, limit: 1,
      })
      const r = d.result || {}
      const list = r.articles || r.links || r.list || []
      const first = list[0]
      return first ? String(first.linkid ?? first.link_id ?? '') : ''
    } catch { return '' }
  }

  async function post({ title, text = '', images = [], imagesByPos = null, topic = '', style = '', hashtags = [], mood = '', look = '', wordsMin = 0, wordsMax = 0 } = {}) {
    const cfg = getConfig().heybox || {}
    // 没显式给风格/分区/话题时，按「今天第几篇」的排期取
    const plan = currentPostPlan()
    const t = String(title || '').trim()
    if (!t) return { ok: false, message: '标题不能空' }
    if (t.length > 30) return { ok: false, message: `标题 ${t.length} 字，太长了（最多 30 字）` }

    // 先占额再干活：中间要等分区/话题/上传，几十秒的空窗期里并发进来的发帖
    // 会各自通过「还剩几篇」的检查，一天就能发出超过上限的篇数。
    // 占额和检查在同一次读改写里完成；后面任何一步失败都在 finally 里退回去。
    const slot = reserveQuota('post')
    if (!slot.ok) return { ok: false, message: '今天的发帖额度用完了（建议一天别超过 3 篇）' }
    let reserved = true
    const giveBack = () => { if (reserved) { reserved = false; releaseQuota('post') } }

    try {
    // 字数范围：显式传入的（自动发帖给模型写的要求）> 排期 > 面板手改 > 风格自带值
    // ⚠ 排期项里缺一个值时必须回落，不能把 undefined 当成覆盖，否则 words 会变成 NaN 校验直接失效
    const wordCfg = (wordsMin || wordsMax)
      ? { postWordsMin: wordsMin || plan.wordsMin || cfg.postWordsMin, postWordsMax: wordsMax || plan.wordsMax || cfg.postWordsMax }
      : (plan.wordsMin || plan.wordsMax)
        ? { postWordsMin: plan.wordsMin, postWordsMax: plan.wordsMax }
        : cfg
    const st = styleOf(style || plan.style || cfg.postStyle, wordCfg)
    const words = countWords(text)
    // 字数**硬校验**：以前只在明显偏短时记一条 warn，照样发出去，结果就是「永远达不到设置的字数」。
    // 现在低于下限直接拒绝，把差额和该怎么补告诉调用方，让她重写后再发。
    const minW = Number(st.words?.[0]) || 0
    const maxW = Number(st.words?.[1]) || 0
    if (minW && words < minW) {
      const short = minW - words
      return {
        ok: false,
        code: 'too_short',
        words, minWords: minW, maxWords: maxW, needMore: short,
        message: `正文只有 ${words} 字，低于「${st.label}」的下限 ${minW} 字（还差 ${short} 字），没有发出。`
          + `请补到 ${minW}~${maxW} 字再发：可以多给一个具体细节（价格 / 销量 / 机制名 / 时间点）、`
          + `多写一段你自己的看法，或者把某个点展开说。别用「首先其次总之」这类词凑字数。`,
      }
    }
    if (maxW && words > maxW) {
      return {
        ok: false,
        code: 'too_long',
        words, minWords: minW, maxWords: maxW, exceed: words - maxW,
        message: `正文 ${words} 字，超过「${st.label}」的上限 ${maxW} 字（多 ${words - maxW} 字），没有发出。请删减到 ${minW}~${maxW} 字再发。`,
      }
    }

    // 分区：显式给了就用；否则按 topicMode 决定（manual 用默认 / auto 按内容挑）
    let topicId = String(topic || plan.topic || '').trim()
    if (!topicId) {
      const fallback = String(cfg.defaultTopic || 7214)
      topicId = await pickTopicFor(`${t}\n${text}`, fallback).catch(() => fallback)
    }
    // 显式传的分区要校验：乱填会让整帖报「错误的帖子类型」，不如提前拦下来告诉她填错了
    if (!/^\d+$/.test(topicId)) {
      return { ok: false, code: 'bad_topic', message: `分区「${topicId}」不是数字 id。用 heybox_topics 查，或用面板选的默认分区。` }
    }
    // ⚠ 分区校验的集合必须是「内置 ∪ 动态」：
    //   TOPICS（api.mjs）只有内置 3 个，而 topicMode=auto 时 pickTopicFor 是从
    //   refreshTopics() 的动态表（实测 71 个，含游戏分区）里挑的；面板的默认分区和
    //   排期里的 topic 也来自同一份动态表。只认内置 3 个会把它们全判成 bad_topic，
    //   等于把正常发帖挡死（这是 P0）。
    //   缓存拿不到时退回内置三个，不能因为拉不到分区表就拒发。
    const topicCacheList = (() => {
      try { return readState().topics?.list || [] } catch { return [] }
    })()
    const knownIds = new Set([
      ...Object.keys(TOPICS || {}),
      ...topicCacheList.map((t) => String(t.id)).filter(Boolean),
    ])
    if (knownIds.size && !knownIds.has(topicId)) {
      // 缓存是空的/过期的就别硬拦：宁可让她发一次可能失败的帖，也不要挡住正常发帖。
      // 只有「缓存里确实有一批分区、但这个 id 不在其中」才判为错填。
      if (topicCacheList.length > 0) {
        const sample = topicCacheList.slice(0, 6).map((t) => `${t.id}=${t.name}`).join('、')
        return {
          ok: false, code: 'bad_topic',
          message: `分区 id ${topicId} 不在当前分区表里（共 ${knownIds.size} 个，例如 ${sample} 等）。`
            + `请用 heybox_topics 查真实 id，或清空这一个参数走默认分区。`,
        }
      }
    }

    // 话题：传名字或 id 都行，这里解析成 {id,name}；发帖时只把 name 当纯文本发出去（见下面 hashtags）
    const actItems = await resolveHashtagItems(hashtags.length ? hashtags : (plan.hashtags || [])).catch(() => [])
    const readImg = (p, position) => {
      try {
        const buf = fs.readFileSync(p)
        const size = imageSize(buf) || {}
        return { type: 'img', buf, filename: path.basename(p), position, width: size.width, height: size.height }
      } catch { log?.warn?.('配图读不到，跳过：' + p); return null }
    }

    const segs = []
    if (text) segs.push({ type: 'text', text })
    let byPos = imagesByPos && typeof imagesByPos === 'object' ? imagesByPos : null
    // 没显式给图 → 按字数自动规划（生图优先、表情包兜底）
    let autoPlan = null
    if (!byPos && !images.length) {
      autoPlan = await planImages(text, { mood: mood || '', look: look || '' }).catch((e) => {
        log?.warn?.('自动配图规划失败：' + String(e.message).slice(0, 60))
        return null
      })
      if (autoPlan && autoPlan.slots.length) {
        byPos = { intro: [], inline: [], tail: [] }
        for (const s of autoPlan.slots) {
          if (s.kind === 'intro') byPos.intro.push(s.path)
          else if (s.kind === 'inline') byPos.inline.push(s.path)
          else byPos.tail.push(s.path)
        }
      }
    }
    if (byPos) {
      for (const p of (byPos.intro || []).slice(0, 3)) segs.push(readImg(p, 'afterIntro'))
      for (const p of (byPos.inline || []).slice(0, 3)) segs.push(readImg(p, 'inline'))
      for (const p of (byPos.tail || []).slice(0, 3)) segs.push(readImg(p, 'tail'))
    }
    // 旧参数 images：没有 byPos 时当作文末配图（保持老行为）
    if (!byPos) for (const p of images) segs.push(readImg(p, 'tail'))
    const cleanSegs = segs.filter(Boolean)

    // 「每日羊毛」(deal) 硬校验：这一档的价值全在真实入口链接上，没链接的羊毛帖
    // 发出去就是水贴（还可能是编造的 URL）。提示词里早就写了「没链接别发」，
    // 但只有提示词约束不够——这里真拦：正文里一个链接都没有就拒发。
    // 判定看 st.needLink（styles.mjs 里标在 deal 上），这样新增「要链接」的风格不用改这里。
    if (st.needLink) {
      const links = String(text).match(/https?:\/\/[^\s"'<>）)]+/g) || []
      // 只在「确实没给任何链接」时拦；给了链接（哪怕是小黑盒自己的）就放行，
      // 具体链接是否有效由她按提示词里那份「手里有的链接」自己判断。
      if (!links.length) {
        return {
          ok: false,
          code: 'no_link',
          message: '「每日羊毛」这一档必须带真实可点的入口链接，这帖正文里一个链接都没有，没有发出。'
            + '请补上直达链接（活动页 / 商店页 / 领取入口），链接只能从手里真实有的里挑，不要自己拼凑 URL。'
            + '如果这波确实拿不到链接，就换个有链接的角度，或者改用别的风格发。',
        }
      }
    }

    // 配图校验：以前她经常一张都不传，发出来全是纯文字，所以这里要拦。
    //
    // ⚠ 但拦必须拦得有理：只在「**本来能配**却没配」时拒发。如果：
    //   · 生图模块没开（或调不动），并且
    //   · 本机也没有可用的表情包图库（干净机器上 ~/.dsh/meme-packs 不存在）
    //   那么她是真的拿不到任何图 —— 这时硬拒会让所有发帖全部失败，和
    //   styles.mjs 里那句「本机没找到可用的形象图，可以不配图」直接冲突。
    //   这种情况就放行纯文字帖，并在返回值里标明 textOnly，别静默降级。
    const hasImageSeg = cleanSegs.some((x) => x.type === 'img' && x.buf)
    if (!hasImageSeg) {
      const avail = availableImages()
      const canGenerate = await (async () => {
        try { return Boolean(await imagegen?.enabled?.()) } catch { return false }
      })()
      if (avail.length > 0 || canGenerate) {
        return {
          ok: false,
          code: 'no_image',
          available: avail.length,
          canGenerate,
          samplePaths: avail.slice(0, 3).map((x) => x.path),
          message: canGenerate && !avail.length
            ? '这帖没带图，没有发出。生图是开着的，请传 mood / look 让它按内容现画，'
              + '或者不传 imagesByPos 让它自动配图（配几张按字数算）。'
            : `这帖没带图，没有发出。小黑盒的帖子要配图才好有人看：请从下面这些本机形象图里挑 1-2 张，`
              + `用 imagesByPos 传（tail 最稳，intro 需要正文满 500 字才生效）。样例：${avail.slice(0, 2).map((x) => x.path).join(' ； ')}`,
        }
      }
      // 既没图库、生图也没开：放行纯文字帖
      log?.warn?.('拿不到任何配图（生图未开 + 图库为空），这一帖按纯文字发：' + t)
    }

    const built = await buildArticle(cleanSegs)

    // 上传后校验：图「读到」不等于「传上去了」。
    // buildArticle 遇到上传失败只 warn 一句就跳过，帖子照发 —— 线上那些纯文字帖就是这么来的。
    //
    // ⚠ 但要区分两种情况，否则会把「本来就没图」的纯文字帖也拦掉：
    //   · 这一帖压根没打算配图（segs 里没有图片段）→ 不算上传失败
    //   · 有图片段但一张都没传上去 → 这才是真的失败
    const wantedImages = cleanSegs.some((x) => x.type === 'img' && x.buf)
    if (wantedImages && !built.images.total) {
      const avail = availableImages()
      return {
        ok: false,
        code: 'image_upload_failed',
        available: avail.length,
        samplePaths: avail.slice(0, 3).map((x) => x.path),
        message: '配图一张都没传上去（上传接口失败），所以这帖没发。'
          + '请换一张图再试：优先用 .jpg（png/webp 偶尔会被拒），'
          + '路径从下面清单里原样复制，不要用刚下载的临时文件。样例：'
          + avail.slice(0, 2).map((x) => x.path).join(' ； '),
      }
    }
    const blocks = built.blocks
    const fullText = built.fullText
    const desc = fullText.replace(/\s+/g, ' ').slice(0, 80)
    const d = await getClient().post('/bbs/app/api/link/post', {
      link_tag: '11',                         // 11=文章（富文本，行内插图真正生效）
      text: JSON.stringify(blocks),
      title: t,
      desc,
      words_count: String(countWords(fullText)),
      topic_ids: topicId,                     // 必须给，否则「请添加分区」
      // ⚠ 话题怎么挂（2026-11-02 实测结论，别再改回对象数组）：
      //   · 传对象数组 [{name,hashtag_id}] / [{hashtag_id}] → HTTP 500（以前发帖一直 500 的真凶）
      //   · 传「话题名字的纯文本数组」["盒友日常","软件推荐"] → 能发出去，
      //     并且服务端会把它们写进帖子的 content_tags（style_type=2，protocol 指向 /bbs/hashtag），
      //     这就是小黑盒页面上显示的话题。
      //   · 判定标准是 content_tags 里有没有 style_type=2 项，**不是** hashtags 字段 ——
      //     真实带话题的帖子 hashtags 常常是空的，光看那个字段会误判成「没挂上」。
      //   · 发出去之后不能再改：/link/edit、/link/hashtag/add 等 4 个路径全 404。
      hashtags: actItems.length ? JSON.stringify(actItems.map((x) => x.name)) : '[]',
      schedule_ts: '0',
      view_limit: '1',                        // 1=所有人
      post_type: '1',
      original: '1',
      declaration: '0',
    })

    const r = d.result || {}
    let id = String((typeof r === 'object' && (r.link_id ?? r.linkid)) || d.link_id || d.linkid || '')
    if (!id) id = await latestPostId()

    // 占位的那一次就是这一帖的消耗，不再额外 bump
    reserved = false
    // 回查一次：话题是否真的落进 content_tags（接口回 ok 不代表生效）
    let tagsVerified = null
    if (id && actItems.length) {
      try {
        const chk = await getClient().get('/bbs/app/link/tree', { link_id: String(id), page: 1, is_first: 1, index: 1, owner_only: 0, offset: 0, limit: 1, sort_filter: 'hot' })
        const link = (chk && chk.result && chk.result.link) || (chk && chk.result) || {}
        const tags = link.content_tags || []
        tagsVerified = tags.filter((x) => String(x.protocol || '').includes('hashtag')).map((x) => String(x.text || ''))
      } catch (e) { log?.warn?.('话题回查失败：' + e.message) }
    }
    const url = id ? `${WEB_BASE}/app/bbs/link/${id}` : ''
    pushHistory({ kind: 'post', linkId: id, title: t })
    memory?.addEvent?.({ text: `我在小黑盒发了一帖《${t}》`, tags: ['小黑盒'], importance: 0.5 })

    const inline = blocks[0]?.type === 'html' ? (blocks[0].text.match(/<img /g) || []).length : 0
    return {
      ok: true,
      message: (url ? `发出去了：${url}` : '发出去了，但没拿到帖子编号') + `（风格：${st.label}，行内图 ${inline} 张）`,
      url, linkId: id, inline, topicId, style: st.id, images: built.images, introSkipped: built.introSkipped,
      // textOnly=true 表示「既没图库、生图也没开」，这一帖是被迫发的纯文字（不是配图失败）
      textOnly: built.images.total === 0,
      // 话题以纯文本名字随帖提交，服务端写进 content_tags；这里如实回报带了哪些。
      hashtags: actItems.map((x) => x.name),
      hashtagsVerified: tagsVerified,          // 真正落进 content_tags 的话题名；null=没回查/失败
      hashtagsOk: tagsVerified ? tagsVerified.length : null,
      hashtagsNote: actItems.length ? '' : '',
      // 自动配图来源：现画几张、表情包兜底几张（手动传图时是 null）
      autoImages: autoPlan ? { planned: autoPlan.slots.length, generated: autoPlan.generated, fallback: autoPlan.fallback, kinds: autoPlan.slots.map((x) => x.kind) } : null,
      plan: plan.fromPlan ? plan.slot : null,
    }
    } catch (e) {
      // 抛异常（比如网络层直接 throw）也要把额度退回去，不然白白扣掉一篇
      giveBack()
      throw e
    } finally {
      // 任何提前 return 的失败路径都走这里：退额
      giveBack()
    }
  }

  // ── 可用配图：给发帖挑图用 ───────────────────────────────────
  //
  // 以前提示词里只说「配图至少 3 张更好」，却从没告诉她图在哪，
  // 她自然一张都没传，发出来全是纯文字。这里把本机可用的形象图找出来递过去。

  /** 大肥鱼表情包图库目录（有就按类别收，没有返回空） */
  function memeImageDirs() {
    // 根目录可注入（测试用临时假图库，避免依赖用户机器上有没有这些表情包）
    const base = memeRoot ? String(memeRoot) : path.join(HOME, '.dsh', 'meme-packs')
    const packs = ['dafeiyu-learned', 'dafeiyu', 'deepseek-chan']
    const out = []
    for (const p of packs) {
      const dir = path.join(base, p, 'memes')
      if (!fs.existsSync(dir)) continue
      try {
        for (const cat of fs.readdirSync(dir)) {
          const sub = path.join(dir, cat)
          if (!fs.statSync(sub).isDirectory()) continue
          const files = fs.readdirSync(sub).filter((f) => /^[^.].*[.](jpg|jpeg|png|webp)$/i.test(f)).sort()
          if (files.length) out.push({ category: cat, dir: sub, files })
        }
      } catch { /* 这个图库读不了就跳过 */ }
    }
    return out
  }

  /**
   * 给模型一份可用配图清单（每类给几张绝对路径）。
   * 每类只给 2-3 张，避免把提示词撑太大。
   */
  function availableImages(limitPerCat = 3) {
    const groups = memeImageDirs()
    const out = []
    for (const g of groups) {
      for (const f of g.files.slice(0, limitPerCat)) out.push({ category: g.category, path: path.join(g.dir, f) })
    }
    return out
  }

  // ── 配图规划：按字数决定要几张、放哪、画什么 ──────────────────────
  //
  // 规则（主人定的）：
  //   · 500 字以内 → 1 张，文末
  //   · 500~1000 字 → 2 张：首段后 1 张 + 文末 1 张
  //   · 1000 字以上 → 每多 1000 字，正文中间再加 1 张
  // 每张都优先用生图工具按「这一帖的心情 + 这一段的内容」现画；
  // 生图调不动（没开/失败/超时）就用表情包库里的图兜底，保证这帖发得出去。

  // ── 形象设定：少女大肥鱼 ────────────────────────────────────────
  //
  // 形象对照表情包库（~/.dsh/meme-packs/dafeiyu-learned）写在这里。
  // 生图模型不知道「大肥鱼」是谁，每次必须把外形讲清楚，否则画出来是条真鱼。
  // 关键特征：蓝渐变长发（深蓝→发梢浅蓝）、蓝色大眼睛、鲸鱼鳍形状的侧耳、
  //          深蓝女仆连衣裙 + 白荷叶边围裙（围裙上有小鲸鱼图案）、蓝色蝴蝶结、身后蓝色鱼尾。
  const DAHUIYU_ANIME = [
    '二次元日系动漫插画风格，一位可爱的少女（名字叫大肥鱼）',
    '蓝渐变长发，从深蓝到发梢浅蓝，微卷，长度过肩',
    '又大又亮的蓝色眼睛，圆脸，表情生动',
    '头侧有鲸鱼鳍形状的耳朵（蓝色半透明鳍），蓝色蝴蝶结发饰',
    '深蓝色女仆风连衣裙，白色荷叶边围裙，围裙上有小鲸鱼图案',
    '身后一条蓝色鱼尾',
    '线条干净，柔和渐变上色，白色或浅色纯色背景，构图居中，人物半身像',
    '画面里不要出现任何文字、字幕、对话气泡',
  ].join('，')

  const DAHUIYU_REAL = [
    '三次元写实摄影风格，一位真实的少女（名字叫大肥鱼），cosplay 装扮',
    '深蓝到浅蓝渐变的及肩长发（真发质感），蓝色美瞳，五官清秀',
    '头戴鲸鱼鳍造型发饰，蓝色蝴蝶结',
    '深蓝色女仆风格连衣裙，白色荷叶边围裙，围裙上有小鲸鱼刺绣',
    '身后一条布艺/硅胶质感的大蓝色鱼尾道具',
    '自然光，柔和景深，背景干净（室内生活场景或浅色墙面），真人摄影质感，不要塑料感',
    '画面里不要出现任何文字、水印',
  ].join('，')

  /**
   * 这一段适合画什么（给生图用的描述）。
   * @param {string} kind intro / inline / tail
   * @param {object} ctx {mood, excerpt, style}
   */
  function imageIdeaFor(kind, ctx) {
    const mood = String(ctx.mood || '').trim()
    const moodWord = /难过|失落|丧|委屈|烦|累/.test(mood) ? '有点蔫、安静、委屈'
      : /开心|高兴|爽|乐|笑|兴奋/.test(mood) ? '开心、眼睛发亮'
        : /气|怒|火/.test(mood) ? '生气、鼓着腮帮子'
          : /好奇|疑惑|奇怪/.test(mood) ? '好奇、歪着头'
            : '放松、自然'
    const piece = String(ctx.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 50)

    // 二次元 / 三次元：按调用方指定，默认二次元（更贴表情包库的调性）
    const wantReal = String(ctx.style || '').toLowerCase() === 'real'
    const looks = wantReal ? DAHUIYU_REAL : DAHUIYU_ANIME

    let action = ''
    if (kind === 'intro') action = '半身像，视线看向画外，像是在跟读者说话'
    else if (kind === 'inline') action = '正在做这样一件事（只用姿态暗示，不要画成文字）：' + piece
    else action = '收尾的半身像，轻松满足的表情，手边可以放一碗白米饭和一双筷子'

    return `${looks}，表情${moodWord}，${action}`
  }

  /** 从表情包库里挑一张最贴这个位置的兜底图 */
  function pickFallback(kind, used) {
    const groups = memeImageDirs()
    if (!groups.length) return ''
    const prefer = kind === 'tail' ? ['daily', 'happy'] : (kind === 'intro' ? ['happy', 'daily'] : ['daily', 'confused', 'happy'])
    for (const cat of prefer) {
      const g = groups.find((x) => x.category === cat)
      if (!g) continue
      const f = g.files.find((x) => !used.has(path.join(g.dir, x)))
      if (f) { const p = path.join(g.dir, f); used.add(p); return p }
    }
    for (const g of groups) {
      const f = g.files.find((x) => !used.has(path.join(g.dir, x)))
      if (f) { const p = path.join(g.dir, f); used.add(p); return p }
    }
    return ''
  }

  /** 生图超时上限：单张超过这个时间就当失败，走表情包兜底，别把发帖拖死。
   *  本地大模型（ComfyUI + MOSS）实测单张 40-90 秒，机器繁忙时会更久，
   *  所以放到 5 分钟：宁可多等一会儿，也别把一张正在生成的图当失败丢掉。 */
  const GENERATE_TIMEOUT_MS = 300_000
  /** 生图落盘目录最多保留多少张（再多就删最旧的）。按月增长的话用户磁盘会一直涨。 */
  const KEEP_GENERATED = 60

  /** 给 promise 套一个超时；超时就 reject，调用方按失败处理。 */
  function withTimeout(promise, ms, message) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
      // 别让这个 timer 拖住进程退出
      if (typeof timer?.unref === 'function') timer.unref()
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
  }

  /** 只留最近 KEEP_GENERATED 张生图，更旧的删掉；失败不抛（清理失败不该拦住发帖）。 */
  function pruneImageDir(dir) {
    try {
      const files = fs.readdirSync(dir)
        .filter((f) => /^hb-[\w-]+\.(png|jpe?g|webp)$/i.test(f))
        .map((f) => { const p = path.join(dir, f); return { p, t: fs.statSync(p).mtimeMs } })
        .sort((a, b) => b.t - a.t)
      for (const x of files.slice(KEEP_GENERATED)) { try { fs.unlinkSync(x.p) } catch { /* 删不掉就算了 */ } }
    } catch { /* 目录读不了就算了 */ }
  }

  /**
   * 规划这一帖的配图。
   * @returns {Promise<{slots: {kind:string, path:string}[], generated:number, fallback:number, note:string}>}
   */
  async function planImages(text, { mood = '', style = '', look = '' } = {}) {
    const words = countWords(text)
    // 画风（look）：real / 三次元 / 写实 → 真人摄影感；其他（含不填）→ 二次元动漫（默认，最贴表情包库）。
    // 注意：style 是文章风格（diary/news/mix），跟画风无关，别混用。
    const realStyle = ['real', '三次元', '写实'].includes(String(look || '').toLowerCase()) ? 'real' : 'anime'
    const slots = []
    // 首段（第一段正文）与中段摘句，给生图当上下文
    const paras = String(text || '').split(/\n\s*\n/).filter((x) => x.trim())
    const firstPara = paras[0] || ''

    if (words <= 500) {
      slots.push({ kind: 'tail', excerpt: String(text).slice(-80) })
    } else if (words <= 1000) {
      slots.push({ kind: 'intro', excerpt: firstPara })
      slots.push({ kind: 'tail', excerpt: String(text).slice(-80) })
    } else {
      slots.push({ kind: 'intro', excerpt: firstPara })
      slots.push({ kind: 'tail', excerpt: String(text).slice(-80) })
      // 每多 1000 字加一张，放在正文中间
      const extra = Math.floor(words / 1000) - 1
      for (let i = 0; i < Math.min(extra, 4); i++) {
        const idx = Math.floor(paras.length * (i + 1) / (extra + 1))
        slots.push({ kind: 'inline', excerpt: (paras[idx] || firstPara) })
      }
    }

    const used = new Set()
    let generated = 0
    let fallback = 0
    const out = []
    for (const s of slots) {
      let p = ''
      if (imagegen) {
        try {
          const gen = await imagegen.enabled?.()
          if (gen) {
            // 生图加超时：GENERATE_TIMEOUT_MS 里没回来就当这次失败、走表情包兜底。
            // 不加超时的话，生图服务卡住会把整个发帖拖死（发帖是串行等图的）。
            const buf = await withTimeout(
              imagegen.generate(imageIdeaFor(s.kind, { mood, excerpt: s.excerpt, style: realStyle }), { shape: 'square' }),
              GENERATE_TIMEOUT_MS,
              '生图超过 ' + Math.round(GENERATE_TIMEOUT_MS / 1000) + ' 秒没返回',
            )
            if (buf && buf.length) {
              // 生图落盘目录可注入（测试指到临时目录，免得写真实家目录被沙箱拦成 EPERM 后回退成空表情包）
              const f = imageDir ? String(imageDir) : path.join(HOME, '.dsh', 'heybox-imgs')
              fs.mkdirSync(f, { recursive: true })
              // 扩展名跟着真实格式走：生图服务常返回 PNG，硬写 .jpg 会让后面按后缀判断格式的地方出错
              const ext = buf.slice(1, 4).toString('latin1') === 'PNG' ? '.png'
                : buf.slice(0, 4).toString('latin1') === 'RIFF' ? '.webp' : '.jpg'
              const file = path.join(f, `hb-${Date.now()}-${out.length}-${Math.floor(Math.random() * 999)}${ext}`)
              fs.writeFileSync(file, buf)
              p = file
              generated++
              pruneImageDir(f)
            }
          }
        } catch (e) { log?.warn?.('生图失败，用表情包兜底：' + String(e.message).slice(0, 60)) }
      }
      if (!p) {
        p = pickFallback(s.kind, used)
        if (p) fallback++
      }
      if (p) out.push({ kind: s.kind, path: p })
    }
    return {
      slots: out,
      generated,
      fallback,
      words,
      note: out.length === 0 ? '一张配图都没拿到（生图失败且图库为空），这帖会被拒发' : '',
    }
  }

  /** 按风格给「这一帖该怎么写」的提示词（她生成正文前拿这个） */
  // ── 每天每篇的排期 ──────────────────────────────────────────
  //
  // 面板可以配置「今天发 N 篇，每篇用什么风格/分区/话题/字数」。
  // 发帖时按今天已经发了几篇来取对应那一项的配置；排期用完或没配就用全局设置。

  /**
   * 今天已经发了几篇（用于排期取第几项）。
   *
   * ⚠ 以前读的是 quota().post，但那是「额度计数」，跟「今天真发出去几篇」不是一回事：
   *   · 额度失败会退回、跨零点会整个重置，索引跟着跳；
   *   · 手动发帖一旦没走同一条占额路径，计数也对不上。
   * 现在改成数 history 里今天的 post 记录 —— 那个是发成功才写的，是真的。
   * quota 只留给「还够不够发」用。
   */
  function postsToday() {
    const t = localToday()
    const hist = readState().history || []
    let n = 0
    for (const h of hist) {
      if (h && h.kind === 'post' && Number(h.at) && today(new Date(Number(h.at))) === t) n++
    }
    return n
  }

  /**
   * 取「这一篇」该用的配置。
   * 排期里配了几项就按今天的第几篇取；超出排期范围或没配，返回全局设置。
   */
  function currentPostPlan() {
    const c = getConfig().heybox || {}
    const plan = Array.isArray(c.dailyPosts) ? c.dailyPosts : []
    const idx = postsToday()
    const slot = plan[idx]
    // ⚠ 排期是**按下标**取的，所以 dailyPosts 里的空项必须原样保留：
    //   第 1 篇留「跟全局」、第 2 篇单独配，如果把空项过滤掉，第 2 篇的设置就会被第 1 篇用。
    //   空项（全空对象/只填了 hint 之类）一律当「这一篇走全局设置」处理，不当成没配排期。
    const emptySlot = slot && typeof slot === 'object'
      && !slot.style && !slot.topic && !(slot.hashtags || []).length && !slot.wordsMin && !slot.wordsMax
    if (!slot) {
      return {
        style: c.postStyle || '', topic: '', hashtags: [],
        wordsMin: Number(c.postWordsMin) || 0, wordsMax: Number(c.postWordsMax) || 0,
        hint: '', fromPlan: false, slot: idx,
      }
    }
    if (emptySlot) {
      // 空项：这一篇按全局默认来，但明确它是「第 idx+1 篇」
      return {
        style: c.postStyle || '', topic: '', hashtags: [],
        wordsMin: Number(c.postWordsMin) || 0, wordsMax: Number(c.postWordsMax) || 0,
        hint: String(slot.hint || ''), fromPlan: true, slot: idx, empty: true,
      }
    }
    return {
      style: slot.style || c.postStyle || '',
      topic: slot.topic || '',
      hashtags: slot.hashtags || [],
      wordsMin: slot.wordsMin || Number(c.postWordsMin) || 0,
      wordsMax: slot.wordsMax || Number(c.postWordsMax) || 0,
      hint: slot.hint || '',
      fromPlan: true, slot: idx,
    }
  }

  /** 面板显示：今天计划发几篇、每篇是什么、现在到第几篇 */
  function postPlanState() {
    const c = getConfig().heybox || {}
    const plan = Array.isArray(c.dailyPosts) ? c.dailyPosts : []
    const done = postsToday()
    const isEmpty = (p) => !p || typeof p !== 'object'
      || (!p.style && !p.topic && !(p.hashtags || []).length && !p.wordsMin && !p.wordsMax)
    return {
      configured: plan.length,
      done,
      current: plan[done] ? { ...plan[done], index: done + 1 } : null,
      // empty=true 表示这一篇跟全局走（不是没配排期），面板据此显示「跟全局」
      items: plan.map((p, i) => ({ ...p, index: i + 1, done: i < done, empty: isEmpty(p) })),
    }
  }

  function postBrief(style = '', ctx = {}) {
    const c = getConfig().heybox || {}
    const owner = getConfig().ownerName || '主人'
    const plan = currentPostPlan()
    const wordCfg = (plan.wordsMin || plan.wordsMax) ? { postWordsMin: plan.wordsMin, postWordsMax: plan.wordsMax } : c
    // ⚠ 以前这里是 { ...extra, ...ctx }：ctx 在后，会盖掉 extra.materials，
    //   于是排期里的「本篇要求」在某些调用方传了 materials 时就悄悄丢了。
    //   现在把 hint 并入 materials 再一起传，跟调用方给的材料合并，不靠展开顺序。
    const materials = [
      ...(Array.isArray(ctx.materials) ? ctx.materials : []),
      ...(plan.hint ? ['本篇要求：' + plan.hint] : []),
    ]
    // 把本机可用的形象图递给她，否则她不知道该传什么路径
    const imgs = availableImages()
    return stylePrompt(style || plan.style || c.postStyle, {
      ...ctx,                   // 调用方给的先铺底（owner/about 之类）
      cfg: wordCfg,
      owner: ctx.owner || owner,
      images: imgs,
      materials,
    })
  }

  // 分享前同步落盘占额。超时结果不确定，保留占额和帖子记录，避免重复发送。
  async function shareToOwner(verdict, { owner = '主人' } = {}) {
    const cfg = getConfig() || {}
    const c = cfg.heybox || {}
    if (disposed || !cfg.enabled || !c.enabled || cfg.dryRun || c.shareToOwner === false) return { ok: false, skipped: true, message: '分享未开启或当前不能发送' }
    const text = String(verdict?.share || '').trim()
    const id = linkIdOf(verdict?.linkId)
    if (!text || /^(沉默|［沉默］|（沉默）|\(沉默\)|无|没有|none|null|n\/a)$/i.test(text) || !id) return { ok: false, skipped: true, message: '没有可分享的帖子' }
    const qq = String(cfg.ownerQQ || '').trim()
    if (!/^\d+$/.test(qq) || typeof hub?.sendText !== 'function') return { ok: false, message: '主人 QQ 或发送接口不可用' }
    const st = readState()
    const q = quota()
    if ((st.sharePending || []).includes(id) || (st.shareSeen || []).includes(id) || st.history.some((h) => h.kind === 'share' && h.linkId === id && ['pending', 'sent', 'uncertain'].includes(h.status))) return { ok: false, skipped: true, message: '这条帖子已经分享或发送结果待确认' }
    if (q.share >= Math.max(0, Number(c.shareDaily ?? 3) || 0)) return { ok: false, skipped: true, message: '今天的分享额度用完了' }
    const entry = { kind: 'share', linkId: id, text: text.slice(0, 60), status: 'pending', at: nowMs() }
    q.share += 1
    st.quota = q
    st.sharePending = [...(st.sharePending || []), id]
    st.history = [entry, ...st.history].slice(0, 60)
    if (!writeState(st)) return { ok: false, message: '无法保存分享额度，未发送' }
    const url = `${WEB_BASE}/app/bbs/link/${id}`
    let status = 'failed'
    try {
      // 走正常发送链路让扩展钩子生效。宿主可能把网关超时转成 null，无法确认时保留占额。
      // 有出站治理面（proactive，宿主注入）时优先经它提交：这样「被策略拦下」能拿到明确的
      // dropped/failed，而不是和「网关超时」一起被当成 uncertain 白占一份额度。旧宿主没有该面则照旧直发。
      let sent = null
      let viaPolicy = false
      if (proactive?.submit) {
        try {
          const r = await proactive.submit({ itemId: `heybox:share:${id}`, to: `private:${qq}`, channel: 'qq', text: `${text}\n${url}` })
          if (r && r.deliveryId != null && r.state !== 'unsupported') {
            viaPolicy = true
            // 只有真的进了账本或已发出才算 sent；被丢弃/失败的明确记 failed
            status = ['sent', 'sending', 'pending'].includes(String(r.state || '')) ? 'sent'
              : ['dropped', 'failed', 'expired'].includes(String(r.state || '')) ? 'failed' : 'uncertain'
          }
        } catch (e) {
          log?.warn?.('小黑盒分享经 api.proactive 提交失败，回退直发：' + String(e?.message || e))
        }
      }
      if (!viaPolicy) {
        sent = await hub.sendText(`private:${qq}`, `${text}\n${url}`)
        status = sent?.message_id != null ? 'sent' : sent === false || (sent?.ok === false && !sent.uncertain) ? 'failed' : 'uncertain'
      }
    } catch (e) {
      status = /超时|timeout|timed out|abort/i.test(String(e?.message || e)) ? 'uncertain' : 'failed'
      log?.warn?.('小黑盒分享失败：' + String(e?.message || e))
    }
    const fresh = readState()
    const item = fresh.history.find((h) => h.kind === 'share' && h.linkId === id && h.status === 'pending' && h.at === entry.at)
    if (item) item.status = status
    fresh.sharePending = (fresh.sharePending || []).filter((linkId) => linkId !== id)
    if (status !== 'failed') fresh.shareSeen = [...new Set([...(fresh.shareSeen || []), id])]
    if (status === 'failed' && fresh.quota.date === q.date) fresh.quota.share = Math.max(0, (Number(fresh.quota.share) || 0) - 1)
    writeState(fresh)
    if (status === 'sent') return { ok: true, message: `分享给${owner}了`, linkId: id, url, text }
    return { ok: false, uncertain: status === 'uncertain', message: status === 'uncertain' ? '发送结果未确认，可能已送达，不再重发' : 'QQ 没发出去' }
  }

  // ── 定时自己逛（只读） ─────────────────────────────────────────

  async function browse({ ownerAsked = false, report } = {}) {
    const c = getConfig().heybox || {}
    if (!c.enabled) return { ok: false, message: '小黑盒没打开' }
    if (!hasLogin()) return { ok: false, message: '还没登录小黑盒（面板里填 Cookie）' }
    if (risk().leftMs > 0) return { ok: false, cooling: true, message: '小黑盒在冷却中，请稍后再逛' }
    if (left('browse') <= 0) return { ok: false, message: '今天逛的轮数到上限了' }
    try {
      const list = await feed(0)
      const picked = list.slice(0, Math.max(1, Number(c.perRun) || 3))
      bump('browse')
      const st = readState()
      st.lastRun = nowMs()
      st.browseAt = nowMs()
      st.lastSkipReason = ''
      writeState(st)
      pushHistory({ kind: 'browse', count: picked.length })
      return {
        ok: true,
        message: picked.length
          ? '逛完了，看到这些：\n' + picked.map((x) => `《${x.title || '无标题'}》赞${x.likes} 评${x.comments}  ${WEB_BASE}/app/bbs/link/${x.linkId}`).join('\n')
          : '逛完了，信息流是空的',
        links: picked,
      }
    } catch (e) {
      return { ok: false, message: '逛小黑盒失败：' + e.message }
    }
  }

  // ── 后台会话：先读信息流，再用无工具的独立会话判断要不要分享 ──

  function autoEnabled() {
    const cfg = getConfig() || {}, c = cfg.heybox || {}
    return !disposed && Boolean(cfg.enabled) && !cfg.dryRun && Boolean(c.enabled && c.autoBrowse) && hasLogin()
  }

  function peakText() {
    const c = getConfig().heybox || {}
    const hh = (n) => String(n).padStart(2, '0') + ':00'
    return `${hh(c.peakStartAM ?? 9)}-${hh(c.peakEndAM ?? 12)}、${hh(c.peakStartPM ?? 14)}-${hh(c.peakEndPM ?? 18)}（${c.peakWeekend ? '含周末' : '仅工作日'}）`
  }

  async function runDuty({ memory, owner = '', token = 0 } = {}) {
    if (!autoEnabled()) return { ok: false, message: '没开、试运行或没登录' }
    const c = getConfig().heybox || {}
    if (risk().leftMs > 0) return { ok: false, cooling: true, message: '小黑盒在冷却中' }
    if (c.offPeakOnly && isPeakTime(c, new Date(nowMs()))) return { ok: false, message: '现在是峰时' }
    if (left('browse') <= 0) return { ok: false, message: '今天逛的轮数到上限了' }

    const list = (await feed(0)).slice(0, Math.max(1, Number(c.perRun) || 3))
    if (!autoEnabled() || risk().leftMs > 0) return { ok: false, message: '自动逛已停止' }
    let about = []
    try { about = memory?.recall?.('小黑盒 游戏 帖子 兴趣', { limit: 6 }) || [] } catch { /* 记忆不可用 */ }
    const bias = c.shareBias === 'stingy' ? '只有特别值得分享才写' : c.shareBias === 'proactive' ? '有趣就可以分享' : '觉得主人会喜欢才分享'
    const prompt = [
      '【刷小黑盒，不是聊天】以下是这轮看到的帖子：',
      JSON.stringify(list),
      `关于游戏/社区的记忆：${(Array.isArray(about) ? about : []).map((m) => m.text || m).join('；') || '暂无'}`,
      `主人是 ${owner || '主人'}。${bias}。只从上面的帖子选择编号。`,
      '只输出 JSON：{"note":"一两句话说说看到了什么","share":"想分享的一句话，不分享则空","linkId":"分享的帖子编号","remember":"值得记住的事，没有则空"}',
      c.shareToOwner !== false && left('share') > 0 ? '' : '分享关闭或额度已用完，share 留空。',
    ].filter(Boolean).join('\n\n')
    const out = await hub.runSystemTurn('heybox', 'QQ · 刷小黑盒', prompt, { timeoutMs: 240000, noTools: true })
    if (disposed) return { ok: false, message: '模块已关闭' }
    const verdict = pickJson(out)
    const note = String(verdict?.note || out || '').trim()
    bump('browse')
    const st = readState()
    st.lastRun = nowMs()
    st.browseAt = nowMs()
    st.lastSkipReason = ''
    writeState(st)
    pushHistory({ kind: 'browse', note: note.slice(0, 80) })
    let shared = null
    if (verdict && list.some((x) => x.linkId === linkIdOf(verdict.linkId))) shared = await shareToOwner(verdict, { owner: owner || getConfig().ownerName || '主人' })
    try {
      const t = String(verdict?.remember || note).trim()
      if (t.length > 10) memory?.addEvent?.({ text: `我在小黑盒逛了一圈：${t.slice(0, 120)}`, tags: ['小黑盒'], importance: 0.45 })
    } catch { /* 记忆模块没在跑就算了 */ }
    // 逛完接着看今天排期还欠不欠帖子（以前这里没有这一步，排期配了也永远不会自动发）
    const post = await maybeAutoPost({ memory, owner, list, note, token }).catch((e) => {
      log?.warn?.('小黑盒自动发帖失败：' + e.message)
      return { ok: false, message: e.message }
    })
    return {
      ok: true,
      message: note.slice(0, 300) || '逛完了',
      shared: shared?.ok ? shared : null,
      shareError: shared?.ok === false ? shared.message : '',
      post,
      session: 'system:ext-heybox',
    }
  }

  /**
   * 今天排期还欠几篇？返回 { owe, done, configured, cap, leftQuota }。
   * 排期里一项都没配时 owe=0（不自动发）；额度封顶按 maxPostsPerDay 算。
   */
  function pendingPosts() {
    const c = getConfig().heybox || {}
    const plan = Array.isArray(c.dailyPosts) ? c.dailyPosts : []
    const done = postsToday()
    const cap = Math.max(0, Number(c.maxPostsPerDay) || 0)
    const configured = Math.max(0, plan.length)
    const want = Math.min(configured, cap)
    return { configured, done, cap, owe: Math.max(0, want - done), leftQuota: left('post') }
  }

  /**
   * 在跑的那个 tick / runDuty 自己，不能再拿这把锁去检查自己。
   * 用一个递增编号区分：tick 拿锁时记下编号，maybeAutoPost 发现当前编号就是调用方的就不重复上锁。
   */
  let runToken = 0

  /**
   * 自动补发排期里还没发的那一篇（到点就发，见 postWindowOpen 的判据）。
   *
   * ⚠ 旧版只有 runDuty「逛完顺手」时才会调到这里：逛有 intervalHours 冷却和
   *   maxRunsPerDay 上限，额度烧完 / 还没到冷却点时，排期的第 2、3 篇就永远
   *   等不到触发器 —— 这就是「配了每日 N 篇却只发出 1 篇」的真因。
   *   现在 tick 的第二条触发线 postDue 会直接调它，不再依赖逛。
   *
   * 安全阀：
   *   · 排期没配 / 额度没了 / 冷却中 / 试运行 —— 都不发，只回调一句原因；
   *   · 写出来的稿子先过 post() 自带的校验（字数、配图），不过就拒发，不会硬发；
   *   · 同一轮只发一篇，不会一次刷满。
   */
  async function maybeAutoPost({ memory, owner = '', list = [], note = '', token = 0 } = {}) {
    if (!autoEnabled()) return { ok: false, skipped: true, message: '没开、试运行或没登录' }
    const c = getConfig().heybox || {}
    if (c.autoPost === false) return { ok: false, skipped: true, message: '自动发帖已关（面板里关的）' }
    if (risk().leftMs > 0) return { ok: false, skipped: true, message: '小黑盒在冷却中' }
    const pend = pendingPosts()
    if (!pend.configured) return { ok: false, skipped: true, message: '没配排期，不自动发' }
    if (pend.owe <= 0) return { ok: false, skipped: true, message: `今天的排期已经发完了（${pend.done}/${Math.min(pend.configured, pend.cap)}）` }
    if (pend.leftQuota <= 0) return { ok: false, skipped: true, message: '今天的发帖额度用完了' }
    // 到点才发：owe>0 但还没越过下一篇的计划点，先不发，下一分钟再来（这样每天每篇
    // 都落在自己的时刻上，而不是「逛一圈就顺带发一篇」把上午的额度一口气烧完）
    if (!postWindowOpen(getConfig(), new Date(nowMs()))) return { ok: false, skipped: true, message: '还没到下一篇的排期时刻' }
    // 调用方就是当前正在跑的那一轮（token 对得上），不算抢锁；否则才要抢
    const ownsLock = token && token === runToken
    if (!ownsLock && running) return { ok: false, skipped: true, message: '模块正忙' }
    // 已有锁的话就别再动 running，否则退出时会把外层的锁一起放掉
    const tookLock = !ownsLock
    if (tookLock) running = true
    try {
      const plan = currentPostPlan()
      const about = (() => { try { return memory?.recall?.('小黑盒 游戏 帖子 兴趣', { limit: 5 }) || [] } catch { return [] } })()
      const brief = postBrief(plan.style || c.postStyle, {
        owner: owner || getConfig().ownerName || '主人',
        about: (Array.isArray(about) ? about : []).map((m) => m.text || m).join('；'),
        materials: [
          `本篇是今天排期里的第 ${pend.done + 1} 篇（共 ${Math.min(pend.configured, pend.cap)} 篇）。`,
          note ? `我刚刷到的：${note.slice(0, 200)}` : '',
          Array.isArray(list) && list.length ? `信息流里这些可以当素材：${list.slice(0, 3).map((x) => x.title).join(' / ')}` : '',
        ].filter(Boolean),
        angles: Array.isArray(list) ? list.slice(0, 4).map((x) => x.title) : [],
      })
      const prompt = [
        '【写一篇小黑盒帖子，不是聊天】也不要调用工具，直接输出 JSON。',
        brief,
        '只输出 JSON：{"title":"标题，30 字以内","text":"正文，段落用 \\n\\n 分隔"}',
        '不要输出任何 JSON 以外的字符，不要加代码块围栏。',
      ].join('\n\n')
      let out = ''
      try {
        out = await hub.runSystemTurn('heybox', 'QQ · 小黑盒发帖', prompt, { timeoutMs: 240000, noTools: true })
      } catch (e) {
        log?.warn?.('小黑盒自动发帖：模型没写成（' + e.message + '），本篇先跳过')
        return { ok: false, skipped: true, message: '模型没写成，本篇先跳过' }
      }
      // 等回复的这几分钟里模块可能已经卸载了，别再往下发
      if (disposed) return { ok: false, skipped: true, message: '模块已关闭' }
      const draft = pickJson(out)
      const title = String(draft?.title || '').trim()
      const text = String(draft?.text || '').trim()
      if (!title || !text) {
        log?.warn?.('小黑盒自动发帖：模型没给成型的标题/正文，本轮跳过')
        return { ok: false, skipped: true, message: '模型输出的不是合法 JSON，本轮跳过' }
      }
      // 排期/风格里配了字数下限的，按这个下限写给模型（写不够 post() 会 too_short 拒发，白占一轮）
      const st = styleOf(plan.style || c.postStyle, { ...c, postWordsMin: plan.wordsMin || c.postWordsMin, postWordsMax: plan.wordsMax || c.postWordsMax })
      const minW = Number(st.words?.[0]) || 0
      const maxW = Number(st.words?.[1]) || 0
      const r = await post({ title, text, style: plan.style || '', hashtags: plan.hashtags || [], topic: plan.topic || '', wordsMin: minW, wordsMax: maxW })
      if (r?.ok) log?.info?.(`小黑盒自动发帖成功：${title}`)
      else log?.warn?.('小黑盒自动发帖被拒：' + String(r?.message || '').slice(0, 80))
      return r
    } finally {
      if (tookLock) running = false
    }
  }

  /**
   * 「现在是不是该把今天欠的那一篇发掉」（tick 的第二条触发线）。
   *
   * 判据：今天发的篇数还没到排期要的数（owe>0），且当前时刻已越过
   * 「下一篇」的计划点。越过之后就一直 due（到点补发不设上限，当天把
   * 欠的发完为止，排期跨零点自然重置）；发够了返回 false。
   * 没配排期 / 面板关了自动发帖 → false（别去动 post）。
   */
  function postWindowOpen(cfg = {}, at = new Date()) {
    const c = cfg.heybox || {}
    if (c.autoPost === false) return false
    const pend = pendingPosts()
    if (!pend.configured || pend.owe <= 0) return false
    const slots = postSlots(cfg)
    const idx = pend.done
    if (idx >= slots.length) return true   // 排期比时段多，全天都算「该发」
    // slots[i] 是相对唤醒起点的偏移；rel 是「现在离唤醒起点过了几小时」
    const h = at.getHours() + at.getMinutes() / 60
    const { from } = speakUpWindow(cfg)
    const rel = (h - from + 24) % 24
    return rel >= slots[idx]
  }

  /**
   * 每分钟一次的心跳。真的该干活（due=true）才跑 runDuty / maybeAutoPost。
   *
   * ⚠ 旧版把「发帖」整个挂在「逛」后面：tick 先看 st.lastRun（逛才写）做冷却，
   *   再看 left('browse') 上限，过了这两关才 runDuty → 顺手 maybeAutoPost。
   *   于是发帖时刻 = 逛的时刻，逛额度/冷却一卡，当天排期后面的几篇就发不出去。
   *   现在两件事分开算：
   *   · 逛：冷却只看 browseAt（距上次逛够 intervalHours 才再来一圈）；
   *   · 发帖：看 postWindowOpen —— 今天欠着、且已越过「下一篇」的计划点就 due，
   *     到点直接补发，不受逛的额度和冷却牵连（额度用完 postWindowOpen 自己返回 false）。
   *   跳过时返回 { due: false }（不干活的明确回执），真正跑完返回 { due: true }。
   */
  async function tick({ memory, owner } = {}) {
    if (running || !autoEnabled() || risk().leftMs > 0) return { due: false }
    const cfg = getConfig(), c = cfg.heybox || {}, at = new Date(nowMs())
    if (!awakeNow(cfg, at)) return { due: false }
    const st = readState()
    if (c.offPeakOnly && isPeakTime(c, at)) {
      st.lastSkipReason = `峰时（${peakText()}），等谷时再逛`
      writeState(st)
      return { due: false }
    }
    if (st.retryAt && nowMs() < st.retryAt) return { due: false }
    // 两块活分开算：逛（只读，browseAt 冷却 intervalHours）和发帖（每日排期，到点补发）
    const sinceBrowse = nowMs() - (Number(st.browseAt) || 0)
    const browseDue = left('browse') > 0 && !(st.browseAt && sinceBrowse < (Number(c.intervalHours) || 4) * 3600_000)
    const postDue = postWindowOpen(cfg, at)
    // 逛没额度了，但排期还欠着：别把发帖一起拖下水（旧版在这一关就直接 return）
    if (left('browse') <= 0 && !postDue) {
      st.lastSkipReason = '今天逛的轮数到上限了'
      writeState(st)
      return { due: false }
    }
    if (!browseDue && !postDue) return { due: false }

    running = true
    const myToken = ++runToken
    try {
      // 两件事分开触发：到点该发帖就直接补发（不白烧一次逛的额度）；
      // 逛冷却到期（或两件事同时到点）走完整 runDuty（逛 + 顺手补发到点的那篇）
      const r = postDue && !browseDue
        ? await maybeAutoPost({ memory, owner, token: myToken })
        : await runDuty({ memory, owner, token: myToken })
      const fresh = readState()
      fresh.failures = 0
      fresh.retryAt = 0
      if (!r.ok) fresh.lastSkipReason = r.message
      writeState(fresh)
      if (r.ok) log?.info?.('小黑盒后台会话跑完：' + String(r.message || '').slice(0, 40))
    } catch (e) {
      const fresh = readState()
      const n = Math.min(RETRY_BACKOFF_MS.length, (Number(fresh.failures) || 0) + 1)
      fresh.failures = n
      fresh.retryAt = nowMs() + RETRY_BACKOFF_MS[n - 1]
      fresh.lastSkipReason = e.message
      writeState(fresh)
      log?.warn?.('小黑盒后台会话失败：' + e.message)
    } finally { running = false }
    return { due: true }
  }


  async function account(force = false) {
    const st = readState()
    const ck = cookie()
    if (!ck) {
      const next = { loggedIn: false, message: '还没填 Cookie', checkedAt: nowMs(), nickname: '', heyboxId: '' }
      st.account = next
      writeState(st)
      return { ok: true, ...next }
    }
    if (!force && st.account.checkedAt && nowMs() - st.account.checkedAt < 10 * 60_000) return { ok: true, ...st.account }
    try {
      const d = await getClient().get('/account/restore_login')
      const r = d.result || {}
      const profile = r.profile || r.account_detail || {}
      const heyboxId = String(profile.heybox_id ?? profile.userid ?? r.heybox_id ?? r.account_detail?.userid ?? '')
      const next = {
        loggedIn: Boolean(heyboxId),
        nickname: String(profile.username ?? profile.nickname ?? ''),
        heyboxId,
        message: heyboxId ? '' : '接口没有返回账号',
        checkedAt: nowMs(),
      }
      const fresh = readState()
      fresh.account = next
      writeState(fresh)
      return { ok: true, ...next }
    } catch (e) {
      const next = { loggedIn: false, nickname: '', heyboxId: '', message: e.message, checkedAt: nowMs() }
      const fresh = readState()
      fresh.account = next
      writeState(fresh)
      return { ok: true, ...next }
    }
  }

  function saveCookie(raw) {
    const s = normalizeCookie(raw)
    if (!s) return { ok: false, message: 'Cookie 是空的' }
    if (!/(?:^|;\s*)(?:user_)?pkey=[^;\s]+/.test(s)) return { ok: false, message: '这串 Cookie 里没有 pkey，多半没复制全' }
    const st = readState()
    st.account = { ...DEFAULT_STATE.account }
    writeState(st)
    return { ok: true, cookie: s, message: /x_xhh_tokenid=/.test(s) ? 'Cookie 存好了（有发帖令牌，写操作也能用）' : 'Cookie 存好了（缺 x_xhh_tokenid，点赞评论可能会被拒）' }
  }

  function clearQuota() {
    const st = readState()
    if ((st.sharePending || []).length || st.history.some((h) => h.kind === 'share' && h.status === 'pending')) return { ok: false, message: '分享正在发送或结果待确认，暂不能清零' }
    st.quota = { date: localToday(), like: 0, comment: 0, post: 0, browse: 0, share: 0 }
    writeState(st)
    return { ok: true, message: '今天的小黑盒额度清零了' }
  }

  function state() {
    const st = readState()
    const c = getConfig().heybox || {}
    return {
      ...st,
      quota: quota(),
      limits: { likeDaily: c.likeDaily, commentDaily: c.commentDaily, maxPostsPerDay: c.maxPostsPerDay, maxRunsPerDay: c.maxRunsPerDay, shareDaily: c.shareDaily ?? 3 },
      left: { like: left('like'), comment: left('comment'), post: left('post'), browse: left('browse'), share: left('share') },
      peak: { on: Boolean(c.offPeakOnly), now: isPeakTime(c, new Date(nowMs())), text: peakText(), weekend: Boolean(c.peakWeekend) },
      risk: risk(),
      hasCookie: Boolean(cookie()),
      hasToken: /x_xhh_tokenid=/.test(cookie()),
      topics: TOPICS,
      // 面板下拉的选项来源：分区全表 + 话题全表（活动在前）
      topicsList: (st.topics?.list || []).map((t) => ({ id: t.id, name: t.name, game: Boolean(t.game), hot: t.hot || 0 })),
      actsList: [...(st.acts?.list || []), ...(st.acts?.plain || [])].map((a) => ({ id: a.id, name: a.name, actTitle: a.actTitle || '', contentNum: a.contentNum || 0, isAct: Boolean(a.isAct) })),
      topicsCache: { count: (st.topics?.list || []).length, date: st.topics?.date || '', cached: Boolean(st.topics?.date && st.topics.date === localToday()), fetchedAt: st.topics?.fetchedAt || 0 },
      actsCache: { count: ((st.acts?.list || []).length + (st.acts?.plain || []).length), actCount: (st.acts?.list || []).length, plainCount: (st.acts?.plain || []).length, date: st.acts?.date || '', cached: Boolean(st.acts?.date && st.acts.date === localToday()) },
      topicMode: String(c.topicMode || 'manual'),
      postWords: { min: Number(c.postWordsMin) || 0, max: Number(c.postWordsMax) || 0 },
      postPlan: postPlanState(),
    }
  }

  // 手动解除只做一次用户主动要求的账号检查。检查过程中出现新的风控或账号改变时不能清除。
  async function clearRisk() {
    const current = cookie()
    if (qrStarting || qrSession?.busy || verifyBusy) return { ok: false, message: '登录验证正在进行，请稍后验证当前账号' }
    if (!hasLogin()) return { ok: false, message: '没有可验证的小黑盒账号' }
    const c = getClient(), token = c.riskToken()
    try {
      const result = await verifyCookie(c, current, token)
      if (!result.verified || disposed || token !== c.riskToken() || current !== cookie()) return { ok: false, verified: false, message: '账号尚未确认可用，冷却保持不变' }
      return { ok: true, verified: true, message: '账号可用，冷却已解除', risk: c.clearRisk() }
    } catch (e) { return { ok: false, verified: false, message: '账号验证失败，冷却保持不变：' + e.message, risk: c.riskInfo() } }
  }

  async function qrStart() {
    if (disposed) return { ok: false, message: '模块已关闭' }
    if (qrStarting || qrSession?.busy || verifyBusy) return { ok: false, state: 'busy', message: '登录验证正在进行' }
    qrStarting = true
    qrSession = null
    verifySession = null
    const c = getClient()
    try {
      // 冷却中不发起扫码请求；先等待或由用户主动验证当前账号。
      const result = await startQrLogin(c)
      if (disposed) return { ok: false, message: '模块已关闭' }
      qrSession = { token: result.token, cookies: result.cookies, at: nowMs(), expire: result.expire, riskToken: c.riskToken(), originalCookie: cookie(), busy: false }
      return { ok: true, png: result.png, qrUrl: result.qrUrl, expire: result.expire, message: '请用小黑盒 App 扫码并确认' }
    } catch (e) { return { ok: false, message: '拿二维码失败：' + e.message } }
    finally { qrStarting = false }
  }

  async function qrPoll() {
    const session = qrSession
    if (!session || disposed) return { ok: false, state: 'none', message: '先生成二维码' }
    if (nowMs() - session.at > session.expire * 1000) {
      qrSession = null
      return { ok: false, state: 'expired', message: '二维码已过期' }
    }
    if (session.busy) return { ok: false, state: 'busy', message: '正在查询扫码状态' }
    session.busy = true
    const c = getClient()
    try {
      const r = await pollQrLogin(c, session.token, session.cookies)
      if (disposed || qrSession !== session) return { ok: false, state: 'cancelled', message: '扫码会话已结束' }
      session.cookies = r.cookies || session.cookies
      if (r.state !== 'ok') return { ok: false, state: r.state, message: r.state === 'wait' ? '等待扫码' : r.state === 'ready' ? '等待手机确认' : '扫码状态：' + r.state }
      if (!r.hasPkey || r.verified !== true) return { ok: false, state: 'unverified', verified: false, message: '扫码账号尚未验证通过：' + (r.verifyError || '未取得可用账号') }
      if (session.riskToken !== c.riskToken() || session.originalCookie !== cookie()) return { ok: false, state: 'unverified', verified: false, message: '账号或风控状态已改变，请重新开始' }
      if (typeof setCookie !== 'function') return { ok: false, state: 'save-failed', message: '配置保存接口不可用' }
      await setCookie(r.cookie)
      if (disposed || qrSession !== session) return { ok: false, state: 'cancelled', message: '模块已关闭' }
      saveCookie(r.cookie)
      // 保存后如果发生了新风控，不得清除新冷却。
      if (session.riskToken === c.riskToken()) c.clearRisk()
      qrSession = null
      return { ok: true, state: 'ok', verified: true, nickname: r.nickname, heyboxId: r.heyboxId, message: '扫码登录成功' }
    } catch (e) { return { ok: false, state: 'error', message: '查询扫码状态失败：' + e.message } }
    finally {
      // 未验证的候选 Cookie 不写入配置，也不保留在扫码会话中。
      delete session.cookies.pkey
      delete session.cookies.user_pkey
      session.busy = false
    }
  }

  // 浏览器只提供候选 Cookie；页面无验证框且账号检查明确通过后才保存。
  async function verifyStart(options = {}) {
    if (disposed) return { ok: false, message: '模块已关闭' }
    if (verifyBusy || qrStarting || qrSession?.busy) return { ok: false, state: 'busy', message: '登录验证正在进行' }
    verifyBusy = true
    qrSession = null
    const c = getClient()
    const session = { riskToken: c.riskToken(), originalCookie: cookie() }
    verifySession = session
    try {
      const r = await getVerifier().begin(options)
      if (disposed || verifySession !== session) return { ok: false, message: '验证已结束' }
      if (!r.ok) verifySession = null
      return r
    } catch (error) {
      verifySession = null
      return { ok: false, message: '打开验证窗口失败：' + error.message }
    } finally { verifyBusy = false }
  }

  async function verifyShow(visible = true) {
    if (disposed || !verifySession) return { ok: false, message: '请先开始浏览器验证' }
    if (verifyBusy) return { ok: false, state: 'busy', message: '登录验证正在进行' }
    verifyBusy = true
    try { return await getVerifier().showWindow(visible) }
    catch (error) { return { ok: false, message: '调整窗口失败：' + error.message } }
    finally { verifyBusy = false }
  }

  async function verifyFinish() {
    const session = verifySession
    if (disposed || !session) return { ok: false, verified: false, message: '请先开始浏览器验证' }
    if (verifyBusy || qrStarting || qrSession?.busy) return { ok: false, state: 'busy', verified: false, message: '登录验证正在进行' }
    verifyBusy = true
    const c = getClient()
    const unchanged = () => !disposed && verifySession === session && session.riskToken === c.riskToken() && session.originalCookie === cookie()
    try {
      if (!unchanged()) return { ok: false, verified: false, message: '账号或风控状态已改变，请重新开始' }
      const r = await getVerifier().finish()
      if (!r.ok) return r
      if (!/(?:^|;\s*)(?:user_)?pkey=[^;\s]+/.test(String(r.cookie || ''))) return { ok: false, verified: false, message: '浏览器里没有登录 Cookie' }
      if (!unchanged()) return { ok: false, verified: false, message: '账号或风控状态已改变，请重新开始' }
      const candidate = normalizeCookie(r.cookie)
      const check = await verifyCookie(c, candidate, session.riskToken)
      if (!check.verified || !unchanged()) return { ok: false, verified: false, message: '账号尚未确认可用，Cookie 和冷却保持不变' }
      // 账号检查可能耗时，保存前再看一次页面和 Cookie，防止期间出现新验证或换号。
      const latest = await getVerifier().finish()
      if (!latest.ok) return latest
      if (!unchanged() || latest.cookie !== r.cookie) return { ok: false, verified: false, message: '账号或风控状态已改变，请重新开始' }
      if (typeof setCookie !== 'function') return { ok: false, verified: false, message: '配置保存接口不可用' }
      await setCookie(candidate)
      if (disposed || verifySession !== session) return { ok: false, verified: false, message: '验证已结束' }
      if (session.riskToken !== c.riskToken() || cookie() !== candidate) return { ok: false, verified: false, message: '账号或风控状态已改变，冷却保持不变' }
      saveCookie(candidate)
      c.clearRisk()
      verifySession = null
      return { ok: true, verified: true, nickname: check.nickname, heyboxId: check.heyboxId, count: r.count, shot: r.shot, message: '浏览器账号验证成功，Cookie 已保存' }
    } catch (error) { return { ok: false, verified: false, message: '账号验证失败，Cookie 和冷却保持不变：' + error.message } }
    finally { verifyBusy = false }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    qrSession = null
    verifySession = null
    client?.dispose()
    verifier?.dispose()
  }

  log?.info?.('小黑盒模块起来了' + (cookie() ? '' : '（还没填 Cookie）'))

  return {
    feed, feedReport, detail, watch, hot, search, topicList, refreshTopics, pickTopicFor, actList, refreshActs, resolveHashtags, resolveHashtagItems, searchTopics, currentPostPlan, postPlanState,
    like, comment, remove, post, browse, tick, account, saveCookie, clearQuota, state,
    risk, clearRisk, qrStart, qrPoll, verifyStart, verifyFinish, verifyShow, shareToOwner, hasLogin, dispose,
    linkIdOf, postBrief, POST_STYLES, DEFAULT_POST_STYLE, runDuty, availableImages, planImages,
    maybeAutoPost, pendingPosts, postWindowOpen,
  }
}
