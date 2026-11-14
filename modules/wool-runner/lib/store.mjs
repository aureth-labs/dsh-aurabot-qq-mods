import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const DEFAULT_SUBSCRIPTIONS = [
  {
    id: 'jdpro', name: '京东脚本 · jdpro', url: 'https://github.com/cyuni1996/jdpro.git', branch: 'main',
    whitelist: '(^|/)(jd_|jx_|jddj_)', blacklist: 'backUp|(^|/)(tools|tests|docs|docker)/',
    dependences: '(^|/)jd[^_]|USER|JD|(^|/)function/|sendNotify|(^|/)notify\\.py$|(^|/)utils/|(^|/)package(-lock)?\\.json$|(^|/)requirements\\.txt$',
    extensions: 'js py sh', enabled: true, autoAddCron: true, autoDelCron: true,
  },
  {
    id: 'smzdm', name: '什么值得买 · smzdm_script', url: 'https://github.com/hex-ci/smzdm_script.git', branch: 'main',
    whitelist: 'smzdm_', blacklist: '', dependences: 'env.js|bot.js|sendNotify.js|library_',
    extensions: 'js', enabled: true, autoAddCron: true, autoDelCron: true,
  },
  {
    id: 'ql-public', name: '公共签到 · QLScriptPublic', url: 'https://github.com/smallfawn/QLScriptPublic.git', branch: 'main',
    whitelist: '', blacklist: '(^|/)(docs|images?|node_modules)/', dependences: 'sendNotify|package(-lock)?\\.json$|requirements\\.txt$',
    extensions: 'js py', enabled: true, autoAddCron: true, autoDelCron: true,
  },
]

const clone = (v) => JSON.parse(JSON.stringify(v))
const atomic = (file, value) => {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  try { chmodSync(file, 0o600) } catch {}
}
const read = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return clone(fallback) }
}

