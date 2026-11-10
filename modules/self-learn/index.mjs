// 自主学习 —— 没人叫它，它自己去找「真人怎么说话」的样本，自己筛、自己收
//
// 主人 2026-11-10 的要求：「你要能够自主学习」
//
// 之前那套（anti-bot）只会「别人喂 / 我手动调」—— 这是被动的。
// 这个模块让它自己跑起来：
//   1) 定时（默认每 2 小时）自己去 B 站热门 / 话题视频下面抓评论
//   2) 用 anti-bot 的判定把评论分成「人机反例」和「真人金句」两堆
//   3) 自己收进 anti-bot 的库（复用它的 remember / rememberGood）
//   4) 顺便读自己的聊天流水，把「主人说话的样子」也学下来（这是最贴的样本）
//   5) 每天写一份「今天学了什么」的小结，塞进记忆，看得见进展
//
// 只在白名单时段跑、有每日额度、失败退避，不刷屏不打扰。

import fs from 'node:fs'
import path from 'node:path'

const BILI = {
  popular: 'https://api.bilibili.com/x/web-interface/popular?ps=12&pn=1',
  comments: (aid) => `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3&plat=1&web_location=1315875`,
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: 'https://www.bilibili.com/',
}

export default {
  id: 'self-learn',
  name: '自主学习',
  version: '1.0.0',
  api: 1,
  description: '自己定时去 B 站找真人评论样本，筛出人机反例和真人金句收进库；也学主人说话的样子',
  defaults: {
    enabled: true,
    learnBili: true,         // 自己去 B 站抓评论
    learnOwner: true,        // 从聊天流水里学主人怎么说话
    intervalHours: 2,        // 多久跑一轮
    maxRunsPerDay: 6,        // 一天最多几轮
    videosPerRun: 3,         // 一轮看几个视频
    commentsPerVideo: 20,    // 每个视频取多少条评论
    awakeFrom: 8,            // 活跃时段
    awakeTo: 24,
    quietAfterErrors: 3,     // 连续失败几次就歇一会儿
    dailyReport: true,       // 每天写一份「今天学了什么」
    reportAt: 23,            // 几点写小结
    ownerMaxChars: 8000,     // 读聊天流水最多读多少字
    onlyGroupComments: true, // 只学群里别人说的话（不含自己的）
  },
  settings: [
    { key: 'enabled', label: '打开', type: 'switch', hint: '关掉就完全不自己动' },
    { key: 'learnBili', label: '自己去 B 站找评论学', type: 'switch' },
    { key: 'learnOwner', label: '学主人说话的样子', type: 'switch', hint: '从自己的聊天流水里读你说的句子' },
    { key: 'intervalHours', label: '隔多久跑一轮（小时）', type: 'number', min: 0.5, max: 24, step: 0.5 },
    { key: 'maxRunsPerDay', label: '一天最多跑几轮', type: 'number', min: 1, max: 24, step: 1 },
    { key: 'videosPerRun', label: '一轮看几个视频', type: 'number', min: 1, max: 8, step: 1 },
    { key: 'commentsPerVideo', label: '每个视频取多少条评论', type: 'number', min: 5, max: 50, step: 5 },
    { key: 'awakeFrom', label: '从几点开始跑', type: 'number', min: 0, max: 23, step: 1 },
    { key: 'awakeTo', label: '到几点结束', type: 'number', min: 1, max: 24, step: 1 },
    { key: 'dailyReport', label: '每天写一份学了什么', type: 'switch' },
    { key: 'reportAt', label: '几点写（小时）', type: 'number', min: 0, max: 23, step: 1 },
    { key: 'learnOwner', label: '学主人说话的样子', type: 'switch' },
    { key: 'ownerMaxChars', label: '读聊天流水上限（字）', type: 'number', min: 1000, max: 50000, step: 1000 },
    { key: 'onlyGroupComments', label: '只学群里别人说的话', type: 'switch', hint: '关掉 = 也看私聊（主人的话另算）' },
  ],
  panel: 'panel.js',

  setup(api) {
    const S = () => ({ ...api.defaults, ...api.settings() })
    const log = (m) => { try { api.log.info(m) } catch {} }
    const warn = (m) => { try { api.log.warn(m) } catch {} }

    const dataDir = api.dataDir()
    const stateFile = path.join(dataDir, 'state.json')
    const reportDir = path.join(dataDir, 'reports')
    try { fs.mkdirSync(reportDir, { recursive: true }) } catch {}

    const todayKey = () => new Date().toLocaleDateString('sv-SE')
    function loadState() {
      try {
        const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        if (s?.day === todayKey()) return s
        return { day: todayKey(), runs: 0, bots: 0, goods: 0, ownerLines: 0, errors: 0, lastAt: 0, lastError: '', history: s?.history || [] }
      } catch {
        return { day: todayKey(), runs: 0, bots: 0, goods: 0, ownerLines: 0, errors: 0, lastAt: 0, lastError: '', history: [] }
      }
    }
    function saveState(s) {
      try {
        s.history = (s.history || []).slice(0, 40)
        fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8')
      } catch (e) { warn('存学习状态失败：' + String(e?.message || e)) }
    }

    let busy = false

    // ---------- 找 anti-bot 模块（拿到它的判定和收库函数）----------
    const antiBot = () => {
      const m = api.use('anti-bot')
      return m && typeof m.remember === 'function' ? m : null
    }

    // ---------- B 站：热门 + 评论 ----------
    async function fetchJson(url, timeoutMs = 20000) {
      const r = await fetch(url, {
        headers: { 'User-Agent': BILI.UA, Referer: BILI.referer, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      if (j.code !== 0) throw new Error(`B站返回 ${j.code} ${j.message || ''}`)
      return j.data
    }

    async function pickVideos(n) {
      // 优先跟着「bili 逛过的视频」走 —— 主人要的是「逛的时候顺便找」，
      // 而不是另起一套。bili 模块看视频时会往记忆里写 seen 事件（meta.id = bvid），
      // 从那儿把最近看过的拿回来，比从热门榜随机抓更贴。
      const fromBili = []
      try {
        const mem = api.use('memory')
        const recent = mem?.recentEvents?.(72, 20) || []
        for (const e of recent) {
          const id = String(e?.meta?.id || '')
          const title = String(e?.meta?.title || '')
          if (!/^BV[0-9A-Za-z]{10}$/.test(id)) continue
          if (fromBili.some((x) => x.bvid === id)) continue
          fromBili.push({ bvid: id, aid: 0, title })
        }
      } catch {}

      const out = []
      if (fromBili.length) {
        // bvid 要换成 aid 才能拉评论：查一次视频信息
        for (const v of fromBili.slice(0, n)) {
          try {
            const d = await fetchJson(`https://api.bilibili.com/x/web-interface/wbi/view?bvid=${encodeURIComponent(v.bvid)}`)
            if (d?.aid) out.push({ bvid: d.bvid || v.bvid, aid: d.aid, title: d.title || v.title })
          } catch { /* 查不到就算了，用热门补 */ }
        }
      }

      if (out.length < n) {
        const d = await fetchJson(BILI.popular)
        const list = (d?.list || []).filter((v) => v && v.aid && !out.some((o) => o.bvid === v.bvid))
        const st = loadState()
        const off = (st.runs || 0) * n
        for (let i = 0; i < list.length && out.length < n; i++) {
          out.push(list[(off + i) % list.length])
        }
      }
      return out.slice(0, n)
    }

    async function fetchComments(aid, limit) {
      const d = await fetchJson(BILI.comments(aid))
      const arr = d?.replies || []
      return arr.slice(0, limit).map((r) => String(r?.content?.message || '').replace(/\s*\n+\s*/g, ' ').trim()).filter(Boolean)
    }

    // ---------- 学主人 / 群友怎么说话 ----------
    function readChatlog() {
      const dir = path.join(path.dirname(api.dataDir()), '..', 'chatlog')
      const chatlogDir = path.resolve(api.dataDir(), '..', '..', 'chatlog')
      const cands = [chatlogDir, dir]
      let file = ''
      for (const d of cands) {
        try {
          if (!fs.existsSync(d)) continue
          const today = path.join(d, `${todayKey()}.jsonl`)
          if (fs.existsSync(today)) { file = today; break }
          const files = fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort()
          if (files.length) { file = path.join(d, files[files.length - 1]); break }
        } catch {}
      }
      if (!file) return []
      let raw = ''
      try { raw = fs.readFileSync(file, 'utf8') } catch { return [] }
      const cap = Math.max(1000, Number(S().ownerMaxChars) || 8000)
      if (raw.length > cap * 4) raw = raw.slice(-cap * 4)
      const out = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const j = JSON.parse(line)
          if (j?.who === 'bot') continue
          if (S().onlyGroupComments && !String(j?.chatId || '').startsWith('group:')) continue
          const t = String(j?.text || '').trim()
          if (t) out.push(t)
        } catch {}
      }
      return out
    }

    // ---------- 跑一轮 ----------
    async function runOnce({ reason = '定时' } = {}) {
      const s = S()
      if (!s.enabled) return { ok: false, message: '模块关着' }
      if (busy) return { ok: false, message: '上一轮还在跑' }
      const hour = new Date().getHours()
      const inWin = (() => {
        const from = Number(s.awakeFrom), to = Number(s.awakeTo)
        if (from === to) return true
        return from < to ? (hour >= from && hour < to) : (hour >= from || hour < to)
      })()
      if (!inWin) return { ok: false, message: `不在活跃时段（${s.awakeFrom}–${s.awakeTo}）` }

      const st = loadState()
      if ((st.runs || 0) >= Number(s.maxRunsPerDay)) return { ok: false, message: `今天跑满了（${st.runs}/${s.maxRunsPerDay}）` }
      if (st.lastAt && Date.now() - st.lastAt < Number(s.intervalHours) * 3600_000) {
        return { ok: false, message: `还没到下次（${s.intervalHours} 小时一轮）` }
      }

      busy = true
      const t0 = Date.now()
      let bots = 0, goods = 0, ownerLines = 0
      const detail = []
      try {
        const ab = antiBot()

        // 1) B 站评论
        if (s.learnBili) {
          if (!ab) {
            warn('anti-bot 模块没在跑，这轮只学聊天流水')
          } else {
            let vids = []
            try { vids = await pickVideos(Math.max(1, Number(s.videosPerRun) || 3)) } catch (e) { warn('抓热门失败：' + String(e?.message || e)) }
            for (const v of vids) {
              let comments = []
              try { comments = await fetchComments(v.aid, Math.max(5, Number(s.commentsPerVideo) || 20)) } catch (e) { warn(`抓《${v.title}》评论失败：` + String(e?.message || e)) }
              if (!comments.length) continue
              for (const c of comments) {
                if (ab.remember(c, { source: `B站《${String(v.title || '').slice(0, 30)}》评论` })) bots++
                else if (ab.rememberGood(c, { source: `B站《${String(v.title || '').slice(0, 30)}》评论` })) goods++
              }
              detail.push(`《${String(v.title || '').slice(0, 24)}》${comments.length} 条`)
              await new Promise((r) => setTimeout(r, 800))   // 别连太快
            }
          }
        }

        // 2) 聊天流水（学真人说话的样子）
        // 群友说的话只当课外读物：先过一遍「有没有实质文字」，占位符和碎片直接扔，
        // 免得把 [图片]、[合并转发] 这种也收进金句库
        if (s.learnOwner && ab) {
          const lines = readChatlog()
            .map((t) => String(t || '').trim())
            .filter((t) => {
              if (!t || t.length < 8) return false
              const plain = t.replace(/\[[^\]]{0,30}\]/g, '').replace(/[\u{1F300}-\u{1FAFF}]/gu, '').replace(/[\s\p{P}]/gu, '')
              return plain.length >= 4               // 至少有 4 个字的实在内容
            })
          for (const t of lines) {
            if (ab.rememberGood(t, { source: '聊天里真人说的话' })) ownerLines++
          }
          if (lines.length) detail.push(`聊天流水 ${lines.length} 条（可用）`)
        }

        st.runs = (st.runs || 0) + 1
        st.bots = (st.bots || 0) + bots
        st.goods = (st.goods || 0) + goods
        st.ownerLines = (st.ownerLines || 0) + ownerLines
        st.lastAt = Date.now()
        st.errors = 0
        st.lastError = ''
        st.history = [{ at: Date.now(), reason, bots, goods, ownerLines, ms: Date.now() - t0, detail: detail.join('；') }, ...(st.history || [])]
        saveState(st)

        log(`自主学习一轮（${reason}）：人机反例 ${bots}，金句 ${goods}，聊天流水 ${ownerLines}｜${detail.join('；')}`)
        return { ok: true, message: `学了：反例 ${bots}，金句 ${goods}，真人发言 ${ownerLines}`, bots, goods, ownerLines }
      } catch (e) {
        st.errors = (st.errors || 0) + 1
        st.lastError = String(e?.message || e)
        saveState(st)
        warn('自主学习出错：' + st.lastError)
        return { ok: false, message: st.lastError }
      } finally {
        busy = false
      }
    }

    // ---------- 每天小结 ----------
    function writeReport() {
      const st = loadState()
      const text = [
        `# ${todayKey()} 学到的东西`,
        '',
        `跑了 ${st.runs} 轮（上限 ${S().maxRunsPerDay}）`,
        `收进人机反例：${st.bots} 条`,
        `收进真人金句：${st.goods} 条`,
        `从聊天流水里学到的真人发言：${st.ownerLines} 条`,
        st.lastError ? `最近一次出错：${st.lastError}` : '',
        '',
        '## 这一天的每一轮',
        ...(st.history || []).slice(0, 12).map((h) => `- ${new Date(h.at).toLocaleTimeString('zh-CN')} ${h.reason}｜反例 ${h.bots}｜金句 ${h.goods}｜真人 ${h.ownerLines}${h.detail ? '｜' + h.detail : ''}`),
      ].filter((x) => x !== '').join('\n')
      const file = path.join(reportDir, `${todayKey()}.md`)
      try { fs.writeFileSync(file, text, 'utf8') } catch (e) { warn('写小结失败：' + String(e?.message || e)) }
      log(`今天的学习小结写到 ${file}`)
      return text
    }

    // ---------- 定时 ----------
    api.every(15 * 60_000, () => {
      const s = S()
      if (!s.enabled) return
      const st = loadState()
      if ((st.errors || 0) >= Number(s.quietAfterErrors)) return   // 连续出错就歇着，等下一轮自然重试
      const hour = new Date().getHours()
      if (hour === Number(s.reportAt) && !st.reportedDay) {
        const text = writeReport()
        st.reportedDay = todayKey()
        saveState(st)
        // 小结塞进记忆，以后能翻到「自己学过什么」
        try {
          const mem = api.use('memory')
          mem?.addEvent?.({ text: `今天自学了：${text.split('\n').slice(2, 5).join('；')}`, tags: ['自学'], importance: 0.4 })
        } catch {}
        return
      }
      runOnce({ reason: '定时' }).catch(() => {})
    }, '自主学习')

    // 启动 3 分钟后先试一轮（别一加载就冲）
    api.later(3 * 60_000, () => { runOnce({ reason: '启动后' }).catch(() => {}) })

    // ---------- 给主人的命令 ----------
    api.command({
      name: '学',
      aliases: ['自学', 'learn'],
      desc: '/学 —— 立刻自学一轮；/学 状态 —— 看今天学了多少',
      run: (arg, msg) => {
        const a = String(arg || '').trim()
        if (a === '状态' || a === 'status') {
          const st = loadState()
          return `今天跑了 ${st.runs}/${S().maxRunsPerDay} 轮｜反例 ${st.bots}｜金句 ${st.goods}｜真人发言 ${st.ownerLines}${st.lastError ? '｜最近出错：' + st.lastError : ''}`
        }
        runOnce({ reason: '主人让学' }).then((r) => {
          if (msg?.chatId) api.sendText(msg.chatId, r.message || (r.ok ? '学完了' : '没学成'))
        }).catch(() => {})
        return '好，我去学一会儿'
      },
    })

    // ---------- 工具 ----------
    api.tool(({ chat }) => {
      if (chat?.kind === 'system') return []
      return api.defineTool({
        name: 'self_learn_now',
        description: '立刻自学一轮：去 B 站抓真人评论样本、顺便从聊天流水里学真人怎么说话，收进库。',
        properties: {},
        required: [],
        execute: async () => {
          const r = await runOnce({ reason: '她自己去学' })
          return { ok: !!r.ok, message: r.message || '' }
        },
      })
    })

    // ---------- 面板 ----------
    api.route('/state', async () => {
      const s = S()
      const st = loadState()
      return {
        ok: true,
        enabled: !!s.enabled,
        learnBili: !!s.learnBili,
        learnOwner: !!s.learnOwner,
        intervalHours: Number(s.intervalHours),
        maxRunsPerDay: Number(s.maxRunsPerDay),
        busy,
        today: { runs: st.runs, bots: st.bots, goods: st.goods, ownerLines: st.ownerLines, errors: st.errors, lastError: st.lastError, lastAt: st.lastAt },
        nextInMinutes: st.lastAt ? Math.max(0, Math.round((Number(s.intervalHours) * 3600_000 - (Date.now() - st.lastAt)) / 60000)) : 0,
        history: (st.history || []).slice(0, 10).map((h) => ({ at: h.at, reason: h.reason, bots: h.bots, goods: h.goods, ownerLines: h.ownerLines, detail: h.detail })),
        reports: (() => { try { return fs.readdirSync(reportDir).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, 10) } catch { return [] } })(),
      }
    })

    api.route('/now', async () => {
      // 手动点是「我就要现在跑」，绕过间隔限制（每日额度仍然算）
      const st = loadState()
      const before = st.lastAt
      st.lastAt = 0
      saveState(st)
      const r = await runOnce({ reason: '面板点的' })
      if (!r.ok) {
        const st2 = loadState()
        st2.lastAt = before
        saveState(st2)
      }
      return { ok: !!r.ok, message: r.message || '' }
    })

    api.route('/report', async (req, res) => {
      const q = api.core.http.query(req) || {}
      const day = q.day ? String(q.day) : todayKey()
      const file = path.join(reportDir, `${day}.md`)
      if (!fs.existsSync(file)) return api.core.http.send(res, 404, '这天还没写小结', 'text/plain; charset=utf-8')
      return api.core.http.send(res, 200, fs.readFileSync(file), 'text/markdown; charset=utf-8')
    })

    api.route('/make-report', async () => {
      const text = writeReport()
      return { ok: true, text }
    })

    log(`自主学习就位：${S().learnBili ? 'B站' : ''}${S().learnBili && S().learnOwner ? '+' : ''}${S().learnOwner ? '聊天流水' : ''}｜${S().intervalHours} 小时一轮，一天最多 ${S().maxRunsPerDay} 轮`)
    return { runOnce, writeReport, state: () => loadState() }
  },
}
