// 双重人格：让她的「人格卡」按时辰、按月、按心情、按概率换着来。
//
// 两种落地方式：
//  - 全局换卡：真的把 cfg.persona.current 换掉（面板「人格卡」页也会跟着变），下一轮生效；
//  - 本会话份：只在某个聊天里用 api.context 注入一段「本会话人格」，不碰全局。
//
// 定时 / 每月 / 心情 → 全局换卡；随机·固定 可全局也可只在本会话；随机·临时 只在本会话、且只这一轮。

import { planSummary, normalizePlan } from './lib/plan.mjs'
import { atToMinutes, dayKey, dueSlots, matchBand, monthlyFor, nowMinutes, rollOnce } from './lib/schedule.mjs'
import { parseSplitIds, splitMapOf } from './lib/split.mjs'
import { loadState, pushHistory, saveState } from './lib/store.mjs'

const BODY_LIMIT = 4000
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const CHAT_ID_RE = /^(private|group):\d{3,}$/

const trimBody = (text) => {
  const s = String(text || '').trim()
  return s.length > BODY_LIMIT ? s.slice(0, BODY_LIMIT) + '…' : s
}

export default {
  id: 'dual-persona',
  name: '双重人格',
  version: '1.4.1',
  api: 1,
  panel: 'panel.js',
  description: '老实聊天，很枯燥吧。支持定时切换人格、随机切换人格……',
  category: 'social',
  tags: ['人格', '人设', '定时', '随机', '心情'],
  defaults: { enabled: true, pollSec: 60 },
  settings: [
    { key: 'enabled', label: '启用双重人格', type: 'switch', hint: '关掉后所有模式都停，已生效的人格卡不会自动还原' },
    { key: 'pollSec', label: '检查间隔（秒）', type: 'number', min: 10, max: 600, step: 10, hint: '后台多久看一次定时/每月/心情。到点没查也没关系，下次检查会补上；改完不用重载' },
  ],

  setup(api) {
    const dir = api.dataDir()
    const state = loadState(dir)
    let dirty = false
    const save = () => { if (dirty) { saveState(dir, state); dirty = false } }
    // 旧版 state.json 里的 timedKey 已经就地换成 timedDone，顺手把文件重写一次
    if (state.legacyTimed) { delete state.legacyTimed; dirty = true; save() }

    const settings = () => api.settings() || {}
    const enabled = () => settings().enabled !== false
    const plan = () => normalizePlan(settings().plan)
    const mode = () => (enabled() ? plan().mode : 'off')
    // 计划存在模块设置里（ext['dual-persona'].plan），和面板其它设置走同一条保存路径；
    // 老版本存在 state.json 里的 plan 在启动时迁一次。
    const setPlan = (raw) => {
      const next = normalizePlan(raw)
      try { api.saveSettings({ plan: next }) } catch (error) { api.log.warn('保存计划失败：', error.message) }
      return next
    }
    if (state.plan !== undefined && settings().plan === undefined) {
      try { api.saveSettings({ plan: normalizePlan(state.plan) }) } catch { /* 忽略：旧数据读不出来就用默认 */ }
    }
    if (state.plan !== undefined) { delete state.plan; dirty = true; save() }

    const personaList = () => {
      try { return api.core.personas.list() || [] } catch { return [] }
    }
    const personaName = (id) => personaList().find((p) => p.id === id)?.name || id || ''
    const personaBody = (id) => {
      try { return trimBody(api.core.personas.read(id)?.body || '') } catch { return '' }
    }
    const currentId = () => {
      const c = api.config()
      return c?.persona?.current || ''
    }

    function record(mode, from, to, scope, note = '') {
      pushHistory(state, { at: Date.now(), mode, from: from || '', to: to || '', scope, note })
      dirty = true
    }

    function applyGlobal(persona, mode, note = '') {
      if (!enabled() || !persona) return false
      const from = currentId()
      if (from === persona) return false
      try {
        api.setConfig({ persona: { current: persona } })
      } catch (error) {
        api.log.warn('换人格卡失败：', error.message)
        return false
      }
      record(mode, from, persona, 'global', note)
      api.log.info(`人格 → ${personaName(persona)}（${mode}）`)
      save()
      return true
    }

    /** 一条规则填的 QQ/群号串 → chatId 列表（认不出/格式不对的丢掉） */
    function scopeIds(rule) {
      if (!rule?.scope) return []
      try {
        return parseSplitIds(rule.scope, knownGroupIds()).chatIds.filter((id) => CHAT_ID_RE.test(id))
      } catch { return [] }
    }

    /** 分裂模式下按范围生效：只把这些聊天的「本会话人格」换成这张卡，不动全局 */
    function applyScoped(persona, mode, note, ids) {
      if (!enabled() || !persona || !ids.length) return false
      let any = false
      for (const chatId of ids) {
        const s = sessionOf(chatId)
        if (s.persona === persona && !s.untilTurn) continue
        s.persona = persona
        s.untilTurn = 0
        s.mode = mode
        any = true
        record(mode, '', persona, 'chat', `${chatId} ${note}`)
      }
      if (any) {
        dirty = true
        save()
        api.log.info(`范围内人格 → ${personaName(persona)}（${mode}，${ids.length} 个会话）`)
      }
      return any
    }

    function moodValue() {
      const p = plan()
      if (p.mood.source === 'manual') return p.mood.manual
      try {
        const m = api.use('mood')?.state?.()
        const v = Number(m?.value ?? m?.mood ?? m)
        if (Number.isFinite(v)) return Math.min(100, Math.max(0, v))
      } catch { /* 心情模块没跑就用兜底 */ }
      const cfg = api.config()
      const base = Number(cfg?.mood?.base)
      return Number.isFinite(base) ? base : p.mood.manual
    }

    function tick() {
      if (!enabled()) return
      const m = mode()
      if (m === 'off') return
      try {
        const p = plan()
        const now = new Date()
        const today = dayKey(now)
        const split = m === 'split'

        // 全局模式：规则换的是全局人格卡；分裂模式：只换范围内那几个会话的本会话人格。
        // 分裂模式下一旦没填范围，这条规则就不生效（面板上会标「未填范围」）。
        const fire = (persona, ruleMode, note, rule) => {
          if (!persona) return
          if (!split) { applyGlobal(persona, ruleMode, note); return }
          applyScoped(persona, ruleMode, note, scopeIds(rule))
        }
        const ready = (rule) => !split || scopeIds(rule).length > 0

        if (p.timed.enabled && p.timed.slots.length) {
          const done = (state.last.timedDone && state.last.timedDone[today]) || []
          const due = dueSlots(p.timed.slots, now, done)
          if (due.length && ready(p.timed)) {
            // 一次补上今天错过的所有档期，按时间顺序执行，最后生效的是最近的那一档
            for (const slot of due) {
              const late = atToMinutes(slot.at) < nowMinutes(now)
              fire(slot.persona, 'timed', late ? `定时 ${slot.at}（补）` : `定时 ${slot.at}`, p.timed)
            }
            state.last.timedDone = { [today]: [...done, ...due.map((s) => s.at)] }
            dirty = true
          }
        }

        if (p.monthly.enabled) {
          const who = monthlyFor(p.monthly.days, now)
          if (who && state.last.monthlyKey !== today && ready(p.monthly)) {
            state.last.monthlyKey = today
            dirty = true
            fire(who, 'monthly', `每月 ${now.getDate()} 号`, p.monthly)
          }
        }

        if (p.mood.enabled && p.mood.bands.length) {
          const v = moodValue()
          const band = matchBand(p.mood.bands, v)
          const bandKey = band ? `${band.persona}|${band.min}-${band.max}` : ''
          if (band && state.last.moodBand !== bandKey && ready(p.mood)) {
            state.last.moodBand = bandKey
            dirty = true
            fire(band.persona, 'mood', `心情 ${Math.round(v)}`, p.mood)
          } else if (!band && state.last.moodBand) {
            state.last.moodBand = ''
            dirty = true
          }
        }

        save()
      } catch (error) {
        api.log.warn('定时检查出错：', error.message)
      }
    }

    // 每 5 秒醒一次，真正隔多久看设置里的 pollSec —— 这样改了间隔不用重载模块
    let lastCheck = 0
    api.every(5000, () => {
      const gap = Math.max(10, Number(settings().pollSec) || 60) * 1000
      if (Date.now() - lastCheck < gap) return
      lastCheck = Date.now()
      tick()
    }, '双重人格·定时检查')
    api.later(1500, tick)

    // ---------- 本会话人格 ----------
    function sessionOf(chatId) {
      if (!state.sessions[chatId]) state.sessions[chatId] = { turn: 0, sessionId: '', persona: '', untilTurn: 0, mode: '', rolled: false }
      return state.sessions[chatId]
    }

    function clearSession(chatId, why = '') {
      const s = state.sessions[chatId]
      if (!s) return
      s.persona = ''
      s.untilTurn = 0
      s.mode = ''
      s.rolled = false
      dirty = true
      if (why) record('reset', '', '', 'chat', `${chatId} ${why}`)
    }

    function rollFor(session, chatId) {
      const p = plan()
      const split = mode() === 'split'
      // 分裂模式下随机规则也要填范围，范围外的聊天不掷
      const inScope = (rule) => !split || parseSplitIds(rule.scope, knownGroupIds()).chatIds.includes(chatId)
      const rf = p.randomFixed
      const rt = p.randomTemp
      if (rf.enabled && rf.pool.length && inScope(rf)) {
        const who = rollOnce(rf.totalPercent, rf.pool)
        if (who) {
          // 分裂模式下全局换卡没有意义，一律只落到这个会话
          const global = rf.target === 'global' && !split
          record('randomFixed', currentId(), who, global ? 'global' : 'chat', chatId)
          if (global) {
            applyGlobal(who, 'randomFixed')
            return
          }
          session.persona = who
          session.untilTurn = 0
          session.mode = 'randomFixed'
          dirty = true
          return
        }
      }
      if (rt.enabled && rt.pool.length && inScope(rt)) {
        const who = rollOnce(rt.totalPercent, rt.pool)
        if (who) {
          session.persona = who
          session.untilTurn = session.turn
          session.mode = 'randomTemp'
          dirty = true
          record('randomTemp', currentId(), who, 'chat', chatId)
        }
      }
    }

    api.context(({ chat, sessionId } = {}) => {
      if (!enabled() || !chat || chat.kind === 'system') return ''
      if (mode() === 'off') return ''
      const chatId = chat.chatId
      if (!chatId) return ''
      const session = sessionOf(chatId)
      session.turn = Number(session.turn || 0) + 1

      if (session.untilTurn && session.turn > session.untilTurn) {
        session.persona = ''
        session.untilTurn = 0
        session.mode = ''
        dirty = true
      }

      if (sessionId && session.sessionId !== sessionId) {
        session.sessionId = sessionId
        // 换了一个会话（重置/归档重开）：随机的重新掷；按范围定下来的定时/每月/心情人格继续留着
        if (session.mode === 'randomFixed' || session.mode === 'randomTemp' || !session.mode) {
          session.persona = ''
          session.untilTurn = 0
          session.mode = ''
        }
        session.rolled = false
        dirty = true
      }

      const p = plan()
      const canRoll = (p.randomFixed.enabled && p.randomFixed.pool.length) || (p.randomTemp.enabled && p.randomTemp.pool.length)
      if (!session.rolled && canRoll) {
        session.rolled = true
        rollFor(session, chatId)
      }

      save()
      // 分裂模式：这个聊天没掷中随机，就用它配的那张（没单独配就跟公共默认，再没有就跟全局卡）
      const base = mode() === 'split' ? (splitMap().get(chatId) || p.split.default || '') : ''
      const who = session.persona || base
      if (!who) return ''
      const body = personaBody(who)
      if (!body) return ''
      const temp = session.mode === 'randomTemp' ? '（这一轮）' : ''
      return [
        `【本会话人格${temp}】接下来这个聊天里，你按下面这张人格卡说话，它优先于前面的人格设定。`,
        '不要说「换人格」「另一个人格」这类话，也不要解释语气为什么变了；就像一直是这样。',
        '',
        body,
      ].join('\n')
    })

    api.rule(() => {
      if (!enabled() || mode() === 'off') return ''
      const p = plan()
      const splitOn = mode() === 'split' && (p.split.default || p.split.rows.length)
      const rollOn = p.randomFixed.enabled || p.randomTemp.enabled
      if (!splitOn && !rollOn) return ''
      return '如果你的上下文里出现「本会话人格」一段，就按那一段的语气和习惯说话，别提起它。'
    })

    // ---------- 面板接口 ----------
    const localReq = (req) => {
      const ip = req?.socket?.remoteAddress || ''
      if (!ip) return true
      return LOOPBACK.has(ip)
    }
    const gated = (fn) => async (req) => (localReq(req) ? fn(req) : { ok: false, message: '这个接口只接受本机访问' })
    // 这几条能读会话清单、改全局人格卡和计划，声明成面板接口让宿主的管理面闸先拦，
    // localReq 只当第二道（和 session-switch / nickname-memory 同一口径）。
    const PANEL = { access: 'panel' }

    /** 已知的群号：白名单 + 她现有的群会话（用来分辨裸号码是群还是私聊） */
    function knownGroupIds() {
      const set = new Set()
      try {
        const cfg = api.config() || {}
        for (const gid of cfg?.allow?.groups || []) set.add(String(gid))
        for (const chatId of Object.keys(api.core.hub?.sessions?.() || {})) {
          if (chatId.startsWith('group:')) set.add(chatId.slice(6))
        }
      } catch { /* 拿不到就只按白名单判断 */ }
      return set
    }

    /** 当前生效的分裂表：chatId → 人格卡 */
    function splitMap() {
      return splitMapOf(plan().split.rows, knownGroupIds()).map
    }

    /** 面板要列出来的会话：她现有的会话 + 白名单 */
    function knownChats() {
      const out = new Map()
      try {
        const sessions = api.core.hub?.sessions?.() || {}
        for (const [chatId, ent] of Object.entries(sessions)) {
          if (!CHAT_ID_RE.test(chatId)) continue
          out.set(chatId, { chatId, kind: chatId.split(':')[0], label: String(ent?.title || '') })
        }
      } catch { /* 拿不到会话列表就只列白名单 */ }
      const cfg = api.config() || {}
      for (const qq of cfg?.allow?.private || []) {
        const chatId = `private:${qq}`
        if (!out.has(chatId)) out.set(chatId, { chatId, kind: 'private', label: '' })
      }
      for (const gid of cfg?.allow?.groups || []) {
        const chatId = `group:${gid}`
        if (!out.has(chatId)) out.set(chatId, { chatId, kind: 'group', label: '' })
      }
      return [...out.values()].map((c) => ({
        ...c,
        label: c.label || (c.kind === 'group' ? `群 ${c.chatId.slice(6)}` : `私聊 ${c.chatId.slice(8)}`),
      }))
    }

    /** 一条规则的号码串解析结果（面板用来显示「→ 会落到哪些聊天」） */
    function previewOf(text) {
      let parsed
      try { parsed = parseSplitIds(text || '', knownGroupIds()) } catch { parsed = { chatIds: [], unknown: [] } }
      const chats = knownChats()
      const byChat = new Map(chats.map((c) => [c.chatId, c]))
      return {
        unknown: parsed.unknown,
        resolved: parsed.chatIds.filter((id) => CHAT_ID_RE.test(id)).map((chatId) => {
          const hit = byChat.get(chatId)
          return { chatId, label: hit?.label || (chatId.startsWith('group:') ? `群 ${chatId.slice(6)}` : `私聊 ${chatId.slice(8)}`) }
        }),
      }
    }

    const view = () => {
      const p = plan()
      const cur = currentId()
      const chats = knownChats()
      const byChat = new Map(chats.map((c) => [c.chatId, c]))
      const split = splitMapOf(p.split.rows, knownGroupIds())
      return {
        ok: true,
        current: { id: cur, name: personaName(cur) },
        modes: planSummary(p).modes,
        plan: p,
        personas: personaList().map((x) => ({ id: x.id, name: x.name, chars: x.chars })),
        chats,
        scopePreview: {
          timed: previewOf(p.timed.scope),
          monthly: previewOf(p.monthly.scope),
          mood: previewOf(p.mood.scope),
          randomFixed: previewOf(p.randomFixed.scope),
          randomTemp: previewOf(p.randomTemp.scope),
        },
        splitPreview: split.detail.map((d) => ({
          ids: d.ids,
          persona: d.persona,
          unknown: d.unknown,
          resolved: d.chatIds.map((chatId) => {
            const hit = byChat.get(chatId)
            return { chatId, label: hit?.label || (chatId.startsWith('group:') ? `群 ${chatId.slice(6)}` : `私聊 ${chatId.slice(8)}`) }
          }),
        })),
        sessions: Object.entries(state.sessions)
          .filter(([, s]) => s.persona)
          .map(([chatId, s]) => ({ chatId, persona: s.persona, name: personaName(s.persona), mode: s.mode })),
        history: state.history.slice(-20).reverse().map((h) => ({ ...h, name: personaName(h.to) })),
      }
    }

    api.route('/state', gated(() => view()), PANEL)
    api.route('/plan', async (req, res) => {
      if (!localReq(req)) return { ok: false, message: '这个接口只接受本机访问' }
      if (req.method === 'GET') return view()
      const body = (await api.core.http.body(req)) || {}
      setPlan(body.plan)
      return { ok: true, message: '计划已保存', ...view() }
    }, PANEL)
    api.route('/apply', async (req) => {
      if (!localReq(req)) return { ok: false, message: '这个接口只接受本机访问' }
      const body = (await api.core.http.body(req)) || {}
      const id = String(body.persona || '')
      if (!id) return { ok: false, message: '没说要换哪张卡' }
      if (!personaList().some((x) => x.id === id)) return { ok: false, message: '人格卡里没有这一张' }
      const ok = applyGlobal(id, 'manual', '面板手动')
      return { ok: true, message: ok ? `换成「${personaName(id)}」了` : `现在就是「${personaName(id)}」`, ...view() }
    }, PANEL)
    api.route('/reset', async (req) => {
      if (!localReq(req)) return { ok: false, message: '这个接口只接受本机访问' }
      const body = (await api.core.http.body(req)) || {}
      if (body.chatId) clearSession(String(body.chatId), '面板重置')
      else for (const id of Object.keys(state.sessions)) clearSession(id, '面板重置')
      save()
      return { ok: true, message: body.chatId ? '这个会话的人格已清掉' : '所有会话的人格都清掉了', ...view() }
    }, PANEL)

    // ---------- 主人命令 ----------
    api.command({
      name: '双重人格',
      aliases: ['人格切换'],
      desc: '看现在的模式；`/双重人格 切 <人格卡 id 或名字>`；`/双重人格 重置`',
      run: async (arg, msg) => {
        const text = String(arg || '').trim()
        if (!text) {
          const p = plan()
          const on = planSummary(p).modes
          const cur = currentId()
          const mine = state.sessions[msg.chatId]?.persona
          const splitMine = mode() === 'split' ? (splitMap().get(msg.chatId) || p.split.default || '') : ''
          const modeText = !enabled() ? '没开（设置里的「启用双重人格」关着）' : p.mode === 'global' ? '全局切换' : '人格分裂'
          return [
            `模式：${modeText}`,
            `现在的人格：${personaName(cur)}`,
            on.length ? `开着的自动规则：${on.join('、')}` : enabled() ? '现在没有开自动规则' : '开关关着，配好的规则都不生效',
            mine ? `这个聊天里临时开着：${personaName(mine)}` : splitMine ? `这个聊天用：${personaName(splitMine)}` : '这个聊天没有单独的人格',
          ].join('\n')
        }
        if (text === '重置') {
          clearSession(msg.chatId, '主人命令')
          save()
          return '这个聊天单独的人格清掉了'
        }
        const m = /^切\s+(.+)$/.exec(text)
        if (m) {
          const want = m[1].trim()
          const hit = personaList().find((p) => p.id === want || p.name === want)
          if (!hit) return `没有这张卡。现在有：${personaList().map((p) => p.name).join('、')}`
          const ok = applyGlobal(hit.id, 'command', '主人命令')
          return ok ? `换成「${hit.name}」了，下一轮生效` : `现在就是「${hit.name}」`
        }
        return '看不懂。可以：`/双重人格`、`/双重人格 切 名字`、`/双重人格 重置`'
      },
    })

    api.onDispose(() => save())

    return {
      state,
      applyGlobal,
      clearSession,
      plan,
      // 给测试用：跳过 api.every 的节流，直接跑一次检查
      tick,
    }
  },
}
