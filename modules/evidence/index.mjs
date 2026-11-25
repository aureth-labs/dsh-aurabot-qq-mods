// 扩展模块「记忆晋升」（evidence）—— 从 DSH 那侧的 dsh-pet-evidence 搬过来的。
// 放在 Aurabot 数据目录 modules/evidence/ 里，插件升级不会动它；保存就生效。
//
// 它管的是一条「长记忆」线：
//   事实（主人说过的话，别人的库管着）→ 被反复提到就攒证据分 → 够格写一段反思
//   → 反思攒够了变成人格片段。都不是任务，是记账。
//
// 数据沿用  DSH 那边共用一本账，
// 每次刷新都重新从磁盘读一遍再算（advance 是幂等的），所以两边同时开着也不会打架。
// 但建议只留一边，见面板里的「跟 DSH 那边共用账本」。

/** @type {import('../aurabot').AurabotModule} */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { advance, renderDigest, summarize, writePersona, writeReflection } from './lib/engine.js'
import { readRecords, readStore, saveStore } from './lib/store.js'

const POLICY = [
  '【记忆证据】',
  '你有一条自己的「长记忆」线：事实被反复提到，就会被标成可信；可信的事实攒在一起，值得你写一段反思；反思攒多了，就是你自己的样子（人格片段）。',
  '这不是任务清单，是记账。看到欠着的反思就顺手写掉，别堆着，也别为了晋升硬凑。',
  '写反思用 evidence_write（kind=reflection），写人格片段用 kind=persona。文字要像你自己说话，不要写成条目。',
  '事实本身不用你操心，主人说什么会自动进事实库，你只管看和写。',
].join('\n')

const short = (text, max = 80) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