export function createStore(root) {
  mkdirSync(root, { recursive: true })
  const stateFile = join(root, 'state.json')
  const envFile = join(root, 'env.json')
  const runsFile = join(root, 'runs.json')
  let state = read(stateFile, { subscriptions: DEFAULT_SUBSCRIPTIONS, tasks: [] })
  let env = read(envFile, [])
  let runs = read(runsFile, [])
  if (!Array.isArray(state.subscriptions)) state.subscriptions = clone(DEFAULT_SUBSCRIPTIONS)
  if (!Array.isArray(state.tasks)) state.tasks = []
  for (const base of DEFAULT_SUBSCRIPTIONS) {
    if (!state.subscriptions.some((s) => s.id === base.id)) state.subscriptions.push(clone(base))
  }
  if (!Array.isArray(env)) env = []
  if (!Array.isArray(runs)) runs = []
  // 一次性迁移：早期版本 autoAddCron/autoDelCron 默认关闭，导致「立即同步」既不建任务也不清理旧任务。
  // 只对旧版本存下来的订阅做升级（schemaVersion < 3）；用户显式保存过的订阅（有 updatedAt）保持原值。
  for (const item of state.subscriptions) {
    if (item.schemaVersion >= 3) continue
    const userSaved = Boolean(item.updatedAt)
    if (typeof item.autoAddCron !== 'boolean') item.autoAddCron = true
    else if (item.autoAddCron === false && !userSaved) item.autoAddCron = true
    if (typeof item.autoDelCron !== 'boolean') item.autoDelCron = true
    else if (item.autoDelCron === false && !userSaved) item.autoDelCron = true
    item.schemaVersion = 3
  }
  const saveState = () => atomic(stateFile, state)
  const saveEnv = () => atomic(envFile, env)
  const saveRuns = () => atomic(runsFile, runs.slice(0, 200))
  saveState(); saveEnv(); saveRuns()

  return {
    root,
    state: () => state,
    saveState,
    runs: () => runs,
    saveRuns,
    addRun(run) { runs.unshift(run); runs = runs.slice(0, 200); saveRuns(); return run },
    updateRun(id, patch) { const r = runs.find((x) => x.id === id); if (r) Object.assign(r, patch); saveRuns(); return r },
    envList: () => env.map(({ id, name, remarks, createdAt, updatedAt }) => ({ id, name, remarks, createdAt, updatedAt, configured: true })),
    envValues(names = null) {
      const out = {}
      const allowed = names === null ? null : new Set(names)
      for (const item of env) {
        if (allowed && !allowed.has(item.name)) continue
        out[item.name] = out[item.name] ? `${out[item.name]}&${item.value}` : item.value
      }
      return out
    },
    envSecrets: () => env.map((x) => String(x.value || '')).filter(Boolean),
    upsertEnv({ id, name, value, remarks = '' }) {
      name = String(name || '').trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('变量名只能包含字母、数字、下划线，且不能以数字开头')
      if (!String(value || '').trim()) throw new Error('变量值不能为空')
      const now = new Date().toISOString()
      let item = id ? env.find((x) => x.id === id) : null
      if (!item) { item = { id: randomUUID(), createdAt: now }; env.push(item) }
      Object.assign(item, { name, value: String(value).trim(), remarks: String(remarks || '').slice(0, 200), updatedAt: now })
      saveEnv()
      return { id: item.id, name: item.name, configured: true }
    },
    removeEnv(id) { const before = env.length; env = env.filter((x) => x.id !== id); if (env.length === before) throw new Error('环境变量不存在'); saveEnv() },
    addSubscription(input) {
      const id = String(input.id || randomUUID().slice(0, 8)).toLowerCase()
      if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) throw new Error('订阅 id 格式不正确')
      if (state.subscriptions.some((s) => s.id === id)) throw new Error('订阅 id 已存在')
      const item = normalizeSubscription({ ...input, id })
      state.subscriptions.push(item); saveState(); return item
    },
    updateSubscription(id, patch) {
      const item = state.subscriptions.find((s) => s.id === id)
      if (!item) throw new Error('订阅不存在')
      const next = normalizeSubscription({ ...item, ...patch, id })
      const sourceChanged = next.url !== item.url || next.branch !== item.branch
      Object.assign(item, next)
      if (sourceChanged) {
        for (const task of state.tasks.filter((t) => t.subscriptionId === id)) {
          task.enabled = false
          task.approval = null
          task.revokedReason = '订阅地址或分支已变化，请重新审查并确认'
        }
      }
      saveState(); return item
    },
    revokeTasks(id, reason = '源码已变化，请重新审查并确认') {
      let count = 0
      for (const task of state.tasks.filter((t) => t.subscriptionId === id)) {
        if (task.enabled || task.approval) count++
        task.enabled = false
        task.approval = null
        task.revokedReason = reason
      }
      saveState(); return count
    },
    removeSubscription(id) {
      const item = state.subscriptions.find((s) => s.id === id)
      if (!item) throw new Error('订阅不存在')
      state.subscriptions = state.subscriptions.filter((s) => s.id !== id)
      state.tasks = state.tasks.filter((t) => t.subscriptionId !== id)
      saveState(); return item
    },
    upsertTask(task) {
      let item = task.id && state.tasks.find((t) => t.id === task.id)
      if (!item) { item = { id: task.id || randomUUID(), createdAt: new Date().toISOString() }; state.tasks.push(item) }
      Object.assign(item, task, { updatedAt: new Date().toISOString() })
      saveState(); return item
    },
    removeTask(id) { state.tasks = state.tasks.filter((t) => t.id !== id); saveState() },
  }
}

export function normalizeSubscription(s) {
  const url = String(s.url || '').trim()
  if (!/^https:\/\/[^\s]+\.git$/i.test(url)) throw new Error('订阅地址必须是 https:// 开头的 .git 地址')
  const parsed = new URL(url)
  if (parsed.username || parsed.password) throw new Error('订阅地址不能包含账号、密码或访问令牌')
  return {
    id: s.id, name: String(s.name || s.id).slice(0, 80), url,
    branch: String(s.branch || 'main').replace(/[^\w./-]/g, ''),
    whitelist: String(s.whitelist || '').slice(0, 500), blacklist: String(s.blacklist || '').slice(0, 500),
    dependences: String(s.dependences || '').slice(0, 500), extensions: String(s.extensions || 'js py sh').slice(0, 50),
    enabled: s.enabled !== false, autoAddCron: typeof s.autoAddCron === 'boolean' ? s.autoAddCron : true, autoDelCron: typeof s.autoDelCron === 'boolean' ? s.autoDelCron : true,
    lastSyncAt: s.lastSyncAt || '', lastSyncStatus: s.lastSyncStatus || 'never', lastSyncMessage: s.lastSyncMessage || '',
    commit: s.commit || '', schemaVersion: s.schemaVersion >= 3 ? 3 : 1,
  }
}

export function publicState(store, runtime = new Map()) {
  const state = store.state()
  return {
    subscriptions: state.subscriptions,
    tasks: state.tasks.map((t) => ({ ...t, running: runtime.get(t.id)?.status === 'running', pid: runtime.get(t.id)?.pid || null })),
    env: store.envList(),
    runs: store.runs().slice(0, 100),
  }
}
