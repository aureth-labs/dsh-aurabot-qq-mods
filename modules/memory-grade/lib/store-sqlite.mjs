/**
 * 记忆库存储层 · 照插件结构（2026-11-21）
 *
 * 为什么照抄插件的结构：
 *   咱们最终要「模块当权威、往回接管插件的 memory」，还得能「随时拎走换框架」。
 *   如果模块用自己的表结构，接管那天得做一次大迁移，命匣也得跟着改。
 *   照插件的结构存（items / kv / meta 三张表，都是 id + json），
 *   就能「同一份文件，插件和模块都能读」——造好了直接对换，不用搬数据。
 *
 * 表结构（和 aurabot 的 memory.sqlite 一模一样）：
 *   items (id TEXT PRIMARY KEY, json TEXT NOT NULL)
 *   gists (id TEXT PRIMARY KEY, json TEXT NOT NULL)
 *   kv    (key TEXT PRIMARY KEY, json TEXT NOT NULL)
 *   meta  (key TEXT PRIMARY KEY, json TEXT NOT NULL)
 *
 * 记法和插件一样：整条塞 json 里，不拆列。这样插件加了新字段也不会丢。
 *
 * 写法和插件一样：改完对比上次快照，只写变了的行，全包在一个事务里。
 * 读的时候开关连接，不长期占用文件（Windows 上搬目录/被别的东西打开时不会卡死）。
 */

