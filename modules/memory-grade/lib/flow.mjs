/**
 * 对话流水（实时层）。
 *
 * 存最近几十小时的原话，只为「刚发生了什么」服务：反应要快，不用提炼、不做摘要。
 * 长期记忆还是走 store.mjs（记忆总库）。两边各管一段，互不干扰。
 *
 * 为什么不复用别人的库：跨会话记忆插件的 vault 是它的，用户没装就什么都没有，
 * 它更新还可能覆盖我们的改动。所以自己建一份，跟着本模块走。
 *
 * 数据用 JSONL（一行一条），追加写、定期压掉旧的：
 *   - 追加是 O(1)，比每次整库重写稳；断电最多丢最后一行
 *   - 几小时内几千条，读全量也就几 MB，够用
 *
 * 每条形状：
 *   { t, chatId, dir: 'in'|'out', who, uid, text, digested: 0|1 }
 *   digested=0 表示还没被总库提炼过，清理时一律留着
 */

import { readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'dialogue-flow.jsonl'
const TEXT_MAX = 600

/**
 * 打开流水库。
 * @param {string} dir  模块数据目录（api.dataDir()）
 * @param {{ now?: () => number }} [opts]
 */
export function openFlow(dir, opts = {}) {
  const now = opts.now || Date.now
  // 2026-11-25 修：原来这里没取 opts.classify，record() 里的 classify(...)
  // 实际调的是 undefined，每次抛 TypeError 被 catch 吞成 'internal'。
  // 结果就是流水里几乎所有记录都是 internal，密级等于没盖。
  const classify = typeof opts.classify === 'function' ? opts.classify : () => 'internal'
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 建不出来就让后面的读写自己失败，别把模块启动拖死 */
  }
  const file = join(dir, FILE)

  /** 内存里缓存一份，免得每轮注入都读盘 */
  let cache = null
  let cacheMtime = 0

  function loadAll() {
    if (!existsSync(file)) {
      cache = []
      cacheMtime = 0
      return cache
    }
    let mtime = 0
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      mtime = 0
    }
    if (cache && mtime === cacheMtime) return cache
    const out = []
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      raw = ''
    }
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        const o = JSON.parse(s)
        if (o && Number.isFinite(o.t)) out.push(o)
      } catch {
        /* 坏行跳过，别因为一行坏了整库读不出来 */
      }
    }
    cache = out
    cacheMtime = mtime
    return out
  }

  /** 一条正文清干净：压空白、裁长度 */
  function cleanText(text) {
    return String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, TEXT_MAX)
  }

  /**
   * 记一条。
   * @param {{ chatId?: string, dir?: string, who?: string, uid?: string, text?: string, t?: number }} row
   * @returns {boolean} 记进去了没有
   */
  function record(row) {
    const chatId = String(row?.chatId || '').trim()
    const text = cleanText(row?.text)
    if (!chatId || !text) return false
    if (chatId.startsWith('system:')) return false // 后台自省回合没有价值
    const item = {
      t: Number(row?.t) || now(),
      chatId,
      dir: row?.dir === 'out' ? 'out' : 'in',
      who: String(row?.who || '').slice(0, 40),
      uid: String(row?.uid || '').slice(0, 20),
      text,
      digested: 0,
      // 2026-11-24 爸爸定：每条进库就盖密级，拼上下文时按它筛
      cls: (() => {
        try {
          return classify({ text, tags: [], chatId })
        } catch {
          return 'internal'
        }
      })(),
    }
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(file, JSON.stringify(item) + '\n', 'utf8')
      if (cache) cache.push(item)
      cacheMtime = 0 // 让下次读盘重新对齐
      return true
    } catch {
      return false
    }
  }

  /** 取一段时间内的：sinceMs 起、可以排除某个会话 */
  function recent({ minutes = 40, excludeChatId = '', limit = 400 } = {}) {
    const since = now() - Math.max(1, minutes) * 60 * 1000
    const all = loadAll()
    const out = []
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const r = all[i]
      if (r.t < since) break // 是追加顺序，可以早停
      if (excludeChatId && r.chatId === excludeChatId) continue
      out.push(r)
    }
    return out.reverse()
  }

  /**
   * 清旧记录：只删「已提炼过」且超过保留天数的。
   * 没提炼过的一律留着，哪怕过了很久——这样提炼脚本挂几天也不会丢料。
   * @returns {{ removed: number, kept: number }}
   */
  function prune({ keepDays = 3, force = false, dropUndigested = null } = {}) {
    const all = loadAll()
    if (!all.length) return { removed: 0, kept: 0 }
    const cutoff = now() - Math.max(1, keepDays) * 24 * 60 * 60 * 1000
    // 2026-11-24 爸爸定：过了保留天数，不管有没有提炼进总库，都清掉。
    // dropUndigested 传 true 就是「没提炼的也删」，默认 false 保持老行为。
    const dropAll = force || dropUndigested === true
    const kept = []
    let removed = 0
    for (const r of all) {
      const old = r.t < cutoff
      const canDrop = dropAll || (r.digested === 1 && old)
      if (old && canDrop) {
        removed++
        continue
      }
      kept.push(r)
    }
    if (removed) {
      const tmp = file + '.tmp'
      writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf8')
      renameSync(tmp, file)
      cache = kept
      cacheMtime = 0
    }
    return { removed, kept: kept.length }
  }

  /** 把某些记录标成「已提炼」。传时间范围最方便：summary 跑完把那段标掉 */
  function markDigested({ beforeMs, chatId = '' } = {}) {
    const all = loadAll()
    let n = 0
    for (const r of all) {
      if (r.digested === 1) continue
      if (beforeMs && r.t >= beforeMs) continue
      if (chatId && r.chatId !== chatId) continue
      r.digested = 1
      n++
    }
    if (n) {
      const tmp = file + '.tmp'
      writeFileSync(tmp, all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''), 'utf8')
      renameSync(tmp, file)
      cache = all
      cacheMtime = 0
    }
    return n
  }

  /**
   * 把一个会话的一批流水按时间拼成给模型看的文本（给总库提炼用）。
   */
  function digestInput(rows) {
    return (rows || [])
      .map((r) => {
        const hh = new Date(r.t).toTimeString().slice(0, 5)
        const who = r.dir === 'out' ? '她' : (r.who || '对方')
        return `${hh} ${who}：${r.text}`
      })
      .join('\n')
  }

  /** 统计：条数、最老的时间、还没提炼的条数 */
  function stats() {
    const all = loadAll()
    const undigested = all.filter((r) => r.digested !== 1).length
    return {
      total: all.length,
      undigested,
      oldest: all.length ? all[0].t : 0,
      newest: all.length ? all[all.length - 1].t : 0,
      file,
    }
  }

  return { record, recent, prune, markDigested, digestInput, stats, loadAll, cleanText, file }
}

