// 模块「回b站@」—— 社区模块，装进 Aurabot 的 modules/bilibili/ 即可。
//
// 做的事：
//   1. 有人在她 B 站评论区 @ 她 → 用她的口气回一条评论
//   2. 互关的人给她发私信 → 用她的口气回一条私信
//
// 安全默认：默认「只回主人的 @」+「只演练不发」，装好先看日志确认口气，再自己关掉演练。
// 每天有上限，同一条只回一次，私信用互关过滤避免回广告号。

/** @type {import('../aurabot').AurabotModule} */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

const AT_API = 'https://api.bilibili.com/x/msgfeed/at?platform=web&build=0&mobi_app=web'
const NAV_API = 'https://api.bilibili.com/x/web-interface/nav'
const RELATION_API = 'https://api.bilibili.com/x/relation'
const CARD_API = 'https://api.bilibili.com/x/web-interface/card'
const REPLY_API = 'https://api.bilibili.com/x/v2/reply/add'
const SESS_API = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions'
const MSGS_API = 'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs'
const DM_SEND_API = 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg'
const DM_DEV_ID = 'A1B2C3D4-0000-0000-0000-000000000000'

const IM_HEADERS = { referer: 'https://message.bilibili.com/', origin: 'https://message.bilibili.com' }
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 超过一天的 @ / 私信不追
const KEEP_SEEN = 300

