// 她自己的待办本子：跨对话共享，到点了把念头送到指定的聊天去。
//
// 每条待办的结构（用户定的格式）：
//   来源对话 | 具体念头及原因 | 目的对话 | 具体时间点 | 次数
// 例：
//   private:123|想起来问问他作业写完没|private:456|14:30|3
//
// 规则：
//   · 时间点只写几点几分（HH:MM），另有一个日期字段兜底；只有 now >= 该时刻才触发
//   · 每触发一次，次数减一；减到 0 就把这条踢出去
//   · 次数写 -1 表示每天重复（永不减完）
//   · 过期很久的照样触发（当成"今天已经过了，明天同一时刻再来"）
//   · 后台每分钟扫描一次

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_TASKS = 300

function newId() {
  return Math.random().toString(16).slice(2, 10)
}

/** 补零 */
const p2 = (n) => String(n).padStart(2, '0')

/** 今天/指定日期的 YYYY-MM-DD */
function ymd(d = new Date()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/** 解析 "14:30" 或 "14：30" 或 "2:5" */
function parseHHMM(text) {
  const m = String(text || '').trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  return { h, mi }
}

/** 把「日期 + 时分」变成时间戳 */
function stampOf(dateStr, hm) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? dateStr : ymd()
  const [y, mo, d] = base.split('-').map(Number)
  const t = new Date(y, mo - 1, d, hm.h, hm.mi, 0, 0)
  return t.getTime()
}

/**
 * 待办本子。
 * @param {string} file 存哪儿
 * @param {(msg: string) => void} log
 */
