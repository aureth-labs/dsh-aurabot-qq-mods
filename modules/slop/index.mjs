// 扩展模块「去套话」（slop）—— 从 DSH 那侧的 dsh-pet-slop 搬过来的。
// 放在 Aurabot 数据目录 modules/slop/ 里，插件升级不会动它；保存就生效。
//
// 它干什么：
//   同一个套话（「心脏怦怦直跳」「不是…而是」这类）在她自己说过的话里出现第 2 次，
//   就换成同义的另一种说法。改的是「发给模型的历史」，不动落盘的会话、也不动你看到的原文。
//   目的：模型反复看到自己第 1 次说什么是自然的，重复才是套路，改掉以后它就不再被自己带偏。
//
// 怎么接上的：DSH 那个版本挂的是 agent/pre-step。模块里用 api.dsh（插件的 ctx）照样能挂同一个钩子，
// 但挂在 Aurabot 的会话上就行。挂不上就退回「只统计不改」——不报错、不影响聊天。

/** @type {import('../aurabot').AurabotModule} */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { DEFAULTS as FILTER_DEFAULTS, loadRules, rewriteText } from './lib/filter.js'

const RULES_FILE = new URL('./assets/slop-zh.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const isAssistant = (message) => {
  if (!message || typeof message !== 'object') return false
  if (message.role === 'assistant') return true
  const kind = message.source && message.source.kind
  return kind === 'assistant' || kind === 'agent'
}

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
}

