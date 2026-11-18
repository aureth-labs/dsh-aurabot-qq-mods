/**
 * 记忆库存储层。
 *
 * 存成一个 JSON 文件，放 api.dataDir()。几千条完全够用，也不需要编译原生模块。
 * 每次改完立刻落盘（先写 .tmp 再改名，半路断电不会写坏）。
 *
 * 数据形状：
 * {
 *   version: 1,
 *   items: [ { id, text, tags, importance, at, cls, gua, pin, ... } ],
 *   order: [ 'id1', 'id2', ... ]      // 面板上的排序，新的在前
 * }
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const FORMAT_VERSION = 1

/** 造一个不重复的 id：8 位十六进制 */
function newId(existing) {
  for (let i = 0; i < 50; i++) {
    const id = randomUUID().replace(/-/g, '').slice(0, 8)
    if (!existing.has(id)) return id
  }
  // 极端情况：退到更长
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/** 读一个 JSON 文件，坏了就用空库，同时留一份坏的备份 */
function readJson(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    try {
      renameSync(file, file + '.broken-' + Date.now())
    } catch {
      /* 备份失败也没关系，别把启动拖死 */
    }
    return null
  }
}

export function openStore(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, 'memory.json')

  const raw = readJson(file)
  const db = {
    version: FORMAT_VERSION,
    items: Array.isArray(raw?.items) ? raw.items : [],
    order: Array.isArray(raw?.order) ? raw.order : [],
  }

  // 老数据没 order 的，补一份
  if (!db.order.length && db.items.length) {
    db.order = db.items.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).map((x) => x.id)
  }

  const index = new Map()
  for (const it of db.items) index.set(it.id, it)

  let dirty = false
  let timer = null
  const SAVE_DELAY = 300

  /** 立刻落盘。先写临时文件，再改名，中间断了也不会留下半个文件 */
  function save() {
    if (timer) { clearTimeout(timer); timer = null }
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(db), 'utf8')
    renameSync(tmp, file)
    dirty = false
  }

  /**
   * 攒一小会儿再写。
   * 每条都立刻全量写盘的话，几千条时会慢到没法用——
   * 数据摆在那，晚 300 毫秒落盘不会丢（进程被强杀最多丢这 300 毫秒的改动）。
   */
  function saveSoon() {
    dirty = true
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      try {
        save()
      } catch {
        /* 下次再试 */
      }
    }, SAVE_DELAY)
    timer.unref?.()
  }

  /**
   * 加一条。
   * extra 里可以带 cls（密级）、gua（卦位）、tags、importance 等，
   * 没带的留空，由调用方决定要不要补。
   */
  function add(text, extra = {}) {
    const t = String(text || '').trim()
    if (!t) return null
    const now = Date.now()
    const item = {
      id: newId(index),
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
    db.items.push(item)
    db.order.unshift(item.id)
    index.set(item.id, item)
    saveSoon()
    return item
  }

  function get(id) {
    return index.get(String(id || '')) || null
  }

  /** 改一条。不允许改 id。 */
  function update(id, patch = {}) {
    const item = get(id)
    if (!item) return null
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') continue
      item[k] = v
    }
    saveSoon()
    return item
  }

  function remove(id) {
    const key = String(id || '')
    const item = index.get(key)
    if (!item) return false
    index.delete(key)
    const i = db.items.indexOf(item)
    if (i >= 0) db.items.splice(i, 1)
    const j = db.order.indexOf(key)
    if (j >= 0) db.order.splice(j, 1)
    saveSoon()
    return true
  }

  /** 按内部顺序列出来（order 里的先后） */
  function list({ limit = 50, offset = 0, cls, tag, pin } = {}) {
    const out = []
    for (const id of db.order) {
      const it = index.get(id)
      if (!it) continue
      if (cls && it.cls !== cls) continue
      if (tag && !(it.tags || []).includes(tag)) continue
      if (pin === true && !it.pin) continue
      if (pin === false && it.pin) continue
      out.push(it)
    }
    return out.slice(offset, offset + limit)
  }

  /**
   * 关键词检索。
   * 打分：整句包含 > 所有词都出现 > 出现一部分。
   * 再按重要度、命中的词数、时间衰减加一点权重。
   */
  function search(query, { limit = 20, cls, tag, includeArchived = false, includeSleeping = true } = {}) {
    const q = String(query || '').trim()
    if (!q) return []
    const words = q.split(/[\s,，、]+/).filter(Boolean)
    const now = Date.now()
    const scored = []

    for (const it of db.items) {
      if (cls && it.cls !== cls) continue
      if (tag && !(it.tags || []).includes(tag)) continue
      // 归档的默认不参与检索；休眠的可以，但排在后面看分数
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
      // 时间衰减：越久越轻，但一年内影响不超过 5 分
      const ageDays = (now - (it.at || now)) / 86400000
      score += Math.max(0, 5 - ageDays / 73)
      scored.push({ item: it, score })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((x) => ({ ...x.item, _score: Math.round(x.score * 10) / 10 }))
  }

  /** 置顶 / 取消置顶 */
  function pin(id, on = true, order = 0) {
    const item = get(id)
    if (!item) return null
    item.pin = !!on
    item.pinOrder = on ? order : 0
    saveSoon()
    return item
  }

  /** 记一次命中，用于看哪条常被用到 */
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
    saveSoon()
    return item
  }

  function stats() {
    const byCls = {}
    const byTag = {}
    let pinned = 0
    for (const it of db.items) {
      byCls[it.cls || 'internal'] = (byCls[it.cls || 'internal'] || 0) + 1
      if (it.pin) pinned++
      for (const t of it.tags || []) byTag[t] = (byTag[t] || 0) + 1
    }
    return { total: db.items.length, pinned, byCls, byTag }
  }

  function all() {
    return db.items.slice()
  }

  function flush() {
    save()
  }

  return { add, get, update, remove, list, search, pin, touch, stats, all, flush, file }
}
