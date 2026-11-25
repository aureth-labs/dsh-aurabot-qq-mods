/**
 * 把插件记忆库同步进咱们自己的总库（2026-11-21 第一步）
 *
 * 干什么：
 *   以「只读」方式打开插件的 memory.sqlite，把 items / kv / meta 抄进咱们的库。
 *   插件那边一个字都不改，抄完它照样用。
 *
 * 抄哪些：
 *   items          —— 全部（连已下架的也抄，下架信息在 json 的 invalidAt 里）
 *   kv             —— 全部（profiles 人物档案、relations 关系、styles 说话方式都在里面）
 *   meta           —— 全部
 *   memory_links   —— 不抄。它是按人查的索引，模块有了 about 字段就够用，
 *                     等真接管那天再考虑。
 *
 * 怎么判断新老：
 *   按 id 对比。插件有、我们没有 → 抄进来
 *             两边都有、但插件那边的 json 变了 → 覆盖成插件的
 *             我们没有的 id 不删（那是模块自己攒的，比如抖音、热榜那些）
 *
 * 什么时候跑：
 *   1. 模块启动后过一会儿自动跑一次
 *   2. 之后每小时跑一次（增量）
 *   3. 也能手动调 POST /sync/run
 */

import { DatabaseSync } from 'node:sqlite'

import { findPluginDb } from './wrap.mjs'
export { findPluginDb }

/**
 * 把这几个「用着用着会变」的字段抹掉，用来比较内容有没有变。
 *
 * 为什么：hits（被读写多少次）、hitDays（多少天用过）、lastHit（最后一次用）这三个，
 * 插件和模块各算各的，差一两个很正常。带着它们比，会误判成「内容变了」，
 * 每次同步都把这几条重写一遍，纯属白费力气。
 *
 * 做法：比较前先把这几个字段从对象里摘掉，序列化后再比。
 * 写进去的还是原样的插件数据（计数也照抄），只是「要不要写」这个判断不看它们。
 */
function normalizeForCompare(jsonStr) {
  try {
    const d = JSON.parse(jsonStr)
    delete d.hits
    delete d.hitDays
    delete d.lastHit
    delete d._lastHitDay
    return JSON.stringify(d)
  } catch {
    return jsonStr
  }
}

/**
 * 同步一次。
 *
 * @param {object} opts
 * @param {string} opts.pluginDb 插件库路径
 * @param {object} opts.store 模块的 store（要有文件路径和写能力）
 * @param {string} opts.targetDb 咱们的库路径
 * @param {object} [opts.log]
 * @returns {{ ok: boolean, added: number, updated: number, total: number, message?: string }}
 */
export function syncFromPlugin({ pluginDb, targetDb, log } = {}) {
  if (!pluginDb || !targetDb) return { ok: false, added: 0, updated: 0, total: 0, message: '没给路径' }

  let src
  try {
    // 只读打开，绝不改插件的库
    src = new DatabaseSync(pluginDb, { readOnly: true })
  } catch (error) {
    return { ok: false, added: 0, updated: 0, total: 0, message: '打不开插件库：' + error.message }
  }

  let dst
  let added = 0
  let updated = 0
  let unchanged = 0

  try {
    // 先把插件那边的东西全读出来（读的时候还开着源连接）
    const srcItems = []
    try {
      for (const r of src.prepare('SELECT id, json FROM items').all()) {
        srcItems.push({ id: String(r.id), json: String(r.json) })
      }
    } catch (error) {
      return { ok: false, added: 0, updated: 0, total: 0, message: '读插件 items 失败：' + error.message }
    }

    const srcKv = []
    try {
      for (const r of src.prepare('SELECT key, json FROM kv').all()) srcKv.push({ key: String(r.key), json: String(r.json) })
    } catch {
      /* 没 kv 表就算了 */
    }

    const srcMeta = []
    try {
      for (const r of src.prepare('SELECT key, json FROM meta').all()) srcMeta.push({ key: String(r.key), json: String(r.json) })
    } catch {
      /* 没 meta 表就算了 */
    }

    // 源库读完，关掉，别占着文件
    try {
      src.close()
    } catch {}
    src = null

    // 打开咱们的库
    dst = new DatabaseSync(targetDb)
    dst.exec('PRAGMA journal_mode = WAL')
    dst.exec('PRAGMA busy_timeout = 5000')

    // 确保表在
    dst.exec(`
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gists (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    `)

    // 现有 id → json 快照，用来判断要不要覆盖
    const existing = new Map()
    for (const r of dst.prepare('SELECT id, json FROM items').all()) existing.set(String(r.id), String(r.json))

    dst.exec('BEGIN IMMEDIATE')
    try {
      const put = dst.prepare('INSERT INTO items (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      for (const it of srcItems) {
        const old = existing.get(it.id)
        if (old === undefined) {
          // 新的一条，直接抄
          put.run(it.id, it.json)
          added++
        } else if (normalizeForCompare(old) !== normalizeForCompare(it.json)) {
          // 内容真的变了才写
          put.run(it.id, it.json)
          updated++
        } else {
          unchanged++
        }
      }

      if (srcKv.length) {
        const putKv = dst.prepare('INSERT INTO kv (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json')
        for (const r of srcKv) putKv.run(r.key, r.json)
      }
      if (srcMeta.length) {
        const putMeta = dst.prepare('INSERT INTO meta (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json')
        for (const r of srcMeta) putMeta.run(r.key, r.json)
      }

      dst.exec('COMMIT')
    } catch (error) {
      try {
        dst.exec('ROLLBACK')
      } catch {}
      return { ok: false, added: 0, updated: 0, total: 0, message: '写入失败：' + error.message }
    }

    const total = Number(dst.prepare('SELECT COUNT(*) AS n FROM items').get()?.n) || 0
    log?.info?.(
      '[memory-grade] 同步插件记忆：新增 ' + added + '，更新 ' + updated + '，没变 ' + unchanged + '，总库现在 ' + total + ' 条',
    )
    return { ok: true, added, updated, unchanged, total }
  } catch (error) {
    return { ok: false, added: 0, updated: 0, total: 0, message: error.message }
  } finally {
    try {
      src?.close()
    } catch {}
    try {
      dst?.close()
    } catch {}
  }
}
