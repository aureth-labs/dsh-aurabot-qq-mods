// 陪伴记忆（从 Aurabot 1.1.24 的内置模块移植成用户模块，2026-11-04）
// 原因：1.2.0-rc.1 把这套记忆整个删掉了，而桌宠每轮注入的快照全靠它。
// 移植成 modules/companion 之后：数据目录照旧（），
// 记忆一条不动，而且以后再升级插件也不会被覆盖。
// 全局生效（整个 DSH 的所有会话，包括 QQ 会话），作用域和原插件一致。
import { advanceCursor, deriveTurnEntry, fillCursor } from './archive.js'
import { ArchiveIndex } from './archive-index.js'
import { buildSnapshot, estimateTokens, lifecyclePass, resolveConfig } from './engine.js'
import { CONTEXT_ORDER, POLICY_SECTION_NAME, SNAPSHOT_CONTEXT_NAME, SECTION_ORDER, policyText, renderSnapshotText } from './render.js'
import { MemoryStore, resolveDataDir } from './store.js'
import { registerMemoryTools } from './tools.js'
import { join } from 'node:path'

const LIFECYCLE_THROTTLE_MS = 60 * 1000

export default {
  id: 'companion',
  name: '陪伴记忆',
  version: '1.0.0',
  api: 1,
  description: '冷热分层记忆：固定事实 + 活跃记忆 + 冷库召回，每轮按预算注入；全局生效',
  tab: 'memory',
  files: ['features/companion-memory'],

  defaults: {
    enabled: true,
    memorySnapshotTokens: 1600,
    pinnedTokens: 160,
    hotTokens: 960,
    recalledTokens: 480,
  },
  settings: [
    { key: 'enabled', label: '启用陪伴记忆', type: 'switch', hint: '关掉后不再注入快照，也不再归档新对话' },
    { key: 'memorySnapshotTokens', label: '每轮快照总预算（token）', type: 'number', min: 400, max: 8000, step: 100 },
    { key: 'pinnedTokens', label: '固定事实预算', type: 'number', min: 0, max: 2000, step: 20 },
    { key: 'hotTokens', label: '活跃记忆预算', type: 'number', min: 0, max: 4000, step: 100 },
    { key: 'recalledTokens', label: '召回预算', type: 'number', min: 0, max: 2000, step: 60 },
  ],

  setup(api) {
    const dsh = api.dsh
    const log = api.log
    const hub = api.core?.hub || null

    // 数据目录沿用原插件的（），保持已有记忆不丢
    const cfgDataDir = () => {
      // 配置在 plugins-data/aurabot/config.json 的顶层 companionDataDir；没配就退回老目录
      const c = api.config()
      const explicit = c && typeof c.companionDataDir === 'string' ? String(c.companionDataDir).trim() : ''
      return resolveDataDir(explicit ? { dataDir: explicit } : null)
    }

    const resolved = () => {
      const s = api.settings()
      return resolveConfig({
        budgets: {
          memorySnapshotTokens: Number(s.memorySnapshotTokens) || 1600,
          pinnedTokens: Number(s.pinnedTokens) || 160,
          hotTokens: Number(s.hotTokens) || 960,
          recalledTokens: Number(s.recalledTokens) || 480,
        },
        archive: { backfillOnStart: false },
      })
    }

    const dataDir = cfgDataDir()
    const store = new MemoryStore(dataDir)
    const archiveIndex = new ArchiveIndex(resolved().archiveIndex)
    const recallState = { at: 0, cue: '', status: 'not_run', tokens: 0, degraded: 'lexical_fallback', items: [] }

    let lastLifecycleAt = 0
    let persistQueue = Promise.resolve()
    let loaded = false
    const cursors = new Map()

    const ready = store
      .load()
      .then(() => {
        loaded = true
        log.info(`陪伴记忆已就绪：${store.size()} 条记忆卡，数据在 ${dataDir}`)
      })
      .catch((error) => {
        log.warn('读记忆失败，从空开始：' + (error && error.message ? error.message : String(error)))
        loaded = true
      })

    const persist = () => {
      persistQueue = persistQueue
        .then(() => Promise.all([store.saveRecords(), store.saveState()]))
        .catch((error) => log.warn('写记忆失败：' + (error && error.message ? error.message : String(error))))
      return persistQueue
    }

    const runLifecycle = (force) => {
      const now = Date.now()
      if (!force && now - lastLifecycleAt < LIFECYCLE_THROTTLE_MS) {
        return { changes: [], pinOverflow: store.state.pin_overflow ?? [], hotPoolSize: 0, throttled: true }
      }
      lastLifecycleAt = now
      try {
        const report = lifecyclePass(store, resolved(), now)
        if (report.changes.length > 0) void persist()
        return report
      } catch (error) {
        log.warn('生命周期计算失败：' + (error && error.message ? error.message : String(error)))
        return { changes: [], pinOverflow: [], hotPoolSize: 0, failed: true }
      }
    }

    /** 召回缓存要对齐当前存储：删了 / 更正了立刻从后续请求里消失。 */
    const liveRecall = () => {
      if (!Array.isArray(recallState.items) || recallState.items.length === 0) return null
      const alive = recallState.items.filter((item) => {
        if (!item) return false
        if (item.record && item.record.id) {
          const record = store.get(item.record.id)
          return record !== undefined && record.status === 'valid'
        }
        if (item.source === 'archive') return archiveIndex.byId.has(item.id)
        return false
      })
      if (alive.length === 0) {
        recallState.items = []
        recallState.status = 'expired'
        return null
      }
      if (alive.length !== recallState.items.length) {
        recallState.items = alive
        recallState.tokens = alive.reduce((total, item) => total + estimateTokens(item.line) + 8, 0)
      }
      return { ...recallState, items: alive }
    }

    // ---------- 归档 ----------
    let archiveQueue = Promise.resolve()
    const watermark = (sessionId) => (store.state.archive_watermarks ?? {})[sessionId] ?? -1

    const enqueueTurn = (entry) => {
      archiveQueue = archiveQueue
        .then(async () => {
          if (entry.seq <= watermark(entry.session_id)) return null
          await store.archiveTurn(entry)
          store.state.archive_watermarks = { ...(store.state.archive_watermarks ?? {}), [entry.session_id]: entry.seq }
          await store.saveState()
          archiveIndex.addEntry(entry)
          return entry
        })
        .catch((error) => {
          log.warn(`归档写入失败（seq ${entry.seq}）：` + (error && error.message ? error.message : String(error)))
          return null
        })
      return archiveQueue
    }

    const runBackfill = async (limitPerSession) => {
      const query = dsh.get('sessionQuery')
      if (!query || typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') {
        return { ok: false, error: 'sessionQuery 服务不可用' }
      }
      const cap = Number.isSafeInteger(limitPerSession) && limitPerSession > 0 ? limitPerSession : 0
      const records = await query.listSessions()
      let archived = 0
      let sessionsArchived = 0
      let unreadable = 0
      for (const record of records) {
        const id = String(record.header.id)
        let snapshot = null
        try {
          snapshot = await query.readSession(record.header.id)
        } catch {
          unreadable += 1
          continue
        }
        let last = watermark(id)
        let count = 0
        const cursor = { turn: null, step: null }
        for (const event of snapshot.events ?? []) {
          advanceCursor(cursor, event)
          if (cap > 0 && count >= cap) break
          let entry = null
          try {
            entry = deriveTurnEntry(event, null)
          } catch {
            entry = null
          }
          if (!entry) continue
          fillCursor(entry, cursor)
          if (entry.seq <= last) continue
          entry.session_id = id
          try {
            await store.archiveTurn(entry)
            archiveIndex.addEntry(entry)
          } catch (error) {
            log.warn(`回填写入失败（${id} seq ${entry.seq}）`)
            break
          }
          last = entry.seq
          count += 1
        }
        if (count > 0) {
          store.state.archive_watermarks = { ...(store.state.archive_watermarks ?? {}), [id]: last }
          archived += count
          sessionsArchived += 1
        }
      }
      await store.saveState()
      return { ok: true, sessionsScanned: records.length, sessionsArchived, turnsArchived: archived, unreadableSessions: unreadable }
    }

    const purgeArchiveRange = async (options) => {
      const sessionId = options && typeof options.session_id === 'string' ? options.session_id.trim() : ''
      const before = options && typeof options.before === 'string' ? options.before.trim() : ''
      const all = options && options.all === true
      if (!all && !sessionId && !before) return { ok: false, error: 'purge 需要 session_id、before 或 all 之一' }
      const removed = await store.purgeArchiveWhere((entry) => {
        if (all) return true
        if (sessionId && String(entry.session_id ?? '') === sessionId) return true
        if (before && typeof entry.at === 'string' && entry.at < before) return true
        return false
      })
      if (removed > 0) archiveIndex.clear()
      if (sessionId || all) {
        const marks = { ...(store.state.archive_watermarks ?? {}) }
        if (all) store.state.archive_watermarks = {}
        else delete marks[sessionId]
        if (!all) store.state.archive_watermarks = marks
        await store.saveState()
      }
      return { ok: true, removed, note: '只清本插件归档的副本；DSH 会话日志本身由 harness 管理' }
    }

    const archiveApi = {
      stats: () => store.archiveStats(),
      backfill: (limit) => runBackfill(limit),
      purge: (options) => purgeArchiveRange(options),
    }

    // ---------- 工具（全局）----------
    // Aurabot 的 module api.dsh 是 cordis 上下文，注册工具要走 hub 的 buildTools；
    // 只有官方插件（cordis bundle）才能靠 inject 拿 ctx.tools。这里两条路都试。
    const registered = []
    const toolCtx = {
      effect: (fn) => {
        try {
          return fn()
        } catch (error) {
          log.warn('effect 里抛错：' + (error && error.message ? error.message : String(error)))
          return () => {}
        }
      },
      tools: {
        register: (definition) => {
          registered.push(definition)
          // 走 Aurabot 的模块 api.tool()：会进 mods.buildTools()，由 hub 给每个会话挂上
          try {
            api.tool(() => definition)
          } catch (error) {
            log.warn('挂工具失败：' + (error && error.message ? error.message : String(error)))
          }
          return () => {}
        },
      },
      logger: {
        warn: (m) => log.warn(String(m)),
        info: (m) => log.info(String(m)),
      },
      get: (name) => dsh.get(name),
    }
    ready.then(() => {
      try {
        const names = registerMemoryTools(toolCtx, {
          store,
          config: resolved(),
          runLifecycle,
          recallState,
          archive: archiveApi,
          archiveIndex,
        })
        log.info(`陪伴记忆工具已注册：${(names || []).join(', ')}`)
      } catch (error) {
        log.warn('注册记忆工具失败：' + (error && error.message ? error.message : String(error)))
      }
    })

    // ---------- 每轮注入（全局）----------
    dsh.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.effect(
        () =>
          promptCtx.systemPrompt.section({
            name: POLICY_SECTION_NAME,
            order: SECTION_ORDER,
            interpolate: false,
            text: () => (api.settings().enabled === false ? '' : policyText()),
          }),
        'aurabot-companion: policy',
      )

      promptCtx.effect(
        () =>
          promptCtx.systemPrompt.context({
            name: SNAPSHOT_CONTEXT_NAME,
            order: CONTEXT_ORDER,
            text: () => {
              if (api.settings().enabled === false) return ''
              if (!loaded) return ''
              const now = Date.now()
              runLifecycle(false)
              const snapshot = buildSnapshot(store, resolved(), now)
              return renderSnapshotText(snapshot, liveRecall(), now)
            },
          }),
        'aurabot-companion: snapshot',
      )
    })

    // ---------- 对话归档（全局）----------
    // 直接挂 DSH 的 session/event（模块 api 没有这一层转发）。
    const onSessionEvent = (session, event) => {
      if (api.settings().enabled === false) return
      try {
        if (!session || session.id === undefined || !event || typeof event !== 'object') return
        const sessionId = String(session.id)
        const cursor = cursors.get(sessionId) ?? { turn: null, step: null }
        cursors.set(sessionId, cursor)
        advanceCursor(cursor, event)
        const entry = deriveTurnEntry(event, session)
        if (!entry) return
        fillCursor(entry, cursor)
        void enqueueTurn(entry)
      } catch (error) {
        log.warn('归档事件处理失败：' + (error && error.message ? error.message : String(error)))
      }
    }
    try {
      dsh.on('session/event', onSessionEvent)
    } catch (error) {
      log.warn('挂不上 session/event，归档不会记录新对话：' + (error && error.message ? error.message : String(error)))
    }


    // 卸载时把内存里的东西落盘
    api.onDispose(() => {
      void persist()
      void archiveQueue
    })

    // ---------- 面板接口 ----------
    // 内置模块的路由前缀是 /aurabot/api/<id>/（API.md 里写的是扩展模块的写法）
    const route = (path, handler) => api.route('/companion' + (path.startsWith('/') ? path : '/' + path), handler)

    route('/state', async () => {
      await ready
      const now = Date.now()
      const snapshot = buildSnapshot(store, resolved(), now)
      const stats = await store.stats().catch(() => ({ records: store.size(), archiveEntries: 0 }))
      return {
        ok: true,
        dataDir,
        stats,
        budgets: resolved().budgets,
        entity: store.state.entity || {},
        snapshot: { pinned: snapshot.pinned, hot: snapshot.hot, continuityVersion: snapshot.continuityVersion },
        continuity: { basePersona: store.state.entity?.base_persona || '', currentState: store.state.entity?.current_state || '', version: store.state.entity?.state_version || 0 },
        tokens: snapshot.tokens || {},
      }
    })

    route('/records', async (req) => {
      await ready
      const q = String(api.core.http?.query?.(req)?.q || '')
      const all = store.list().map((r) => ({ ...r }))
      if (q) {
        const hit = all.filter((r) => String(r.summary || '').includes(q) || String(r.id).includes(q))
        return { ok: true, items: hit.slice(0, 300), count: hit.length }
      }
      return { ok: true, items: all.slice(0, 300), count: all.length }
    })

    route('/record/delete', async (req) => {
      const b = await api.core.http.body(req)
      const rec = store.get(String(b.id || ''))
      if (!rec) return { ok: false, message: '没有这条记忆' }
      await store.remove(rec.id)
      await persist()
      return { ok: true, message: '删了' }
    })

    route('/record/pin', async (req) => {
      const b = await api.core.http.body(req)
      const rec = store.get(String(b.id || ''))
      if (!rec) return { ok: false, message: '没有这条记忆' }
      rec.pinned = b.pinned !== false
      rec.tier = rec.pinned ? 'pinned' : 'hot'
      await persist()
      return { ok: true, message: rec.pinned ? '固定了' : '取消固定' }
    })

    route('/lifecycle', async () => {
      await ready
      const report = runLifecycle(true)
      await persist()
      return { ok: true, report }
    })

    route('/archive/stats', async () => ({ ok: true, stats: await store.archiveStats() }))

    log.info(`陪伴记忆模块起来了，数据目录 ${dataDir}`)
    return { store, dataDir, resolved, runLifecycle, archiveApi }
  },
}