export default {
  id: 'slop',
  name: '去套话',
  version: '1.0.0',
  api: 1,
  tab: 'persona',
  description: '同一句套话在她自己说过的历史里出现第 2 次就悄悄换个说法，别越说越像模板',

  defaults: {
    enable: true,
    repeatThreshold: FILTER_DEFAULTS.repeatThreshold,
    scanMessages: 40,
    debug: false,
  },
  settings: [
    { key: 'enable', label: '去套话', type: 'switch', hint: '关掉就不改历史，她照着原样看自己说过的话' },
    { key: 'repeatThreshold', label: '第几次才改', type: 'number', min: 2, max: 10, step: 1, hint: '默认 2：第一次出现是自然的，重复才是套话' },
    { key: 'scanMessages', label: '回头看多少条', type: 'number', min: 5, max: 200, step: 5, hint: '只看最近这么多条她自己的话，长了会慢' },
    { key: 'debug', label: '写详细日志', type: 'switch', hint: '打开以后每次改写都记一笔，排查用' },
  ],

  setup(api) {
    let loaded = null
    let loadError = null
    let rulesMtime = null
    const stats = { requests: 0, messages: 0, rewrites: 0, rules: {}, lastAt: null, lastError: null }

    const statsFile = () => api.dataDir('stats.json')

    const load = () => {
      try {
        loaded = loadRules(JSON.parse(readFileSync(RULES_FILE, 'utf8')))
        loadError = null
        api.log.info(`规则载入：${loaded.prepared.length}/${loaded.total} 条，第 ${loaded.repeatThreshold} 次起改`)
      } catch (error) {
        loaded = null
        loadError = error && error.message ? error.message : String(error)
        api.log.warn('规则载入失败：', loadError)
      }
      rulesMtime = mtime()
      return loaded
    }
    const mtime = () => {
      try { return statSync(RULES_FILE).mtimeMs } catch { return null }
    }

    // 接着上次的累计数，不然一重启就看不出来长期效果
    try {
      const f = statsFile()
      if (existsSync(f)) {
        const prev = JSON.parse(readFileSync(f, 'utf8'))
        stats.requests = Number(prev.requests) || 0
        stats.messages = Number(prev.messages) || 0
        stats.rewrites = Number(prev.rewrites) || 0
        stats.rules = prev.rules && typeof prev.rules === 'object' ? prev.rules : {}
        stats.lastAt = prev.lastAt || null
      }
    } catch {}

    let lastSave = 0
    const saveStats = () => {
      try { writeFileSync(statsFile(), JSON.stringify(stats, null, 2), 'utf8') } catch {}
    }

    load()

    /** 改一个 messages 数组：跨消息累计「第几次」，从右往左应用。 */
    const rewriteMessages = (messages) => {
      if (!Array.isArray(messages) || !messages.length) return { changed: false, messages, rules: {} }
      const mt = mtime()
      if (mt !== null && mt !== rulesMtime) load()
      if (!loaded || !loaded.prepared.length) return { changed: false, messages, rules: {} }

      const targets = []
      for (let i = 0; i < messages.length; i += 1) if (isAssistant(messages[i])) targets.push(i)
      const win = targets.slice(-Math.max(5, Number(api.settings().scanMessages) || 40))
      if (!win.length) return { changed: false, messages, rules: {} }

      const opts = {
        lang: 'zh',
        rulesetVersion: loaded.rulesetVersion,
        repeatThreshold: Number(api.settings().repeatThreshold) || loaded.repeatThreshold,
      }
      const occurrences = {}
      const counters = {}
      const out = messages.slice()
      let changed = false
      let touched = 0

      for (const index of win) {
        const message = messages[index]
        const content = message && message.content
        if (!Array.isArray(content)) {
          const text = typeof content === 'string' ? content : ''
          if (!text) continue
          const replaced = rewriteText(text, loaded.prepared, { ...opts, messageIndex: index, partIndex: 0 }, counters, occurrences)
          if (replaced !== text) {
            out[index] = { ...message, content: replaced }
            changed = true
            touched += 1
          }
          continue
        }
        let hit = false
        const blocks = content.map((block, partIndex) => {
          if (!block || block.type !== 'text' || typeof block.text !== 'string') return block
          const replaced = rewriteText(block.text, loaded.prepared, { ...opts, messageIndex: index, partIndex }, counters, occurrences)
          if (replaced === block.text) return block
          hit = true
          return { ...block, text: replaced }
        })
        if (hit) {
          out[index] = { ...message, content: blocks }
          changed = true
          touched += 1
        }
      }

      stats.requests += 1
      stats.messages += win.length
      stats.lastAt = new Date().toISOString()
      if (changed) {
        stats.rewrites += touched
        for (const [id, n] of Object.entries(counters)) stats.rules[id] = (stats.rules[id] || 0) + n
      }
      if (changed || Date.now() - lastSave > 5000) {
        lastSave = Date.now()
        saveStats()
      }
      if (changed && api.settings().debug) api.log.debug(`改了 ${touched} 条历史`)
      return { changed, messages: out, rules: counters }
    }

    // ---------- 挂 agent/pre-step ----------
    // 模块能拿到 DSH 的 ctx（api.dsh），挂的钩子和 DSH 那个版本用的是同一个。
    let hooked = false
    try {
      const ctx = api.dsh
      if (ctx && typeof ctx.on === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => {
          const off = ctx.on('agent/pre-step', async (payload, next) => {
            const decision = await next()
            if (!api.settings().enable) return decision
            if (!decision || decision.kind !== 'enter') return decision
            const r = rewriteMessages(decision.messages)
            if (!r.changed) return decision
            return { ...decision, messages: r.messages }
          })
          return () => { try { off && off() } catch {} }
        }, 'aurabot-slop: rewrite assistant history')
        hooked = true
        api.log.info('挂上了 agent/pre-step（改历史生效）')
      } else {
        api.log.warn('拿不到 DSH 的 ctx，去套话只统计不改')
      }
    } catch (error) {
      api.log.warn('挂 agent/pre-step 失败：', error.message)
    }

    /** 试跑：把 text 当成「第 2 次出现」来改写（先跑一遍预热计数，再跑一遍看结果） */
    const trialRun = (text) => {
      if (!loaded) return { before: text, after: text, changed: false, rules: {}, error: loadError || '规则没载入' }
      const opts = {
        lang: 'zh',
        rulesetVersion: loaded.rulesetVersion,
        repeatThreshold: Number(api.settings().repeatThreshold) || loaded.repeatThreshold,
        messageIndex: 0,
        partIndex: 0,
      }
      const occurrences = {}
      const counters = {}
      rewriteText(String(text), loaded.prepared, opts, {}, occurrences) // 预热：走一遍只计数
      const after = rewriteText(String(text), loaded.prepared, opts, counters, occurrences)
      return { before: String(text), after, changed: after !== String(text), rules: counters }
    }

    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      return api.defineTool({
        name: 'slop_check',
        description: '去套话体检：看规则载入情况和累计统计，或传 text 试跑一遍规则（text 会被当成第 2 次出现来改写）。',
        properties: {
          text: { type: 'string', description: '可选。要试改写的文本' },
          reload: { type: 'boolean', description: '可选。重新载入规则' },
        },
        execute: async ({ text, reload }) => {
          if (reload) load()
          const out = {
            ok: true,
            enabled: Boolean(api.settings().enable),
            hooked,
            rules: loaded ? `${loaded.prepared.length}/${loaded.total}` : `载入失败：${loadError}`,
            rulesetVersion: loaded ? loaded.rulesetVersion : null,
            stats: { requests: stats.requests, messages: stats.messages, rewrites: stats.rewrites },
          }
          if (text) {
            if (!loaded) return { ...out, ok: false, message: '规则没载入，试不了' }
            out.trial = trialRun(String(text))
          }
          return out
        },
      })
    })

    // 面板接口
    api.route('/status', async () => ({
      ok: true,
      enabled: Boolean(api.settings().enable),
      hooked,
      rules: loaded ? loaded.prepared.length : 0,
      total: loaded ? loaded.total : 0,
      loadError,
      stats: { requests: stats.requests, messages: stats.messages, rewrites: stats.rewrites, rules: stats.rules, lastAt: stats.lastAt },
    }))

    api.later(5000, () => saveStats())
    api.onDispose(() => saveStats())
    api.log.info(`去套话模块起来了：规则 ${loaded ? loaded.prepared.length : 0} 条，${hooked ? '改历史生效' : '只统计不改'}`)

    return {
      rewrite: (messages) => rewriteMessages(messages),
      trial: (text) => trialRun(text),
      stats: () => ({ ...stats }),
    }
  },
}
