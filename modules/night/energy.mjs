// 精力与疲劳期：纯函数，不碰存储、不碰事件，方便单测。
// 时间一律按配置时区的墙上时间算（见 clock.mjs），跨午夜用「分钟数取模」处理。

import { clockText as clockTextOf, dayLabel as dayLabelOf, nowMinute as wallMinute, nextWallTime } from './clock.mjs'

export const DEFAULT_NOON = '13:00-14:30'
export const DEFAULT_NIGHT = '23:30-07:00'

const MIN = 60_000

export function parseHHMM(text) {
  if (!text) return null
  let raw = String(text).trim()
  if (raw.includes('-')) raw = raw.split('-', 1)[0]
  const parts = raw.split(':')
  if (parts.length !== 2) return null
  const hour = Number(parts[0])
  const minute = Number(parts[1])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

/** '23:30-07:00' -> [1410, 420]；空串或非法返回 null。 */
export function parseWindow(spec) {
  if (!spec) return null
  const raw = String(spec).trim()
  if (!raw || !raw.includes('-')) return null
  const [left, right] = raw.split('-', 2)
  const start = parseHHMM(left)
  const end = parseHHMM(right)
  if (start == null || end == null || start === end) return null
  return [start, end]
}

export function inWindow(nowMinute, window) {
  if (!window) return false
  const [start, end] = window
  if (start < end) return start <= nowMinute && nowMinute < end
  return nowMinute >= start || nowMinute < end
}

export function nowMinute(ts = Date.now()) {
  return wallMinute(ts)
}

/** 'noon' / 'night' / ''，夜间优先。 */
export function fatigueKind(cfg, ts = Date.now()) {
  const minute = nowMinute(ts)
  const night = parseWindow(cfg.nightFatigue || DEFAULT_NIGHT)
  const noon = parseWindow(cfg.noonFatigue || DEFAULT_NOON)
  if (inWindow(minute, night)) return 'night'
  if (inWindow(minute, noon)) return 'noon'
  return ''
}

export function inFatigue(cfg, ts = Date.now()) {
  return Boolean(fatigueKind(cfg, ts))
}

export const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, value))

export function drain(energy, { minutes = 0, messages = 0, perMinute = 0, perMessage = 0 } = {}) {
  const spend = Math.max(0, minutes) * Math.max(0, perMinute) + Math.max(0, messages) * Math.max(0, perMessage)
  return clamp(energy - spend)
}

export function recover(energy, { minutes = 0, perMinute = 0 } = {}) {
  return clamp(energy + Math.max(0, minutes) * Math.max(0, perMinute))
}

export const exhausted = (energy, threshold = 0.5) => energy <= threshold

/**
 * 这次该几点醒（毫秒时间戳）。
 * 夜里睡：固定起床点 ± 随机浮动（上限 90 分钟）。
 * 午睡：固定时长 ± 浮动，不跟夜间起床点走。
 */
export function nextWakeTime(cfg, ts = Date.now(), { kind = 'night', rng = Math.random } = {}) {
  if ((kind || 'night') === 'noon') {
    const nap = Math.max(10, Math.min(180, Number(cfg.noonNapMinutes) || 60))
    const wobble = Math.max(0, Math.min(60, Number(cfg.noonNapJitterMinutes) || 15))
    const offset = wobble ? Math.round((rng() * 2 - 1) * wobble) * MIN : 0
    return Math.round(ts + nap * MIN + offset)
  }

  const wakeMinute = parseHHMM(cfg.wakeTime || '08:00') ?? 8 * 60
  const jitter = Math.max(0, Math.min(90, Number(cfg.wakeJitterMinutes) || 0))
  // 按配置时区的墙上时间算「下一个 08:00」，不是按进程本地时区
  let target = nextWallTime(wakeMinute, ts)
  if (target <= ts) target = nextWallTime(wakeMinute, ts + 24 * 60 * MIN)
  if (jitter > 0) {
    const offset = Math.round((rng() * 2 - 1) * jitter) * MIN
    target += offset
  }
  return Math.round(Math.max(target, ts + 20 * MIN))
}

/** 「预计 07:00-09:00 醒来」这种文案。 */
export function wakeWindowText(cfg) {
  const wakeMinute = parseHHMM(cfg.wakeTime || '08:00') ?? 480
  const jitter = Math.max(0, Math.min(90, Number(cfg.wakeJitterMinutes) || 0))
  const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  if (jitter <= 0) return fmt(wakeMinute)
  return `${fmt((wakeMinute - jitter + 1440) % 1440)}-${fmt((wakeMinute + jitter) % 1440)}`
}

export function humanDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
}

export function clockText(ts) {
  return clockTextOf(ts)
}

export function dayLabel(ts) {
  return dayLabelOf(ts)
}

/** 把一段 [from, to] 按 10 分钟切片，返回 [{minutes, kind}]，用来积分能耗。 */
export function sliceByFatigue(cfg, from, to, stepMinutes = 10) {
  const out = []
  let cursor = from
  const step = Math.max(1, stepMinutes) * MIN
  while (cursor < to) {
    const end = Math.min(to, cursor + step)
    out.push({ minutes: (end - cursor) / MIN, kind: fatigueKind(cfg, cursor + (end - cursor) / 2) })
    cursor = end
  }
  return out
}