export function createTodoBook(file, log) {
  let book = { rev: 0, items: [] }

  const load = () => {
    try {
      const raw = readJsonSafe(file)
      if (raw && Array.isArray(raw.items)) book = raw
    } catch (error) {}
    return book
  }

  const save = () => {
    try {
      book.rev = (book.rev || 0) + 1
      writeJsonSafe(file, book)
    } catch (error) {
      log?.('待办保存失败：' + (error?.message || error))
    }
  }

  load()

  function prune() {
    const now = Date.now()
    book.items = book.items.filter((t) => {
      if (t.state === 'done' || t.state === 'dropped') return now - (t.updatedAt || 0) < 30 * 86400_000
      return true
    })
    if (book.items.length > MAX_TASKS) book.items = book.items.slice(-MAX_TASKS)
  }

  /** 还活着的（没做完、没作废） */
  function openItems() {
    return book.items.filter((t) => t.state === 'open')
  }

  /**
   * 加一条。
   * input: { from, thought, to, time (HH:MM), date?, times (次数，-1=每天), gapMs?, about? }
   * 也接受一行原文 raw："来源|念头|目的|14:30|3|5"（第六段为重复间隔分钟，可省略）
   */
  function add(input) {
    let src = input || {}

    // 支持一整行文本
    if (typeof input === 'string' || (input && typeof input.raw === 'string')) {
      const line = String(typeof input === 'string' ? input : input.raw || '').trim()
      const parts = line.split('|').map((s) => s.trim())
      if (parts.length < 4) {
        return { ok: false, message: '格式是：来源对话|念头|目的对话|时间(HH:MM)|次数（次数可省略，写 -1 表示每天）' }
      }
      src = {
        from: parts[0],
        thought: parts[1],
        to: parts[2],
        time: parts[3],
        times: parts[4] !== undefined && parts[4] !== '' ? Number(parts[4]) : 1,
        gapMs: parts[5] !== undefined && parts[5] !== '' ? Number(parts[5]) * 60_000 : undefined,
      }
    }

    const thought = String(src.thought || src.text || '').trim()
    if (!thought) return { ok: false, message: '要写清楚是什么念头（第二段）' }

    const to = String(src.to || src.chatId || '').trim()
    if (!/^(private|group):\S+$/.test(to)) return { ok: false, message: '目的对话要写成 private:QQ号 或 group:群号（第三段）' }

    const rawTime = String(src.time || src.at || '').trim()
    const immediate = !rawTime || rawTime === '0'
    const hm = immediate ? null : parseHHMM(rawTime)
    if (!immediate && !hm) return { ok: false, message: '时间请写成 14:30，或填 0 表示立即执行' }

    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(src.date || '')) ? String(src.date) : ymd()
    let at = immediate ? Date.now() : stampOf(dateStr, hm)

    // 次数：-1 表示每天；否则至少 1
    let times = Number(src.times)
    if (!Number.isFinite(times)) times = 1
    if (times !== -1) times = Math.max(1, Math.floor(times))

    // 间隔：隔多久再来一次。默认 1 分钟；每天重复时是 24 小时
    let gapMs = Number(src.gapMs)
    if (!Number.isFinite(gapMs) || gapMs <= 0) gapMs = (times === -1 ? 86400_000 : 60_000)

    const now = Date.now()
    const item = {
      id: newId(),
      from: String(src.from || '').trim(),
      thought: thought.slice(0, 200),
      to,
      at,
      date: dateStr,
      hhmm: hm ? `${p2(hm.h)}:${p2(hm.mi)}` : '立即',
      times,
      gapMs,
      repeatDaily: times === -1,
      state: 'open',
      sentCount: 0,
      lastSentAt: 0,
      about: String(src.about || '').slice(0, 40),
      createdAt: now,
      updatedAt: now,
    }

    book.items.push(item)
    prune()
    save()
    return { ok: true, message: hm ? `记下了：${item.hhmm} 去 ${to} 说「${item.thought.slice(0, 20)}」${item.repeatDaily ? '（每天）' : `（还有 ${item.times} 次）`}` : `已安排立即执行：${to} · ${item.thought.slice(0, 40)}（已排队，不代表已经完成）`, item }
  }

  /** 按关键词找 */
  function find(match, canAccess = () => true) {
    load()
    const key = String(match || '').trim()
    if (!key) return { hit: null, many: [] }
    const list = openItems().filter((t) => canAccess(t) && (t.thought.includes(key) || t.id === key || t.to.includes(key) || t.from.includes(key)))
    if (list.length === 1) return { hit: list[0], many: [] }
    return { hit: null, many: list }
  }

  function update(id, patch) {
    const item = book.items.find((t) => t.id === id)
    if (!item) return null
    Object.assign(item, patch, { updatedAt: Date.now() })
    save()
    return item
  }

  function done(match, canAccess) {
    const { hit, many } = find(match, canAccess)
    if (many.length) return { ok: false, message: '有几条都对得上，是哪条？', many: many.map((t) => ({ id: t.id, thought: t.thought })) }
    if (!hit) return { ok: false, message: '没找着这条' }
    update(hit.id, { state: 'done' })
    return { ok: true, message: '这条划掉了', item: hit }
  }

  function drop(match, canAccess) {
    const { hit } = find(match, canAccess)
    if (!hit) return { ok: false, message: '没找着这条' }
    update(hit.id, { state: 'dropped' })
    return { ok: true, message: '这条不做了', item: hit }
  }

  /**
   * 到点的条目（每次扫描调用）。
   * 返回 [{ item, to, thought }]，调用方负责把念头送去 item.to。
   *
   * 触发规则：
   *   · now >= item.at 才触发
   *   · 每天重复（times = -1）：触发后把日期推到明天同一时刻，次数不减
   *   · 普通条目：次数减一，减到 0 就标记 done（踢出）
   *   · 已经过去很久的照样补一次，然后按上面推进
   */
  function takeDue(now = Date.now()) {
    load()
    const out = []
    for (const t of openItems()) {
      if (!t.at) continue
      if (t.at > now) continue // 还没到

      out.push(t)

      if (t.repeatDaily || t.times === -1) {
        // 每天：推到明天同一时刻（如果还是过去，继续往后推）
        let next = t.at
        while (next <= now) next += 86400_000
        t.at = next
        t.date = ymd(new Date(next))
      } else {
        t.times = Math.max(0, Number(t.times) - 1)
        if (t.times <= 0) {
          t.state = 'done'
        } else {
          // 还有次数：按间隔往后推（间隔默认 1 分钟）
          const gap = Math.max(1000, Number(t.gapMs) || 60_000)
          let next = t.at + gap
          while (next <= now) next += gap
          t.at = next
          t.date = ymd(new Date(next))
        }
      }

      t.sentCount = (t.sentCount || 0) + 1
      t.lastSentAt = now
      t.updatedAt = now
    }
    if (out.length) save()
    return out.map((t) => ({ item: t, to: t.to, thought: t.thought }))
  }

  // ---------------- 定时器管理 ----------------
  // 每条待办一个自己的定时器，到点自己弹，不用轮询。
  // 开销很小：一个定时器就是一个计时器，不占 CPU。
  const timers = new Map() // id → timeout 句柄

  function clearTimer(id) {
    const t = timers.get(id)
    if (t) {
      clearTimeout(t)
      timers.delete(id)
    }
  }

  function clearAllTimers() {
    for (const [id, h] of timers) clearTimeout(h)
    timers.clear()
  }

  /**
   * 给一条待办安排下一次触发。
   * onFire(item) 到点时调用，调用方负责把念头送出去。
   */
  function scheduleOne(item, onFire) {
    clearTimer(item.id)
    if (!item || item.state !== 'open' || !item.at) return
    const delay = Math.max(0, item.at - Date.now())
    // setTimeout 上限约 24.8 天，超过就分段等待
    const MAX = 24 * 3600_000
    const wait = Math.min(delay, MAX)
    const h = setTimeout(() => {
      timers.delete(item.id)
      if (delay > MAX) {
        // 还没到，继续排
        scheduleOne(item, onFire)
        return
      }
      // 到点：重新读一次盘，确认这条还在
      load()
      const fresh = book.items.find((x) => x.id === item.id)
      if (!fresh || fresh.state !== 'open') return
      if (fresh.at > Date.now() + 2000) { scheduleOne(fresh, onFire); return }
      // 触发
      const fired = takeDue()
      for (const f of fired) {
        try { onFire?.(f) } catch (error) { log?.('待办触发失败：' + (error?.message || error)) }
        // 如果还有下次，重新排
        const again = book.items.find((x) => x.id === f.item.id)
        if (again && again.state === 'open' && again.at) scheduleOne(again, onFire)
      }
    }, wait)
    if (typeof h.unref === 'function') h.unref()
    timers.set(item.id, h)
  }

  /** 把所有还活着的待办都排上定时器（启动时、或数据变动后调用） */
  function scheduleAll(onFire) {
    load()
    clearAllTimers()
    for (const t of openItems()) scheduleOne(t, onFire)
    return timers.size
  }

  function all() {
    load()
    return book.items.slice()
  }

  return { add, find, done, drop, takeDue, openItems, all, save, load, update, scheduleAll, scheduleOne, clearTimer, clearAllTimers, timers }
}

// ---- 读写小工具 ----
function readJsonSafe(file) {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return null
  }
}

function writeJsonSafe(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, file)
  return true
}
