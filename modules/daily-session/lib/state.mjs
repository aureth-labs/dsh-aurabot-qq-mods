// 状态持久化：每个聊天记上次重置的周期、昨日摘要、已注入过的会话。
// 写到 api.dataDir()/state.json，临时文件 + rename 落盘，避免半截 JSON。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const VERSION = 1

export function emptyState() {
  return { version: VERSION, chats: {} }
}

export function loadState(path, log) {
  try {
    if (!existsSync(path)) return emptyState()
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || !raw.chats || typeof raw.chats !== 'object' || Array.isArray(raw.chats)) {
      return emptyState()
    }
    return { version: VERSION, chats: raw.chats }
  } catch (error) {
    log?.warn?.('每日会话拆分：读状态失败，按空状态启动：', error?.message || error)
    return emptyState()
  }
}

export function saveState(path, state, log) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, path)
    return true
  } catch (error) {
    log?.warn?.('每日会话拆分：保存状态失败：', error?.message || error)
    return false
  }
}

/** 取（必要时初始化）某个聊天的记录。 */
export function chatRecord(state, chatId) {
  const id = String(chatId || '')
  let rec = state.chats[id]
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    rec = { lastPeriod: '', lastResetAt: 0, digest: null, injected: {} }
    state.chats[id] = rec
  }
  if (!rec.injected || typeof rec.injected !== 'object' || Array.isArray(rec.injected)) rec.injected = {}
  return rec
}

/** 记下某个会话已经注入过哪天的摘要；只留最近 3 条，防止状态无限长大。 */
export function rememberInjection(rec, sessionId, day) {
  const sid = String(sessionId || '')
  if (!sid) return
  const next = { [sid]: String(day || '') }
  for (const [key, value] of Object.entries(rec.injected || {})) {
    if (key !== sid) next[key] = value
  }
  const keys = Object.keys(next)
  if (keys.length > 3) for (const key of keys.slice(0, keys.length - 3)) delete next[key]
  rec.injected = next
}