/**
 * 把别的会话的最近流水压成注入块（纯函数，方便单测）。
 *
 * 爸爸 2026-11-20 定的边界：家里的事哪个群都不说、爸爸私聊的话别处不传、
 * 群友私下说的不带到别的群。这几条写死在框里，让模型自己守。
 *
 * @param {Array} rows  recent() 的结果
 * @param {{ maxChars?: number, perChat?: number }} [opts]
 */
export function renderRecent(rows, { maxChars = 600, perChat = 4, allowCls = null, selfChatId = '' } = {}) {
  let list = Array.isArray(rows) ? rows : []
  if (!list.length) return ''

  // 2026-11-24 爸爸定：实时大脑拼上下文时按密级兜底。
  // secret 的一律不往别处带（只有当前就在这条私聊里时才留）；
  // internal 的也只在对应会话里留，不跨会话乱跑；public 的可以带。
  if (Array.isArray(allowCls) && allowCls.length) {
    const self = String(selfChatId || '')
    list = list.filter((r) => {
      const c = r && r.cls ? r.cls : 'internal'
      if (!allowCls.includes(c)) return false
      // secret：只有发在这条会话里的才留
      if (c === 'secret') return String(r.chatId || '') === self
      return true
    })
    if (!list.length) return ''
  }

  const JUNK = /^\[(表情|图片|文件|视频|语音)\]$/
  const byChat = new Map()
  for (const r of list) {
    if (!r?.chatId) continue
    const t = String(r.text || '').trim()
    if (!t || JUNK.test(t)) continue
    if (!byChat.has(r.chatId)) byChat.set(r.chatId, [])
    byChat.get(r.chatId).push(r)
  }
  if (!byChat.size) return ''

  const lines = []
  for (const [chatId, arr] of byChat) {
    const label = chatId.startsWith('group:')
      ? `群 ${chatId.slice(6)}`
      : chatId.startsWith('private:')
        ? `私聊 ${chatId.slice(8)}`
        : chatId
    const tail = arr.slice(-Math.max(1, perChat))
    const body = tail
      .map((r) => {
        const who = r.dir === 'out' ? '我' : (r.who || '对方')
        return `  ${who}：${String(r.text).slice(0, 45)}`
      })
      .join('\n')
    const mins = Math.max(1, Math.round((Date.now() - arr[0].t) / 60000))
    lines.push(`【${label}】近 ${mins} 分钟 ${arr.length} 条\n${body}`)
  }

  let text = lines.join('\n')
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n  ……'

  return (
    '【我知道的别处近况】（这些是别的会话里刚发生的事。我知道，但绝不原样复述出去——' +
    '不把爸爸私聊里的话带到别处，不把群友私下说的带到别的群，家里的事哪个群都不说）\n' +
    text
  )
}