export default {
  id: 'evidence',
  name: '记忆晋升',
  version: '1.0.0',
  api: 1,
  tab: 'memory',
  description: '事实被反复提到就攒证据分，够格写反思，反思攒多了变成人格片段',

  defaults: {
    enabled: true,
    storeFile: '',
    recordsFile: 'companion-memory\\records.json',
    refreshMs: 60000,
    injectContext: true,
  },
  settings: [
    { key: 'enabled', label: '记忆晋升', type: 'switch', hint: '关掉以后不再算证据、不再给她塞提要；已有的反思和人格留着' },
    { key: 'injectContext', label: '每轮给她提要', type: 'switch', hint: '把「欠着几条反思」这类提要塞进上下文，她才会想起来写' },
    { key: 'storeFile', label: '账本文件', type: 'text', hint: '证据账存在哪。默认跟 DSH 那边共用一本' },
    { key: 'recordsFile', label: '事实库文件', type: 'text', hint: '读谁的事实。默认 companion-memory 的 records.json' },
    { key: 'refreshMs', label: '多久算一次（毫秒）', type: 'number', min: 10000, max: 600000, step: 10000, hint: '默认 60 秒；事实库没改就不重算' },
  ],

  setup(api) {
    let store = null
    let lastRefresh = 0
    let lastMtime = null
    let lastRecords = 0
    let lastEvents = []
    let lastError = null

    const storeFile = () => String(api.settings().storeFile || '')
    const recordsFile = () => String(api.settings().recordsFile || 'companion-memory\\records.json')

    const load = () => {
      store = readStore(storeFile())
      return store
    }

    const mtimeOf = (file) => {
      try { return statSync(file).mtimeMs } catch { return null }
    }

    /** 读事实库 → 算证据 → 落盘。节流：事实库没动、时间没到就直接返回。 */
    const refresh = (force = false) => {
      if (!api.settings().enabled) return { ok: false, skipped: 'disabled' }
      const now = Date.now()
      const mt = mtimeOf(recordsFile())
      if (!force && store && now - lastRefresh < Number(api.settings().refreshMs || 60000) && mt === lastMtime) {
        return { ok: true, cached: true, events: [] }
      }
      try {
        // 每次都从磁盘重读一遍：跟 DSH 那边共用一本账时，这样能接上对方写的内容
        const fresh = readStore(storeFile())
        const records = readRecords(recordsFile())
        lastRecords = records.length
        const result = advance(fresh, records, now)
        store = result.store
        lastEvents = result.events || []
        lastError = null
        if (JSON.stringify(fresh) !== JSON.stringify(result.store) || force) {
          saveStore(storeFile(), store)
        }
        lastRefresh = now
        lastMtime = mt
        return { ok: true, events: lastEvents }
      } catch (error) {
        lastError = error && error.message ? error.message : String(error)
        api.log.warn('算证据出错：', lastError)
        return { ok: false, error: lastError }
      }
    }

    load()
    refresh(true)

    // ---------- 每轮给她塞提要 ----------
    api.context(() => {
      if (!api.settings().enabled || !api.settings().injectContext) return ''
      try { refresh() } catch {}
      return renderDigest(store || load())
    })
    api.rule(POLICY)

    // ---------- 工具 ----------
    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      return [
        api.defineTool({
          name: 'evidence_status',
          description: '看记忆证据的账：各阶段事实数、欠着的反思/人格、最近一轮变化。',
          properties: {
            detail: { type: 'boolean', description: '可选。true 时列出全部事实的证据分' },
          },
          execute: async ({ detail }) => {
            refresh(true)
            const out = {
              ok: true,
              summary: summarize(store),
              lastEvents: lastEvents.slice(-10),
              records: lastRecords,
              lastError,
            }
            if (detail) {
              out.facts = Object.values(store.facts || {})
                .sort((a, b) => (b.evidence ?? 0) - (a.evidence ?? 0))
                .slice(0, 40)
                .map((f) => `${f.stage || '?'} ${Number(f.evidence ?? 0).toFixed(2)}：${short(f.summary)}`)
              out.reflections = (store.reflections || []).map((r) => `${r.status} ${r.topic_id}：${short(r.text || '（还没写）', 50)}`)
              out.persona = (store.persona || []).map((p) => `${p.status} ${p.topic_id}：${short(p.text || '（还没写）', 50)}`)
            }
            return out
          },
        }),
        api.defineTool({
          name: 'evidence_owe',
          description: '列出欠着的反思和人格片段，附带它们是由哪几条事实撑起来的（写之前先看这个）。',
          properties: {},
          execute: async () => {
            refresh(true)
            const pend = (store.reflections || []).filter((r) => r.status === 'pending' || r.status === 'stale')
            const pendP = (store.persona || []).filter((p) => p.status === 'pending')
            const factsOf = (ids) => (ids || []).map((id) => store.facts?.[id]).filter(Boolean).map((f) => short(f.summary, 100))
            return {
              ok: true,
              owe: pend.length + pendP.length,
              reflections: pend.map((r) => ({ id: r.id, topic: r.topic_id, status: r.status, evidence: r.evidence, facts: factsOf(r.fact_ids) })),
              persona: pendP.map((p) => ({
                id: p.id,
                topic: p.topic_id,
                evidence: p.evidence,
                reflections: (p.reflection_ids || [])
                  .map((id) => (store.reflections || []).find((r) => r.id === id))
                  .filter(Boolean)
                  .map((r) => ({ topic: r.topic_id, text: r.text })),
              })),
            }
          },
        }),
        api.defineTool({
          name: 'evidence_write',
          description: '把一条反思或人格片段写下来。kind=reflection 写反思，kind=persona 写自己的样子。写完状态变 ready。',
          properties: {
            id: { type: 'string', description: '要写的反思/人格 id（从 evidence_owe 拿）' },
            kind: { type: 'string', enum: ['reflection', 'persona'], description: '写哪种' },
            text: { type: 'string', description: '写下来的文字' },
          },
          required: ['id', 'kind', 'text'],
          execute: async ({ id, kind, text }) => {
            const theId = String(id || '').trim()
            const theKind = kind === 'persona' ? 'persona' : 'reflection'
            const body = String(text || '').trim()
            if (!theId) return { ok: false, message: 'id 不能为空' }
            if (!body) return { ok: false, message: 'text 不能为空' }
            refresh(true)
            const entry = theKind === 'persona' ? writePersona(store, theId, body) : writeReflection(store, theId, body)
            if (!entry) return { ok: false, message: `找不到${theKind}：${theId}` }
            saveStore(storeFile(), store)
            // 写完再推一遍：可能刚好攒够人格
            const after = advance(store, readRecords(recordsFile()), Date.now())
            store = after.store
            saveStore(storeFile(), store)
            api.log.info(`写了 ${theKind} ${theId}（${body.length} 字）`)
            return {
              ok: true,
              message: `写好了：${short(entry.text, 60)}`,
              summary: summarize(store),
              newEvents: after.events || [],
            }
          },
        }),
      ]
    })

    // ---------- 定时推进 ----------
    api.every(60000, () => { refresh() }, '记忆晋升')
    api.later(8000, () => { refresh(true) })

    // 面板接口
    api.route('/status', async () => {
      refresh(true)
      return {
        ok: true,
        enabled: Boolean(api.settings().enabled),
        summary: summarize(store),
        records: lastRecords,
        storeFile: storeFile(),
        recordsFile: recordsFile(),
        lastError,
      }
    })

    api.log.info(`记忆晋升模块起来了：${JSON.stringify(summarize(store))}`)

    return {
      store: () => store,
      refresh,
      summary: () => summarize(store),
    }
  },
}
