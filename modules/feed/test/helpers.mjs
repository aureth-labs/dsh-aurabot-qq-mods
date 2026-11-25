// 一个够用的假 Aurabot api：路由、设置、发送、定时器都记下来，行为全走真代码。
// 不联网、不连 QQ；state.json 写在临时目录里，测试之间互不影响。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.mjs'

export const OWNER = '10000001'

export function makeApi (opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'feed-module-'))
  const routes = new Map()
  const commands = new Map()
  const tools = []
  const timers = []
  const sent = []
  const settings = { ...plugin.defaults, ...(opts.settings || {}) }
  const config = { ownerQQ: OWNER, ...(opts.config || {}) }

  const api = {
    id: 'feed',
    log: { debug () {}, info () {}, warn () {}, error () {} },
    dataDir: () => dir,
    settings: () => ({ ...settings }),
    saveSettings: (patch) => Object.assign(settings, patch),
    config: () => ({ ...config }),
    use: (id) => (opts.mods && opts.mods[id]) || null,
    on: () => () => {},
    context: () => () => {},
    rule: () => () => {},
    every: (ms, fn, name) => { timers.push({ ms, fn, name }); return () => {} },
    defineTool: (spec) => { tools.push(spec); return () => {} },
    command: (c) => { commands.set(c.name, c); for (const a of c.aliases || []) commands.set(a, c); return () => {} },
    route: (p, fn) => { routes.set(p, fn); return () => {} },
    think: async (prompt) => { sent.push({ think: prompt }); return '吃完啦，哥哥～' },
    send: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 'm' + sent.length } },
    core: { http: { body: async (req) => (req && req.__body) || {} } },
  }

  const mod = plugin.setup(api)

  const call = async (path, body) => {
    const fn = routes.get(path)
    if (!fn) throw new Error('没有这个路由：' + path)
    return await fn({ __body: body })
  }

  return {
    api, mod, routes, commands, tools, timers, sent, dir, settings, config, call,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// 把饥饿值钉死，顺便把 lastTick 对齐到「现在」，这样紧接着的 tick 不会把它拉动
export async function pinHunger (t, hunger) {
  await t.call('/set', { hunger })
  return t
}
