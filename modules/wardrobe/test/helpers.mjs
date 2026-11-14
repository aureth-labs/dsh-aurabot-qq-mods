// 衣柜模块测试用的假 api：临时数据目录、假生图模块、假模型；不联网、不发 QQ。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.mjs'

export const OWNER = '10000001'

/** 1x1 透明 PNG，够用来测「有参考图」的分支。 */
export const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export function makeApi (opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wardrobe-'))
  const routes = new Map()
  const hooks = new Map()
  const settings = { ...(opts.settings || {}) }
  const drawn = []
  const config = {
    ownerQQ: OWNER,
    imageGen: { provider: opts.provider || 'codex', img2img: true },
    persona: { current: 'test' },
    ...(opts.config || {}),
  }
  const res = { statusCode: 0, headers: {}, body: null }

  const imagegen = {
    generate: async (prompt, o) => {
      drawn.push({ prompt, options: o })
      return Buffer.from('fake-image-bytes')
    },
  }

  const api = {
    id: 'wardrobe',
    log: { debug () {}, info () {}, warn () {}, error () {} },
    dataDir: () => dir,
    settings: () => ({ ...settings }),
    saveSettings: (patch) => Object.assign(settings, patch),
    config: () => ({ ...config }),
    use: (id) => (id === 'imagegen' ? imagegen : null),
    on: (name, fn) => { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); return () => {} },
    route: (p, fn) => { routes.set(p, fn); return () => {} },
    ask: async () => opts.caption || '深藏青毛衣配深灰阔腿裤',
    core: { http: { body: async (req) => req.__body || {}, query: (req) => req.__query || {} } },
  }

  const mod = plugin.setup(api)

  const runHook = async (name, value, info) => {
    let v = value
    for (const fn of hooks.get(name) || []) {
      const next = await fn(v, info)
      if (next === null) return null
      if (next !== undefined) v = next
    }
    return v
  }
  const call = async (path, body, query) => {
    const fn = routes.get(path)
    if (!fn) throw new Error('没有这个路由：' + path)
    return await fn({ __body: body, __query: query || {} }, res)
  }

  return {
    api, mod, hooks, routes, settings, config, drawn, dir, call, runHook, res,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
