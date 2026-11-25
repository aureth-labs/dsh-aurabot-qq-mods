// 落盘：一律原子写（先 .tmp 再 rename），坏文件不影响插件启动。
// 计划（模式/规则/分裂表）存在模块设置里；这个文件只管每个会话的临时人格、去重标记和切换历史。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizePlan } from './plan.mjs'

const FILE = 'state.json'
export const HISTORY_MAX = 200

export function emptyState() {
  return {
    last: { timedDone: {}, monthlyKey: '', moodBand: '' },
    sessions: {},
    history: [],
  }
}

// 旧版只记了一个「今天 这个点」字符串；换成按天记的「今天跑过哪些点」。
// 返回是否真的迁移过，调用方据此把文件重写一次。
const migrateTimed = (last) => {
  if (!('timedKey' in last)) return false
  const old = last.timedKey
  if (typeof old === 'string' && old.includes(' ')) {
    const [day, at] = old.split(' ')
    if (day && at) last.timedDone = { ...(last.timedDone || {}), [day]: [at] }
  }
  delete last.timedKey
  return true
}

export function loadState(dir) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, FILE), 'utf8'))
    const base = emptyState()
    const last = { ...base.last, ...(raw?.last && typeof raw.last === 'object' ? raw.last : {}) }
    const migrated = migrateTimed(last)
    return {
      // 老版本把计划存在这里，启动时会迁到模块设置里再删掉这个字段
      plan: raw?.plan === undefined ? undefined : normalizePlan(raw.plan),
      legacyTimed: migrated,
      last,
      sessions: raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
      history: Array.isArray(raw?.history) ? raw.history.slice(-HISTORY_MAX) : [],
    }
  } catch {
    return emptyState()
  }
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, FILE + '.tmp')
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, join(dir, FILE))
}

export function pushHistory(state, entry) {
  state.history.push(entry)
  if (state.history.length > HISTORY_MAX) state.history = state.history.slice(-HISTORY_MAX)
}
