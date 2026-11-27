/**
 * daily-session —— 每日会话拆分
 *
 * 作用：每个聊天按本机自然日开新会话，避免上下文越攒越长、token 越烧越多。
 * 重置前按聊天读宿主的聊天流水，提炼前一天对话；提炼结果只在新会话首轮注入一次。
 *
 * 契约：扩展接口 v1（api: 1）；capabilities: filesystem（写 dataDir/state.json）
 * + plugin-internals（hub.sessions / hub.chatLogOf / hub.resetChat）。
 * 数据：只从本机聊天流水读，只写本机 state.json；提炼走本地模型 api.ask；不联网、不发外部地址。
 * 安全：重置是写操作。默认首次运行只登记不重置；主人命令只作用于当前聊天；subagent 委派完全不用。
 */

import { join } from 'node:path'
import { nextResetAt, periodOf, prevDayKey } from './lib/schedule.mjs'
import { chatRecord, loadState, rememberInjection, saveState } from './lib/state.mjs'
import { cleanDigest, digestRequest, fallbackDigest, pickLogRows } from './lib/digest.mjs'

const TICK_MS = 60_000
const CHAT_ID_RE = /^(private|group):/

export const SETTINGS = [
  { key: 'enabled', label: '开启每日拆分', type: 'switch', hint: '关掉后不再自动开新会话，也不再注入摘要。' },
  { key: 'resetHour', label: '每天几点后重置', type: 'number', min: 0, max: 23, step: 1, hint: '本机时间。0 = 过零点；3 = 凌晨 3 点后算新的一天。' },
  {
    key: 'scope', label: '作用范围', type: 'select',
    hint: '只对选中的聊天开新会话。',
    options: [
      { value: 'all', label: '所有聊天' },
      { value: 'group', label: '仅群聊' },
      { value: 'private', label: '仅私聊' },
    ],
  },
  { key: 'injectDigest', label: '注入昨日摘要', type: 'switch', hint: '重置前提炼前一天对话，只在新会话首轮注入一次。' },
  { key: 'maxMessages', label: '提炼最多读几条', type: 'number', min: 10, max: 500, step: 10, hint: '从昨天最后一条往前数，默认 120。' },
  { key: 'maxChars', label: '提炼最多读多少字', type: 'number', min: 200, max: 40000, step: 200, hint: '控制提炼成本，默认 8000。' },
  { key: 'digestMaxChars', label: '摘要字数上限', type: 'number', min: 60, max: 2000, step: 20, hint: '越短越省 token，默认 600。' },
  { key: 'askMaxTokens', label: '提炼输出 tokens', type: 'number', min: 60, max: 1000, step: 20, hint: '本地模型最大输出，默认 220。' },
  { key: 'dryRun', label: '试运行', type: 'switch', hint: '只记日志和生成摘要，不真的重置会话。' },
]

function scopeMatch(chatId, scope) {
  const s = String(scope || 'all')
  if (s === 'group') return String(chatId).startsWith('group:')
  if (s === 'private') return String(chatId).startsWith('private:')
  return true
}

