// 一个够用的假 Aurabot api：事件钩子按注册顺序串成真链路，路由 / 命令 / 定时器都记下来。
// 不联网、不连 QQ；数据写在临时目录，测试之间互不影响。行为对齐 modules/feed 的 helpers 模式。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.mjs'

export const OWNER = '10000001'
// 钉死时区偏移，账本「哪天算哪天」的测试才稳
export const TZ = 480 // UTC+8（dayKey 里加的是偏移量，东八区为 +480）

export function makeApi (opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'token-budget-'))
  const routes = new Map()
  const commands = new Map()
  const timers = []
  const sent = []
  const hooks = new Map() // 事件名 -> [fn]
  const settings = { ...plugin.defaults, ...(opts.settings || {}) }
  const config = { ownerQQ: OWNER, ...(opts.config || {}) }

  const api = {
    id: 'token-budget',
    log: { debug () {}, info () {}, warn () {}, error () {} },
    dataDir: () => dir,
    settings: () => ({ ...settings }),
    saveSettings: (patch) => Object.assign(settings, patch),
    config: () => ({ ...config }),
    isOwner: (id) => String(id) === OWNER,
    use: (id) => (opts.mods && opts.mods[id]) || null,
    has: (id) => Boolean(opts.mods && opts.mods[id]),
    lib: (p) => (opts.lib && opts.lib[p]) || null,
    on: (name, fn) => { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); return () => {} },
    every: (ms, fn, name) => { timers.push({ ms, fn, name }); return () => {} },
    command: (c) => { commands.set(c.name, c); for (const a of c.aliases || []) commands.set(a, c); return () => {} },
    route: (p, fn) => { routes.set(p, fn); return () => {} },
    sendText: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 'm' + sent.length } },
  }

  const mod = plugin.setup(api)

  // 按真实语义跑改写链：值逐个传下去，返回 null 视为「拦下」并短路
  const runHook = async (name, value, info) => {
    let v = value
    for (const fn of hooks.get(name) || []) {
      const next = await fn(v, info)
      if (next === null) return null
      if (next !== undefined) v = next
    }
    return v
  }

  const call = async (path, body, headers) => {
    const fn = routes.get(path)
    if (!fn) throw new Error('没有这个路由：' + path)
    return await fn({ __body: body, headers: headers || {} })
  }
  const runCommand = async (arg) => commands.get('预算').run(arg)

  return {
    api, mod, hooks, routes, commands, timers, sent, dir, settings, config, call, runCommand, runHook,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