export default {
  id: 'bilibili',
  name: '回b站@',
  version: '1.0.0',
  api: 1,
  description: '别人在 B 站评论里 @ 她、或互关的人给她发私信，她用自己口气回一句。',

  defaults: {
    enabled: true,
    replyAt: true,        // 回评论里的 @
    atOnlyOwner: true,    // 只回主人的 @，陌生人的不理
    ownerMid: '',         // 主人的 B 站 mid：去他主页链接末尾抄那串数字（改了名也不变）
    replyDm: true,        // 回私信（只回互关的）
    maxPerDay: 10,        // 每天最多回几条（评论+私信合计）
    checkMinutes: 3,      // 每隔几分钟看一次
    dryRun: true,         // 默认只记日志不真发，确认口气没问题再关
  },
  settings: [
    { key: 'enabled', label: '开启', type: 'switch' },
    { key: 'replyAt', label: '回评论里的 @', type: 'switch' },
    { key: 'atOnlyOwner', label: '只回主人的 @', type: 'switch', hint: '打开时只回你在 B 站 @ 她；陌生人、营销号的 @ 一律不理。' },
    { key: 'ownerMid', label: '主人的 B 站 UID', type: 'text', hint: '只回这个 UID 的 @。打开主页链接末尾那串数字（改名不会变）。' },
    { key: 'replyDm', label: '回私信（只回互关的）', type: 'switch' },
    { key: 'maxPerDay', label: '每天最多回几条', type: 'number', min: 1, max: 50 },
    { key: 'checkMinutes', label: '每隔几分钟看一次', type: 'number', min: 1, max: 60 },
    { key: 'dryRun', label: '只记录不真发（试运行）', type: 'switch' },
  ],

  setup(api) {
    const { hub } = api.core
    const dir = api.dataDir()

    // ---------- 小工具 ----------
    const pad = (n) => String(n).padStart(2, '0')
    const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

    function cookieOf() {
      const b = (api.config() || {}).bili || {}
      if (b.cookie && String(b.cookie).includes('SESSDATA=')) return String(b.cookie)
      const parts = []
      if (b.sessdata) parts.push('SESSDATA=' + b.sessdata)
      if (b.biliJct) parts.push('bili_jct=' + b.biliJct)
      if (b.dedeUserId) parts.push('DedeUserID=' + b.dedeUserId)
      return parts.join('; ')
    }
    function csrfOf() {
      const b = (api.config() || {}).bili || {}
      if (b.biliJct) return String(b.biliJct)
      const m = String(b.cookie || '').match(/bili_jct=([0-9a-f]{32})/i)
      return m ? m[1] : ''
    }

    async function bili(url, opts = {}) {
      const cookie = cookieOf()
      if (!cookie) throw new Error('还没填 B 站 Cookie')
      const r = await fetch(url, {
        ...opts,
        headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com', cookie, ...(opts.headers || {}) },
        signal: AbortSignal.timeout(20000),
      })
      const t = await r.text()
      let j = null
      try { j = JSON.parse(t) } catch { /* 非 JSON */ }
      if (!j) throw new Error(`B 站返回了非 JSON（HTTP ${r.status}）`)
      if (j.code !== 0) throw new Error(`B 站返回 ${j.code}${j.message ? '：' + j.message : ''}`)
      return j.data || {}
    }

    // ---------- 状态 ----------
    const stateFile = () => join(dir, 'state.json')
    function loadState() {
      const empty = { seen: [], dms: [], day: '', count: 0 }
      try {
        if (!existsSync(stateFile())) return empty
        const o = JSON.parse(readFileSync(stateFile(), 'utf8'))
        if (!o || typeof o !== 'object') return empty
        return {
          seen: Array.isArray(o.seen) ? o.seen.map(String) : [],
          dms: Array.isArray(o.dms) ? o.dms.map(String) : [],
          day: String(o.day || ''),
          count: Number(o.count || 0) || 0,
        }
      } catch { return empty }
    }
    function saveState(s) {
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(stateFile(), JSON.stringify(s, null, 2), 'utf8')
      } catch (e) { api.log.warn('回b站@：状态存不下', e.message) }
    }
    function stateToday(s) {
      const k = todayKey()
      if (s.day !== k) { s.day = k; s.count = 0 }
      return s
    }

    // ---------- 我自己的 uid ----------
    let meCache = 0
    async function myUid() {
      if (meCache) return meCache
      const d = await bili(NAV_API)
      meCache = Number(d.mid || 0)
      if (!meCache) throw new Error('拿不到自己的 uid（Cookie 可能过期了）')
      return meCache
    }

    // ---------- 评论里的 @ ----------
    async function fetchAt() {
      const d = await bili(AT_API)
      return (d.items || []).map((x) => {
        const it = x.item || {}
        return {
          id: String(x.id),
          time: Number(x.at_time || 0) * 1000,
          name: String((x.user && x.user.nickname) || '').trim(),
          uid: Number((x.user && x.user.mid) || 0),
          text: String(it.source_content || '').slice(0, 300),
          title: String(it.title || ''),
          oid: it.subject_id,
          root: it.root_id || it.source_id,
          parent: it.source_id,
          biz: Number(it.business_id || 0),
        }
      })
    }

    async function replyComment(item, text) {
      const csrf = csrfOf()
      if (!csrf) throw new Error('没有 bili_jct，发不了评论')
      const form = new URLSearchParams({
        oid: String(item.oid),
        type: '1',
        root: String(item.root || item.parent || 0),
        parent: String(item.parent || 0),
        message: text.slice(0, 200), // 不手写「回复 @xx」，B 站靠 parent 自己标
        csrf,
      })
      await bili(REPLY_API, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() })
      return true
    }

    // ---------- 私信 ----------
    // B 站私信接口很娇气，连着查几个会话就 -509，所以名字和互关状态都缓存
    const nameCache = new Map()
    const mutualCache = new Map() // uid -> { v, at }
    const MUTUAL_TTL = 10 * 60_000

    async function nameOf(uid) {
      if (nameCache.has(uid)) return nameCache.get(uid)
      let name = `B站用户${uid}`
      try {
        const d = await bili(`${CARD_API}?mid=${uid}&photo=false`)
        if (d.card && d.card.name) name = String(d.card.name)
      } catch { /* 拿不到就用兜底称呼 */ }
      nameCache.set(uid, name)
      return name
    }

    // attribute 6 = 互相关注；只回互关的，免得回广告号
    async function isMutual(uid) {
      const hit = mutualCache.get(uid)
      if (hit && Date.now() - hit.at < MUTUAL_TTL) return hit.v
      let v = false
      try {
        const d = await bili(`${RELATION_API}?fid=${uid}`)
        v = Number(d.attribute) === 6
      } catch { v = false }
      mutualCache.set(uid, { v, at: Date.now() })
      return v
    }

    async function fetchDms() {
      const me = await myUid()
      const ts = Math.floor(Date.now() / 1000)
      const d = await bili(`${SESS_API}?session_type=1&group_id=0&sess_type=1&start_ts=${ts}&build=0&mobi_app=web`, { headers: IM_HEADERS })
      const out = []
      let looked = 0
      for (const s of d.session_list || []) {
        if (!s || !s.talker_id || Number(s.talker_id) === me) continue
        const last = s.last_msg
        if (!last || !last.sender_uid) continue
        // 不看 unread_count：你在手机/网页上点开看过一遍它就归零了，只认「最后一句是谁说的」
        if (Number(last.sender_uid) === me) continue
        let c = {}
        try { c = JSON.parse(last.content || '{}') } catch { continue }
        if (typeof c.content !== 'string') continue // 系统通知 / 活动提醒，跳过
        const uid = String(s.talker_id)
        if (!(await isMutual(uid))) continue
        // 一次最多翻 2 个会话，防止 -509
        if (looked >= 2) break
        looked++
        const m = await bili(`${MSGS_API}?talker_id=${uid}&session_type=1&size=20&build=0&mobi_app=web`, { headers: IM_HEADERS })
        // messages 是新→旧：从最新往回收，遇到我自己发的就停 —— 这几句就是她还没答的
        const fresh = []
        for (const x of m.messages || []) {
          if (Number(x.sender_uid) === me) break
          if (fresh.length >= 5) break
          let body = {}
          try { body = JSON.parse(x.content || '{}') } catch { continue }
          if (typeof body.content !== 'string' || !body.content.trim()) continue
          fresh.unshift({ seq: Number(x.msg_seqno), text: body.content.trim(), time: Number(x.timestamp || 0) * 1000 })
        }
        if (!fresh.length) continue
        const name = await nameOf(uid)
        const tail = fresh[fresh.length - 1]
        const text = fresh.map((f) => f.text).join('\n').slice(0, 300)
        out.push({ id: `${uid}:${tail.seq}`, uid, name, text, time: tail.time })
      }
      return out
    }

    async function sendDm(uid, text) {
      const csrf = csrfOf()
      if (!csrf) throw new Error('没有 bili_jct，发不了私信')
      const me = await myUid()
      const form = new URLSearchParams({
        'msg[sender_uid]': String(me),
        'msg[receiver_id]': String(uid),
        'msg[receiver_type]': '1',
        'msg[msg_type]': '1',
        'msg[msg_status]': '0',
        'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
        'msg[new_face_version]': '0',
        'msg[dev_id]': DM_DEV_ID,
        'msg[content]': JSON.stringify({ content: String(text).slice(0, 500) }),
        csrf,
        csrf_token: csrf,
      })
      await bili(DM_SEND_API, { method: 'POST', headers: { ...IM_HEADERS, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() })
      return true
    }

    // ---------- 主流程 ----------
    const CLEAN_AT = /^(?:回复\s*)?@[^\s@:：,，]+\s*[:：,，]?\s*/

    async function tick(force = false) {
      const c = api.settings()
      if (!c.enabled && !force) return { ok: false, skipped: true, message: '没开' }
      const s = stateToday(loadState())
      const seen = new Set(s.seen)
      const dmSeen = new Set(s.dms)
      const notes = []
      let n = 0

      // ---- 评论里的 @ ----
      if (c.replyAt) {
        try {
          const items = await fetchAt()
          const now = Date.now()
          // 只回主人：atOnlyOwner 打开时，只留 ownerMid 那一个 UID 的 @，别人一律不理
          const wantMid = String(c.ownerMid || '').trim()
          const mine = c.atOnlyOwner ? items.filter((x) => wantMid && String(x.uid) === wantMid) : items
          const others = items.length - mine.length
          if (c.atOnlyOwner && !wantMid) {
            api.log.warn('回b站@：开了「只回主人的 @」但没填主人的 B 站 UID，这一轮不回任何人')
          }
          const fresh = mine
            .filter((x) => !seen.has(x.id))
            .filter((x) => x.biz === 1 && x.oid)
            .filter((x) => !x.time || now - x.time < MAX_AGE_MS)
            .slice(0, 5)
          if (!fresh.length && others > 0) notes.push(`另有 ${others} 条别人的 @，按设置不理`)
          for (const x of fresh) {
            seen.add(x.id)
            api.log.info(`B 站 ${x.name} 在《${x.title}》@ 了她：${x.text}`)
            if (s.count >= c.maxPerDay) { notes.push('到今天的上限了'); break }
            let reply = ''
            try {
              const bare = !x.text.replace(/@\S+/g, '').trim()
              const prompt = bare
                ? `有人在 B 站视频《${x.title}》下面 @ 了你一下（没写别的字），是 ${x.name}。\n你想回就用你的口气说一句，可以聊聊这个视频，也可以随便应一声（像普通网友，别太长，别自称助手，别再重复 @ 他的昵称），不想回就只输出 [沉默]。只输出回复正文。`
                : `有人在 B 站视频《${x.title}》的评论里 @ 了你，是 ${x.name} 写的：\n「${x.text}」\n你想回就用你的口气回一句（像普通网友聊天，别太长，别自称助手，不要在开头写 @），不想回就只输出 [沉默]。只输出回复正文。`
              reply = await api.think(prompt)
            } catch (e) {
              api.log.warn('回b站@：让她想失败', e.message)
              continue
            }
            reply = String(reply || '').trim().split(/\n+/)[0].replace(CLEAN_AT, '').trim()
            if (!reply || /^\[?沉默\]?$/.test(reply)) continue
            try {
              if (c.dryRun) {
                api.log.info(`回b站@（试运行）：本来要回 ${x.name}：${reply}`)
              } else {
                await replyComment(x, reply)
                s.count++
                n++
              }
              hub.logChat?.('bili', x.name, `在 B 站《${x.title}》@ 她：${x.text} → ${reply}`, '')
            } catch (e) {
              api.log.warn('回b站@：评论回复失败', e.message)
              if (/412|风控|频繁/.test(String(e.message || ''))) break
            }
          }
        } catch (e) {
          api.log.warn('回b站@：拉 @ 失败', e.message)
          notes.push('评论 @：' + e.message)
        }
      }

      // ---- 私信 ----
      if (c.replyDm) {
        try {
          const dms = await fetchDms()
          const now = Date.now()
          const fresh = dms
            .filter((x) => !dmSeen.has(x.id))
            .filter((x) => !x.time || now - x.time < MAX_AGE_MS)
            .slice(0, 3)
          for (const x of fresh) {
            dmSeen.add(x.id)
            api.log.info(`B 站私信 ${x.name}：${x.text}`)
            if (s.count >= c.maxPerDay) { notes.push('到今天的上限了'); break }
            let reply = ''
            try {
              reply = await api.think(
                `${x.name} 在 B 站给你发了私信：\n「${x.text}」\n` +
                `你想回就用你的口气回一句（像朋友聊天，别太长，别自称助手，不要在开头写 @），不想回就只输出 [沉默]。只输出回复正文。`
              )
            } catch (e) {
              api.log.warn('回b站@：私信想失败', e.message)
              continue
            }
            reply = String(reply || '').trim().split(/\n+/)[0].replace(CLEAN_AT, '').trim()
            if (!reply || /^\[?沉默\]?$/.test(reply)) continue
            try {
              if (c.dryRun) {
                api.log.info(`回b站@（试运行）：本来要私信回 ${x.name}：${reply}`)
              } else {
                await sendDm(x.uid, reply)
                s.count++
                n++
              }
              hub.logChat?.('bili', x.name, `B 站私信：${x.text} → ${reply}`, '')
            } catch (e) {
              api.log.warn('回b站@：私信回复失败', e.message)
              if (/412|风控|频繁/.test(String(e.message || ''))) break
            }
          }
        } catch (e) {
          api.log.warn('回b站@：拉私信失败', e.message)
          notes.push('私信：' + e.message)
        }
      }

      s.seen = [...seen].slice(-KEEP_SEEN)
      s.dms = [...dmSeen].slice(-KEEP_SEEN)
      saveState(s)
      return { ok: true, replied: n, message: n ? `回了 ${n} 条` : (notes[0] || '没有新的 @ 或私信'), notes }
    }

    // ---------- 对外 ----------
    // 面板/接口：  GET /aurabot/api/ext/bilibili/state
    api.route('/state', async () => {
      const s = stateToday(loadState())
      return { ok: true, config: api.settings(), today: { day: s.day, count: s.count }, at: s.seen.length, dms: s.dms.length }
    })
    // 手动跑一次：POST /aurabot/api/ext/bilibili/check
    api.route('/check', async () => tick(true))

    // 主人在 QQ 里发「b站」看状态
    api.command({
      name: 'b站',
      aliases: ['bili', '回b站'],
      desc: '看看 B 站 @ 和私信的回复情况',
      run: async () => {
        const s = stateToday(loadState())
        const c = api.settings()
        return `今天回了 ${s.count} 条（上限 ${c.maxPerDay}），见过 ${s.seen.length} 条 @、${s.dms.length} 条私信。${c.enabled ? '' : '现在是关着的。'}`
      },
    })

    // 让她知道有这个能力
    api.rule(() => '别人在 B 站评论里 @ 你、或互关的人给你发私信，你会自己去回一句；主人问起就说清楚是「回b站@」在管。')

    // 定时跑
    const mins = Math.max(1, Number(api.settings().checkMinutes) || 3)
    api.every(mins * 60_000, () => tick(), '回b站@')

    // 别的模块可以 api.use('bilibili') 拿到
    return { tick, fetchAt, fetchDms, replyComment, sendDm }
  },
}