import { existsSync, mkdirSync, renameSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const FILE = 'memory.sqlite'
const LEGACY = 'memory.json'
const SCHEMA_VERSION = 2

// 取 node:sqlite。取不到就让上层退回 JSON。
let DatabaseSync = null
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch {
  DatabaseSync = null
}

/** 这个运行时有没有 node:sqlite */
export function sqliteAvailable() {
  return !!DatabaseSync
}

/** 造一个不重复的 id：8 位十六进制 */
function makeId(used) {
  for (let i = 0; i < 50; i++) {
    const id = randomUUID().replace(/-/g, '').slice(0, 8)
    if (!used.has(id)) return id
  }
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/**
 * 打开（或新建）记忆库。
 *
 * @param {string} dir 数据目录
 * @param {object} [opts]
 * @param {object} [opts.log] 日志口
 * @returns {object|null} 打不开返回 null，调用方退回 JSON
 */
export function openStoreSqlite(dir, opts = {}) {
  if (!DatabaseSync) return null
  if (!dir) return null
  const log = opts.log

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {
    return null
  }

  const file = join(dir, FILE)

  // ---------- 建表 ----------
  let initDb
  try {
    initDb = new DatabaseSync(file)
    initDb.exec('PRAGMA journal_mode = WAL')
    initDb.exec('PRAGMA synchronous = NORMAL')
    initDb.exec('PRAGMA busy_timeout = 5000')
    initDb.exec(`
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gists (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    `)
  } catch (error) {
    log?.warn?.('[memory-grade] sqlite 打不开，退回 JSON：' + error.message)
    try {
      initDb?.close()
    } catch {
      /* 关不掉就算了 */
    }
    return null
  }
  try {
    initDb.close()
  } catch {
    /* 关不掉就算了 */
  }

  // ---------- 开一个连接，读到内存 ----------
  const openDb = () => new DatabaseSync(file)
  const closeDb = (d) => {
    try {
      d.close()
    } catch {
      /* 关不掉就算了 */
    }
  }

  /** 把所有表读成 { items: Map, gists: Map, kv: Map, meta: Map } */
  function readAll(db) {
    const out = { items: new Map(), gists: new Map(), kv: new Map(), meta: new Map() }
    for (const [table, key] of [
      ['items', 'id'],
      ['gists', 'id'],
      ['kv', 'key'],
      ['meta', 'key'],
    ]) {
      const rows = db.prepare('SELECT ' + key + ' AS k, json FROM ' + table).all()
      const map = new Map()
      for (const r of rows) {
        try {
          map.set(String(r.k), JSON.parse(r.json))
        } catch {
          /* 坏行跳过 */
        }
      }
      out[table] = map
    }
    return out
  }

  // ---------- 内存索引 ----------
  /** id → item（items 表的内容） */
  const index = new Map()
  /** 上次落盘时的快照，用来对比只写变了的行 */
  let snapshot = { items: new Map(), gists: new Map(), kv: new Map(), meta: new Map() }

  let migrated = 0

  // ---------- 首次读入 ----------
  {
    const db = openDb()
    try {
      const state = readAll(db)
      for (const [id, it] of state.items) index.set(id, it)
      snapshot = {
        items: new Map([...state.items].map(([k, v]) => [k, JSON.stringify(v)])),
        gists: new Map(),
        kv: new Map([...state.kv].map(([k, v]) => [k, JSON.stringify(v)])),
        meta: new Map([...state.meta].map(([k, v]) => [k, JSON.stringify(v)])),
      }
      if (state.items.size === 0 && existsSync(join(dir, LEGACY))) {
        // 老 JSON 里还有数据，往里搬
        const raw = JSON.parse(readFileSync(join(dir, LEGACY), 'utf8'))
        const items = Array.isArray(raw?.items) ? raw.items : []
        const order = Array.isArray(raw?.order) ? raw.order : []
        const orderMap = new Map(order.map((id, i) => [id, i]))

        db.exec('BEGIN IMMEDIATE')
        try {
          const put = db.prepare('INSERT INTO items (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
          const sorted = items.slice().sort((a, b) => {
            const oa = orderMap.has(a.id) ? orderMap.get(a.id) : Number.MAX_SAFE_INTEGER
            const ob = orderMap.has(b.id) ? orderMap.get(b.id) : Number.MAX_SAFE_INTEGER
            return ob - oa
          })
          for (const it of sorted) {
            if (!it || !it.id) continue
            put.run(String(it.id), JSON.stringify(it))
            index.set(String(it.id), it)
            migrated++
          }
          // kv 也搬（profile、relations 这些在里面）
          if (raw?.kv && typeof raw.kv === 'object') {
            const putKv = db.prepare('INSERT INTO kv (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json')
            for (const [k, v] of Object.entries(raw.kv)) putKv.run(String(k), JSON.stringify(v))
          }
          db.exec('COMMIT')
        } catch (error) {
          try {
            db.exec('ROLLBACK')
          } catch {
            /* 回滚失败也认了 */
          }
          throw error
        }

        // 老文件留档，不删
        try {
          renameSync(join(dir, LEGACY), join(dir, LEGACY + '.imported-' + Date.now()))
        } catch {
          /* 改名失败不影响用 */
        }
        log?.info?.('[memory-grade] 从 memory.json 迁了 ' + migrated + ' 条')
      }
      const cnt = Number(db.prepare('SELECT COUNT(*) AS n FROM items').get()?.n) || 0
      if (cnt) log?.info?.('[memory-grade] 记忆库（sqlite·插件结构）：' + file + '，' + cnt + ' 条')
    } catch (error) {
      log?.warn?.('[memory-grade] 读 sqlite 失败：' + error.message)
    } finally {
      closeDb(db)
    }
  }

  /** 当前内存里所有 id（防重复用） */
  const usedIds = new Set(index.keys())

  /**
   * 落盘：对比快照，只写变了的行。
   * 和插件的 writeRows 一个思路。
   */
  function save() {
    const db = openDb()
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        // items
        const put = db.prepare('INSERT INTO items (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
        const del = db.prepare('DELETE FROM items WHERE id = ?')
        const nextItems = new Map()
        for (const [id, it] of index) {
          const json = JSON.stringify(it)
          nextItems.set(id, json)
          if (snapshot.items.get(id) !== json) put.run(id, json)
        }
        for (const id of snapshot.items.keys()) if (!nextItems.has(id)) del.run(id)
        snapshot.items = nextItems
        db.exec('COMMIT')
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 回滚失败也认了 */
        }
        throw error
      }
    } finally {
      closeDb(db)
    }
  }

  // ---------- 对外方法（和 JSON 版接口一致）----------

  function add(text, extra = {}) {
    const t = String(text || '').trim()
    if (!t) return null
    const now = Date.now()
    const item = {
      id: makeId(usedIds),
      text: t,
      about: extra.about ?? '',
      aboutName: extra.aboutName ?? '',
      tags: Array.isArray(extra.tags) ? extra.tags : [],
      importance: typeof extra.importance === 'number' ? extra.importance : 0.5,
      source: extra.source ?? 'module',
      chatId: extra.chatId ?? '',
      at: typeof extra.at === 'number' ? extra.at : now,
      hits: 0,
      hitDays: 0,
      lastHit: 0,
      cls: extra.cls ?? 'internal',
      owner: extra.owner ?? '',
      gua: extra.gua ?? null,
      guaUpper: extra.guaUpper ?? '',
      guaLower: extra.guaLower ?? '',
      state: extra.state ?? 'active',
      pin: extra.pin === true,
      pinOrder: typeof extra.pinOrder === 'number' ? extra.pinOrder : 0,
    }
    // 别的字段（validUntil、kind、meta…）调用方给了就带上
    for (const [k, v] of Object.entries(extra)) if (!(k in item)) item[k] = v
    // seq 用来保排序：比现有最大的大一点
    item.__seq = Date.now() * 1000 + (index.size % 1000)
    index.set(item.id, item)
    usedIds.add(item.id)
    try {
      save()
    } catch (error) {
      log?.warn?.('[memory-grade] 写 sqlite 失败：' + error.message)
    }
    return item
  }

  function get(id) {
    return index.get(String(id || '')) || null
  }

  function update(id, patch = {}) {
    const key = String(id || '')
    const item = index.get(key)
    if (!item) return null
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') continue
      item[k] = v
    }
    try {
      save()
    } catch (error) {
      log?.warn?.('[memory-grade] 更新 sqlite 失败：' + error.message)
    }
    return item
  }

  function remove(id) {
    const key = String(id || '')
    if (!index.has(key)) return false
    index.delete(key)
    usedIds.delete(key)
    try {
      save()
    } catch {
      /* 写失败下次启动会对上 */
    }
    return true
  }

  /** 按顺序列（新的在前） */
  function list({ limit = 50, offset = 0, cls, tag, pin } = {}) {
    const all = [...index.values()].sort((a, b) => (b.__seq || b.at || 0) - (a.__seq || a.at || 0))
    const out = []
    for (const it of all) {
      if (cls && it.cls !== cls) continue
      if (tag && !(it.tags || []).includes(tag)) continue
      if (pin === true && !it.pin) continue
      if (pin === false && it.pin) continue
      out.push(it)
    }
    return out.slice(offset, offset + limit)
  }

  function byPerson(about, { limit = 20, kind, includeExpired = false, cls } = {}) {
    const who = String(about || '').trim()
    if (!who) return []
    const now = Date.now()
    const out = []
    for (const it of index.values()) {
      if (String(it.about || '') !== who) continue
      if (it.invalidAt && !includeExpired) continue
      if (cls && it.cls !== cls) continue
      const k = it.kind === 'status' ? 'status' : 'fact'
      if (kind && k !== kind) continue
      if (k === 'status' && it.validUntil && it.validUntil < now && !includeExpired) continue
      out.push(it)
    }
    out.sort((a, b) => (b.at || 0) - (a.at || 0))
    return out.slice(0, limit)
  }

  /** 关键词检索。打分规则和 JSON 版一模一样，换引擎不该换召回结果。 */
  function search(query, { limit = 20, cls, tag, includeArchived = false, includeSleeping = true } = {}) {
    const q = String(query || '').trim()
    if (!q) return []
    const words = q.split(/[\s,，、]+/).filter(Boolean)
    const now = Date.now()
    const scored = []
    for (const it of index.values()) {
      if (cls && it.cls !== cls) continue
      if (tag && !(it.tags || []).includes(tag)) continue
      if (!includeArchived && it.state === 'archived') continue
      if (!includeSleeping && it.state === 'sleeping') continue
      const text = it.text || ''
      let score = 0
      let hitWords = 0
      if (text.includes(q)) score += 100
      for (const w of words) {
        if (text.includes(w)) {
          hitWords++
          score += 20
        }
      }
      if (!hitWords) continue
      if (hitWords === words.length && words.length > 1) score += 30
      if (it.state === 'sleeping') score *= 0.5
      score += (it.importance || 0) * 10
      const ageDays = (now - (it.at || now)) / 86400000
      score += Math.max(0, 5 - ageDays / 73)
      scored.push({ item: it, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((x) => ({ ...x.item, _score: Math.round(x.score * 10) / 10 }))
  }

  function pin(id, on = true, order = 0) {
    return update(id, { pin: !!on, pinOrder: on ? order : 0 })
  }

  function touch(id) {
    const item = get(id)
    if (!item) return null
    item.hits = (item.hits || 0) + 1
    const today = new Date().toISOString().slice(0, 10)
    if (item._lastHitDay !== today) {
      item.hitDays = (item.hitDays || 0) + 1
      item._lastHitDay = today
    }
    item.lastHit = Date.now()
    return update(id, item)
  }

  function stats() {
    const byCls = {}
    const byTag = {}
    let pinned = 0
    for (const it of index.values()) {
      byCls[it.cls || 'internal'] = (byCls[it.cls || 'internal'] || 0) + 1
      if (it.pin) pinned++
      for (const t of it.tags || []) byTag[t] = (byTag[t] || 0) + 1
    }
    return { total: index.size, pinned, byCls, byTag }
  }

  function all() {
    return [...index.values()]
  }

  function flush() {
    try {
      save()
    } catch {
      /* 下次再试 */
    }
  }

  function close() {
    flush()
  }

  /**
   * 读 kv 里的一项（人物档案、关系、说话方式这些都在 kv）。
   * 插件把这些存在 kv 表，模块要用得能读到。
   */
  function kvGet(key) {
    const db = openDb()
    try {
      const r = db.prepare('SELECT json FROM kv WHERE key = ?').get(String(key))
      if (!r) return null
      try {
        return JSON.parse(r.json)
      } catch {
        return null
      }
    } catch {
      return null
    } finally {
      closeDb(db)
    }
  }

  /** 写 kv 里的一项 */
  function kvSet(key, value) {
    const db = openDb()
    try {
      db.prepare('INSERT INTO kv (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json').run(
        String(key),
        JSON.stringify(value),
      )
      return true
    } catch {
      return false
    } finally {
      closeDb(db)
    }
  }

  /** 全部 kv 键名 */
  function kvKeys() {
    const db = openDb()
    try {
      return db
        .prepare('SELECT key FROM kv')
        .all()
        .map((r) => String(r.key))
    } catch {
      return []
    } finally {
      closeDb(db)
    }
  }

  return {
    add,
    get,
    update,
    remove,
    list,
    search,
    byPerson,
    pin,
    touch,
    stats,
    all,
    flush,
    close,
    kvGet,
    kvSet,
    kvKeys,
    file,
    kind: 'sqlite',
  }
}
