// 撤回守卫：消息进来先等几秒，期间被撤回就不回复；也能主动撤回自己说错的话
// 1.2.2：功能介绍补全，market 与内部元数据同步
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export default {
  id: 'recall-guard',
  name: '撤回守卫',
  version: '1.2.2',
  api: 1,
  description: '撤回守卫：消息进来先等几秒，期间被撤回就不回复；能主动撤回自己发错、答错人或发错对象的消息；支持好友撤回和群撤回，按 message_id 精确匹配；对方打错字时按同音猜本意，内置 52864 条词库、不联网；面板可调等待时间、同音提示方式和候选数量，只写本机统计文件。',
  tab: 'overview',
  panel: 'panel.js',
  defaults: {
    waitSec: 3,
    allowSelfRecall: true,
    allowOwnerRecallOthers: false,
    homophoneOn: true,
    homophoneMode: 'suspicious',
    homophoneMax: 3,
  },
  settings: [
    { key: 'waitSec', label: '等待撤回时间（秒）', type: 'number', min: 0.5, max: 6, step: 0.5, hint: '消息进来先等这么久，期间被撤回就不回复' },
    { key: 'allowSelfRecall', label: '她能撤回自己发的消息', type: 'switch', hint: '关掉后她就没有撤回的能力了' },
    { key: 'allowOwnerRecallOthers', label: '主人可以让她撤回别人的消息', type: 'switch', hint: '群里需要她是管理员才撤得动；QQ 只允许撤回两分钟内的消息' },
    { key: 'homophoneOn', label: '错字按同音理解', type: 'switch', hint: '对方打错字时，告诉她按发音猜本意，别照字面硬读' },
    { key: 'homophoneMode', label: '同音提示方式', type: 'select', options: [{ value: 'suspicious', label: '只在可疑时提示' }, { value: 'always', label: '每条都提醒' }], hint: '「只在可疑时」只在拼不出词、同音能拼出常用词时才提示，最省 token' },
    { key: 'homophoneMax', label: '每个错字给几个候选', type: 'number', min: 1, max: 5, step: 1, hint: '给太多会干扰她判断，3 个够用' },
  ],

  setup(api) {
    const log = (...a) => { try { api.log?.info?.(...a) } catch {} }
    const recalled = new Map() // 被撤回的消息 ID -> 清理时间戳
    const lastInbound = new Map() // 会话 -> 最近一条进来的消息（拿引用 id 用）
    let selfId = ''

    const num = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d }
    const asId = (id) => (/^\d+$/.test(String(id)) ? Number(id) : String(id))
    const settings = () => api.settings() || {}

    // 记住每个会话最近一条进来的消息：主人引用她说的话时，能拿到那条的 message_id
    api.on('message', (msg) => {
      try {
        lastInbound.set(msg.chatId, {
          replyId: msg.replyId ? String(msg.replyId) : '',
          at: Date.now(),
        })
        if (lastInbound.size > 300) lastInbound.delete(lastInbound.keys().next().value)
      } catch {}
      return false // 只记不改，交给后面的逻辑决定回不回
    })

    // 收集被撤回的消息 ID
    api.on('onebot', (ev) => {
      if (ev?.post_type !== 'notice') return
      if (ev.notice_type !== 'friend_recall' && ev.notice_type !== 'group_recall') return
      const mid = String(ev.message_id || '')
      if (!mid) return
      recalled.set(mid, Date.now() + 10000) // 10 秒后自动清理
      log('撤回守卫：收到撤回事件，消息ID', mid)
    })

    // 原来的等待拦截：等一会，期间被撤回了就不回复
    api.on('message', async (msg) => {
      const s = { ...{ waitSec: 3 }, ...settings() }
      const mid = String(msg.messageId || '')
      if (!mid) return false
      await new Promise((r) => setTimeout(r, num(s.waitSec, 3) * 1000))
      const now = Date.now()
      for (const [id, expire] of recalled) if (now > expire) recalled.delete(id)
      if (recalled.has(mid)) {
        recalled.delete(mid)
        log('撤回守卫：消息', mid, '已撤回，阻止回复')
        return true
      }
      return false
    })

    // 拿机器人自己的 QQ 号，用来判断一条消息是不是她发的
    const getSelfId = async () => {
      if (selfId) return selfId
      try {
        const r = await api.onebot('get_login_info', {})
        const d = r?.data || r || {}
        selfId = String(d.user_id || '')
      } catch (e) { log('撤回守卫：取登录信息失败', e.message) }
      return selfId
    }

    // 撤回一条消息。返回 { ok, message }
    const doRecall = async ({ id, chat, sessionId, note }) => {
      const s = settings()
      const mid = String(id || '').trim()
      if (!mid) return { ok: false, message: '不知道撤哪条：引用那条消息再说一次，或者把消息 ID 给我。' }

      let info = null
      let sender = ''
      try {
        const r = await api.onebot('get_msg', { message_id: asId(mid) })
        info = r?.data || r || {}
        sender = String(info.user_id || info.sender?.user_id || '')
      } catch (e) { log('撤回守卫：查消息失败', mid, e.message) }

      const me = await getSelfId()
      const isSelf = Boolean(me && sender && sender === me)
      const ownerTurn = Boolean(chat?.userId && api.isOwner?.(chat.userId))

      if (isSelf) {
        if (s.allowSelfRecall === false) return { ok: false, message: '「她能撤回自己发的消息」这个开关是关的，我不撤。' }
      } else {
        if (!ownerTurn) return { ok: false, message: '这条不是我发的，只有主人开口我才能撤别人的消息。' }
        if (s.allowOwnerRecallOthers !== true) return { ok: false, message: '「主人可以让她撤回别人的消息」这个开关是关的。' }
      }

      try {
        await api.onebot('delete_msg', { message_id: asId(mid) })
        log('撤回守卫：撤回成功', mid, note || '')
        return { ok: true, message: '撤回了' + (note ? `（${note}）` : '') + '。' }
      } catch (e) {
        return { ok: false, message: `撤回失败：${e.message}（QQ 只允许撤回两分钟内的消息，群里撤别人的还要我是管理员）` }
      }
    }

    // 给她加一个工具：她嘴快了、发错了，自己收回来
    api.tool(({ chat, sessionId }) => {
      if (!chat || chat.kind === 'system') return []
      return api.defineTool({
        name: 'recall_msg',
        description:
          '撤回一条已经发出去的消息，也可以用来收回你自己说错的话。' +
          '自己说错了、发现答错人、发错了内容，或者主人说“撤回”“收回去”“刚刚那条不对”时用。' +
          '优先撤主人引用的那条：不传 message_id 就用当前这条消息引用的那条；撤你自己的要快，QQ 只允许两分钟内撤回。',
        properties: {
          message_id: { type: 'string', description: '要撤回的消息 ID。不填就撤主人这条消息引用的那条。' },
          note: { type: 'string', description: '撤回原因，一句话，方便我自己记着为什么撤。' },
        },
        required: [],
        execute: async (args = {}) => {
          const cur = lastInbound.get(chat.chatId) || {}
          const id = args.message_id || cur.replyId
          if (!id) {
            return { ok: false, message: '不知道撤哪条：让主人引用那条消息再说一次，或者直接把消息 ID 给我。' }
          }
          return doRecall({ id, chat, sessionId, note: args.note })
        },
      })
    })

    // ---------- 错字同音理解：对方打错字时，按发音猜他本来想打什么 ----------
    // 拼音库用模块自带的 lib/pinyin（市场包里没有 node_modules 也能用），载不到就只是这个小组件不干活
    let pinyinFn = null
    const loadPinyin = async () => {
      const specs = []
      try { specs.push(new URL('./lib/pinyin/index.mjs', import.meta.url).href) } catch {}
      specs.push('pinyin-pro')
      for (const spec of specs) {
        try {
          const m = await import(spec)
          const fn = m?.pinyin || m?.default?.pinyin || null
          if (typeof fn === 'function') { pinyinFn = fn; return }
        } catch {}
      }
      log('撤回守卫：拼音库不可用，同音提示不工作（撤回功能不受影响）')
    }
    loadPinyin()

    // 词库：jieba dict.txt 里 2~3 字词（词频 >= 30），外加「拼音 → 常见词」索引（词频 >= 500）
    let lex = null
    const lexicon = () => {
      if (lex) return lex
      try {
        lex = JSON.parse(readFileSync(join(api.dir, 'lib/homophone-data.json'), 'utf8'))
        log('撤回守卫：同音词库已载入，' + Object.keys(lex.freq || {}).length + ' 个词')
      } catch (e) {
        log('撤回守卫：同音词库读取失败', e.message)
        lex = { legit: 30, cand: 500, freq: {}, index: {} }
      }
      return lex
    }
    const HAN_WORD = /^[\u3400-\u9fff]+$/
    const py = (t) => {
      if (!pinyinFn) return ''
      try { return String(pinyinFn(t, { toneType: 'none', type: 'array' }).join('') || '') } catch { return '' }
    }
    const oneCharDiff = (a, b) => {
      if (a.length !== b.length) return false
      let d = 0
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
      return d === 1
    }
    // 虚词开头的两字组合几乎都不是错字（"不方""这电""看这"这类），直接跳过，压掉误报
    const STOP_FIRST = new Set('不别没太很更最又也都还就才只再却倒真挺蛮特好这那哪每某各另'.split(''))
    // 原文那串不成词、换成同音字才成词 → 判为疑似错字
    const typos = (text, maxCand) => {
      if (!pinyinFn) return []
      const d = lexicon()
      const out = []
      const used = new Set()
      for (let i = 0; i < text.length; i++) {
        if (used.has(i)) continue
        for (const len of [3, 2]) {
          const w = text.slice(i, i + len)
          if (w.length !== len || !HAN_WORD.test(w)) continue
          if ((d.freq[w] || 0) >= (d.legit || 30)) continue
          if (STOP_FIRST.has(w[0])) continue
          if (i > 0) {
            const prev = text[i - 1] + text[i]
            if (HAN_WORD.test(prev) && (d.freq[prev] || 0) >= (d.legit || 30)) continue
          }
          const p = py(w)
          if (!p || p.length > 12) continue
          const cands = (d.index[p] || []).filter((c) => c !== w && oneCharDiff(w, c) && (d.freq[c] || 0) >= (d.cand || 500))
          if (!cands.length) continue
          out.push({ raw: w, pinyin: p, candidates: cands.slice(0, maxCand) })
          for (let k = 0; k < len; k++) used.add(i + k)
          break
        }
        if (out.length >= 3) break
      }
      return out
    }
    const buildNote = (s, text) => {
      const maxCand = Math.min(5, Math.max(1, Number(s.homophoneMax) || 3))
      const src = String(text || '').trim()
      const hits = src.length <= 120 ? typos(src, maxCand) : []
      if (hits.length) {
        const body = hits.map((h) => `「${h.raw}」大概是「${h.candidates.join('/')}」`).join('；')
        return { typos: hits, note: `[同音提示] 对方多半打错字了：${body}（同音字）。按前面那个词理解，别照着错字硬读；拿不准就问一句。` }
      }
      if (s.homophoneMode === 'always') {
        return { typos: [], note: '[同音提示] 对方可能打错字。读不通的地方按同音字猜本意，别照字面硬读。' }
      }
      return { typos: [], note: '' }
    }
    const homophoneSettings = () => ({ homophoneOn: true, homophoneMode: 'suspicious', homophoneMax: 3, ...settings() })

    // 统计（面板用）
    const statsFile = () => join(api.dataDir(), 'homophone-stats.json')
    const readStats = () => {
      try { return { hits: 0, since: Date.now(), last: [], ...JSON.parse(readFileSync(statsFile(), 'utf8')) } } catch { return { hits: 0, since: Date.now(), last: [] } }
    }
    const writeStats = (o) => {
      try { mkdirSync(api.dataDir(), { recursive: true }); writeFileSync(statsFile(), JSON.stringify(o, null, 2)) } catch (e) { log('撤回守卫：写统计失败', e.message) }
    }

    // 交给她的内容里补一句同音提示（只对真人聊天生效，系统回合不掺）
    api.on('prompt', (content, info = {}) => {
      try {
        const s = homophoneSettings()
        if (s.homophoneOn === false) return undefined
        const kind = info.chat?.kind
        if (kind !== 'private' && kind !== 'group') return undefined
        const text = String(info.queryText || '').trim()
        if (!text || text.length > 200) return undefined
        const r = buildNote(s, text)
        if (!r.note) return undefined
        const arr = Array.isArray(content) ? content.slice() : []
        arr.push({ type: 'text', text: r.note })
        const st = readStats()
        st.hits = Number(st.hits || 0) + 1
        st.last = [{ at: Date.now(), text: text.slice(0, 40), note: r.note.slice(0, 120) }, ...(st.last || [])].slice(0, 10)
        writeStats(st)
        return arr
      } catch (e) { log('撤回守卫：同音提示出错', e.message); return undefined }
    })

    // 面板用的测试接口：只从查询串取参数，不碰插件内部对象
    api.route('/try', async (req) => {
      let text = ''
      try {
        const u = new URL(String(req?.url || '/'), 'http://127.0.0.1')
        text = String(u.searchParams.get('text') || '')
      } catch (e) { log('撤回守卫：读测试参数失败', e.message) }
      const s = homophoneSettings()
      if (s.homophoneOn === false) return { ok: true, on: false, mode: s.homophoneMode, pinyinReady: Boolean(pinyinFn), typos: [], note: '' }
      const r = buildNote(s, text)
      return { ok: true, on: s.homophoneOn !== false, mode: s.homophoneMode, pinyinReady: Boolean(pinyinFn), typos: r.typos, note: r.note }
    })
    api.route('/stats', async () => ({ ok: true, ...readStats() }))

    // 让她知道有这个本事
    api.rule(() => [
      '你会撤回消息：说错话、发错内容、答错人，或者主人让你收回，就用 recall_msg。撤自己随时可以；撤别人的要主人开口，群里还得你是管理员。超过两分钟的消息撤不动。',
      '对方可能打错字（同音别字）。读起来不通顺时，先按发音猜他想说的词，别照着错字硬读；拿不准就直接问他是不是想说某个词。',
    ])

    // 主人手动兜底：/撤回 消息ID（也可以直接引用那条消息发 /撤回）
    api.command({
      name: '撤回',
      aliases: ['recall'],
      desc: '撤回一条消息：引用它再发 /撤回，或者 /撤回 消息ID',
      run: async (arg, msg) => {
        const id = String(arg || '').trim() || (msg?.replyId ? String(msg.replyId) : '')
        const chat = msg ? { chatId: msg.chatId, kind: msg.kind, groupId: msg.groupId, userId: msg.userId } : null
        const r = await doRecall({ id, chat, sessionId: msg?.sessionId, note: '主人手动撤回' })
        return r.message
      },
    })
  },
}
