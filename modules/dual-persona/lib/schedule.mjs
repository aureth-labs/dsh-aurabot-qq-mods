// 时间、区间、加权抽签。纯函数，方便单测。

export const atToMinutes = (at) => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(at || '').trim().padStart(5, '0'))
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

export const nowMinutes = (now) => now.getHours() * 60 + now.getMinutes()

export const dayKey = (now) => `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`

/**
 * 今天该执行、还没执行过的定时点（按时间升序）。
 * 语义是「过了就补」：不要求恰好是这一分钟，只要时间已过、今天还没跑过就算到期，
 * 这样检查间隔大、或者中间重启/卡顿，也不会把当天的档期漏掉。
 * done 是今天已经执行过的 "HH:MM" 列表。
 */
export function dueSlots(slots, now, done = []) {
  const minute = nowMinutes(now)
  const skip = new Set((done || []).map(String))
  return (slots || [])
    .filter((s) => {
      const m = atToMinutes(s && s.at)
      return m != null && m <= minute && !skip.has(String(s.at))
    })
    .sort((a, b) => atToMinutes(a.at) - atToMinutes(b.at))
}

/** 命中某个「每月第几天」，没配返回 null */
export function monthlyFor(days, now) {
  const day = String(now.getDate())
  return days && days[day] ? days[day] : null
}

/** 心情值落在哪个区间（区间按 min 升序，取第一个命中） */
export function matchBand(bands, value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return null
  for (const b of bands || []) {
    if (v >= b.min && v <= b.max) return b
  }
  return null
}

/** 按权重抽一个人格；权重全 0 或池子为空返回 null */
export function pickWeighted(pool, rand = Math.random) {
  const list = (pool || []).filter((p) => p && p.persona && Number(p.weight) > 0)
  if (!list.length) return null
  const total = list.reduce((s, p) => s + Number(p.weight), 0)
  if (!(total > 0)) return null
  let r = rand() * total
  for (const p of list) {
    r -= Number(p.weight)
    if (r < 0) return p.persona
  }
  return list[list.length - 1].persona
}

/** 先过「总概率」这道门，再按池内权重挑 */
export function rollOnce(totalPercent, pool, rand = Math.random) {
  const pct = Math.min(100, Math.max(0, Number(totalPercent) || 0))
  if (pct <= 0) return null
  if (rand() * 100 >= pct) return null
  return pickWeighted(pool, rand)
}