export default {
  id: 'daily-session',
  name: '每日会话拆分',
  version: '1.0.0',
  api: 1,
  description: '每天自动开新会话，按聊天提炼前一天对话，只在新会话首轮注入摘要，降低上下文和 token 压力',
  defaults: {
    enabled: true,
    resetHour: 0,
    scope: 'all',
    injectDigest: true,
    maxMessages: 120,
    maxChars: 8000,
    digestMaxChars: 600,
    askMaxTokens: 220,
    dryRun: false,
  },
  settings: SETTINGS,
  panel: 'panel.js',

  setup(api) {
    const dataDir = api.dataDir()
    const statePath = join(dataDir, 'state.json')
    const state = loadState(statePath, api.log)
    const hub = api.core?.hub || {}
    const settings = () => api.settings?.() || {}
    let busy = false

    const logInfo = (...args) => api.log?.info?.(...args)
    const logWarn = (...args) => api.log?.warn?.(...args)
    const logError = (...args) => api.log?.error?.(...args)

    /** 当前有会话的聊天 + 本模块记录过的聊天；system: 会话不碰。 */
    const activeChats = () => {
      const ids = new Set()
      try {
        const sessions = typeof hub.sessions === 'function' ? hub.sessions() : {}
        for (const id of Object.keys(sessions || {})) ids.add(id)
      } catch (error) {
        logWarn('每日会话拆分：读会话清单失败：', error?.message || error)
      }
      for (const id of Object.keys(state.chats || {})) ids.add(id)
      return [...ids].filter((id) => CHAT_ID_RE.test(id))
    }

    /** 提炼某聊天某一天的流水。失败有原文摘录回落，不让功能静默失效。 */
    const makeDigest = async (chatId, day, s) => {
      if (!s.injectDigest || !day) return null
      let rows = []
      try {
        rows = typeof hub.chatLogOf === 'function' ? hub.chatLogOf(day) : []
      } catch (error) {
        logWarn(`每日会话拆分：读 ${day} 聊天流水失败：`, error?.message || error)
        return null
      }
      const lines = pickLogRows(rows, chatId, { maxMessages: s.maxMessages, maxChars: s.maxChars })
      if (!lines.length) return null

      const limit = Number(s.digestMaxChars) || 600
      let text = ''
      try {
        const req = digestRequest(day, lines)
        text = cleanDigest(
          await api.ask({ system: req.system, text: req.text, maxTokens: Number(s.askMaxTokens) || 220 }),
          limit,
        )
      } catch (error) {
        logWarn('每日会话拆分：模型提炼失败，改用原文摘录：', error?.message || error)
      }
      if (!text) text = fallbackDigest(lines, limit)
      return text ? { day, text, at: Date.now() } : null
    }

    /** 重置一个聊天：先备摘要，再开新会话，最后记账。 */
    const resetOne = async (chatId, period, s) => {
      const rec = chatRecord(state, chatId)
      const yesterday = prevDayKey(period)

      if (!s.injectDigest) {
        rec.digest = null
      } else if (rec.digest?.day === yesterday && rec.digest?.text) {
        // 同一天的摘要已经生成过（例如面板手动检查），直接复用，不重复烧模型
      } else {
        rec.digest = await makeDigest(chatId, yesterday, s)
      }

      let reset = false
      if (!s.dryRun) {
        try {
          reset = typeof hub.resetChat === 'function' ? Boolean(hub.resetChat(chatId)) : false
        } catch (error) {
          logError(`每日会话拆分：重置 ${chatId} 失败：`, error?.message || error)
        }
      }

      rec.lastPeriod = period
      rec.lastResetAt = Date.now()
      rec.injected = {} // 等新会话真的出现再注入
      state.chats[chatId] = rec
      saveState(statePath, state, api.log)
      logInfo(
        `每日会话拆分：${s.dryRun ? '[试运行] ' : ''}${reset ? '已重置' : '登记'} ${chatId}，周期 ${period}` +
        (rec.digest ? `，备好 ${rec.digest.day} 摘要 ${rec.digest.text.length} 字` : '，昨日无可提炼内容'),
      )
      return { chatId, period, reset, digest: rec.digest }
    }

    /** 每分钟检查；到期的聊天才重置。首次见到的聊天只登记，不打断当前会话。 */
    const tick = async () => {
      const s = settings()
      if (!s.enabled) return { enabled: false, checked: 0, reset: 0, digests: 0 }
      const period = periodOf(new Date(), s.resetHour)
      if (!period) return { enabled: true, checked: 0, reset: 0, digests: 0 }

      const results = []
      for (const chatId of activeChats()) {
        if (!scopeMatch(chatId, s.scope)) continue
        const rec = chatRecord(state, chatId)
        if (!rec.lastPeriod) {
          rec.lastPeriod = period
          state.chats[chatId] = rec
          saveState(statePath, state, api.log)
          continue
        }
        if (rec.lastPeriod >= period) continue
        try {
          results.push(await resetOne(chatId, period, s))
        } catch (error) {
          logError(`每日会话拆分：处理 ${chatId} 失败：`, error?.message || error)
        }
      }
      return {
        enabled: true,
        checked: results.length,
        reset: results.filter((r) => r.reset).length,
        digests: results.filter((r) => r.digest).length,
      }
    }

    // 启动后先登记一次（不重置），之后每分钟检查
    api.later?.(3000, () => tick().catch((error) => logError('每日会话拆分：启动检查失败：', error?.message || error)))
    api.every?.(TICK_MS, () => {
      if (busy) return Promise.resolve()
      busy = true
      return Promise.resolve(tick())
        .catch((error) => logError('每日会话拆分：定时检查失败：', error?.message || error))
        .finally(() => { busy = false })
    }, '每日会话拆分-每日检查')

    /** 只在摘要对应的新会话首轮注入；同一会话不再重复塞，避免每轮吃 token。 */
    api.context?.(({ chat, sessionId }) => {
      const s = settings()
      if (!s.enabled || !s.injectDigest) return ''
      const chatId = String(chat?.chatId || '')
      if (!CHAT_ID_RE.test(chatId)) return ''
      const rec = state.chats[chatId]
      const digest = rec?.digest
      if (!digest?.text || !sessionId) return ''
      if (rec.injected?.[sessionId] === digest.day) return ''
      try {
        const sessions = typeof hub.sessions === 'function' ? hub.sessions() : {}
        const current = sessions?.[chatId]?.sessionId
        if (current && String(current) !== String(sessionId)) return ''
      } catch (error) {
        logWarn('每日会话拆分：核对当前会话失败：', error?.message || error)
      }
      rememberInjection(rec, sessionId, digest.day)
      saveState(statePath, state, api.log)
      logInfo(`每日会话拆分：向 ${chatId} 的新会话注入 ${digest.day} 摘要（${digest.text.length} 字）`)
      return `【昨日会话摘要 · ${digest.day}】\n${digest.text}\n（上一段会话的提炼，用来延续话题；不是当前用户刚说的话。）`
    })

    /** 主人命令：只认主人（宿主保证），且只作用于发命令的那个聊天。 */
    api.command?.({
      name: '会话拆分',
      aliases: ['每日会话'],
      desc: '每日会话拆分：/会话拆分 [状态|现在|摘要|帮助]',
      run: async (arg, msg) => {
        const s = settings()
        const a = String(arg || '').trim()
        const chatId = String(msg?.chatId || '')
        const rec = state.chats[chatId]

        if (a === '帮助' || a === 'help') {
          return '用法：/会话拆分 [状态|现在|摘要|帮助]\n现在 = 立刻给当前聊天开新会话并准备昨日摘要'
        }
        if (a === '现在' || a === '重置') {
          if (!api.isOwner?.(msg?.userId)) return '只有主人能重置会话。'
          if (!CHAT_ID_RE.test(chatId)) return '找不到当前聊天。'
          const period = periodOf(new Date(), s.resetHour)
          const r = await resetOne(chatId, period, s)
          return `已${s.dryRun ? '试运行' : '重置'}当前会话（周期 ${period}）${r.digest ? `，准备注入 ${r.digest.day} 的摘要` : '，昨日没有可提炼内容'}。`
        }
        if (a === '摘要') {
          return rec?.digest?.text ? `【${rec.digest.day} 摘要】\n${rec.digest.text}` : '当前聊天没有已生成的昨日摘要。'
        }
        return [
          `每日会话拆分：${s.enabled ? '开启' : '关闭'}；摘要注入${s.injectDigest ? '开启' : '关闭'}${s.dryRun ? '；试运行中' : ''}`,
          `重置时间：每天 ${Number(s.resetHour) || 0}:00 后首次检查；当前周期 ${periodOf(new Date(), s.resetHour)}`,
          `本聊天上次重置：${rec?.lastPeriod || '尚未记录（首次运行不打断现有会话）'}`,
          `昨日摘要：${rec?.digest ? `${rec.digest.day}（${rec.digest.text.length} 字）` : '无'}`,
          '用法：/会话拆分 [状态|现在|摘要|帮助]',
        ].join('\n')
      },
    })

    // 面板接口：只返回本机状态，不接收外部内容
    api.route?.('/status', async () => {
      const s = settings()
      return {
        ok: true,
        enabled: Boolean(s.enabled),
        injectDigest: Boolean(s.injectDigest),
        dryRun: Boolean(s.dryRun),
        resetHour: Number(s.resetHour) || 0,
        period: periodOf(new Date(), s.resetHour),
        nextResetAt: nextResetAt(new Date(), s.resetHour),
        chats: Object.entries(state.chats || {}).map(([id, rec]) => ({
          chatId: id,
          lastPeriod: rec?.lastPeriod || '',
          lastResetAt: rec?.lastResetAt || 0,
          digestDay: rec?.digest?.day || '',
          digestChars: rec?.digest?.text?.length || 0,
        })).sort((a, b) => a.chatId.localeCompare(b.chatId)),
      }
    })
    api.route?.('/run-now', async () => ({ ok: true, ...(await tick()) }))
    /** 面板手动按钮：无视是否到期，强制拆分作用范围内所有聊天。 */
    api.route?.('/split-now', async () => {
      const s = settings()
      const period = periodOf(new Date(), s.resetHour)
      if (!period) return { ok: false, message: '周期计算失败' }
      const results = []
      for (const chatId of activeChats()) {
        if (!scopeMatch(chatId, s.scope)) continue
        try {
          results.push(await resetOne(chatId, period, s))
        } catch (error) {
          logError(`每日会话拆分：手动拆分 ${chatId} 失败：`, error?.message || error)
        }
      }
      return {
        ok: true,
        split: results.length,
        digests: results.filter((r) => r.digest).length,
        dryRun: Boolean(s.dryRun),
        chats: results.map((r) => ({ chatId: r.chatId, reset: r.reset, digestDay: r.digest?.day || '' })),
      }
    })
    api.route?.('/clear-digest', async () => {
      let cleared = 0
      for (const rec of Object.values(state.chats || {})) {
        if (rec?.digest) { rec.digest = null; rec.injected = {}; cleared++ }
      }
      saveState(statePath, state, api.log)
      return { ok: true, cleared }
    })

    return {
      status: () => ({ period: periodOf(new Date(), settings().resetHour), chats: state.chats }),
      runNow: () => tick(),
      resetChat: (chatId) => resetOne(chatId, periodOf(new Date(), settings().resetHour), settings()),
    }
  },
}
