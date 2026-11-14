// 观点模块测试用的假 api：路由 / 钩子 / 设置 / 临时数据目录都记下来，不联网。
// 嵌入请求由 mockFetch 短路成本地哈希向量，结果稳定、可复现。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.mjs'

export const OWNER = '10000001'

/** 把文本切成 2-gram 再散列到 dims 维，归一化。稳定向量，用来测相似度逻辑。 */
export function vecOf (text, dims = 64) {
  const v = new Array(dims).fill(0)
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    const g = s.slice(i, i + 2)
    let h = 0
    for (let k = 0; k < g.length; k++) h = (h * 31 + g.charCodeAt(k)) >>> 0
    v[h % dims] += 1
  }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1
  return v.map((x) => x / n)
}

/**
 * 让模块里的 fetch 走本地：只认 /embeddings。
 * rules 是 [子串, 向量] 的列表，先到先得；匹配不上就用哈希向量兜底，
 * 这样测试里的「相似」由测试自己定义，不受哈希碰撞影响。
 */
export function mockEmbeddings (rules = [{ test: () => true, vec: vecOf('默认') }]) {
  const real = globalThis.fetch
  const pick = (text) => {
    for (const r of rules) {
      if (r.test(String(text))) return r.vec
    }
    return vecOf(String(text))
  }
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/embeddings')) throw new Error('测试里不该请求：' + url)
    const body = JSON.parse(init.body)
    const input = Array.isArray(body.input) ? body.input : [body.input]
    return { ok: true, json: async () => ({ data: input.map((t) => ({ embedding: pick(t) })) }) }
  }
  return () => { globalThis.fetch = real }
}

/** 三类测试用向量：承诺、口味、原则互不相似。 */
export const VEC = {
  承诺: [1, 0, 0],
  口味: [0, 1, 0],
  原则: [0, 0, 1],
}
export const RULES = [
  { test: (s) => /答应|做到|承诺/.test(s), vec: VEC.承诺 },
  { test: (s) => /奶茶|糖|口味/.test(s), vec: VEC.口味 },
  { test: (s) => /别人|对我|骂|怎么对/.test(s), vec: VEC.原则 },
]

export function makeApi (opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'beliefs-'))
  const routes = new Map()
  const hooks = new Map()
  const settings = { ...(opts.settings || {}) }
  const config = {
    ownerQQ: OWNER,
    memory: { vector: { baseUrl: 'http://mock.local/v1', model: 'bge-m3' } },
    ...(opts.config || {}),
  }
  const asks = []

  const api = {
    id: 'beliefs',
    log: { debug () {}, info () {}, warn () {}, error () {} },
    dataDir: () => dir,
    settings: () => ({ ...settings }),
    saveSettings: (patch) => Object.assign(settings, patch),
    config: () => ({ ...config }),
    on: (name, fn) => { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); return () => {} },
    route: (p, fn) => { routes.set(p, fn); return () => {} },
    ask: async (o) => { asks.push(o); return opts.askResult !== undefined ? opts.askResult : '[]' },
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
    return await fn({ __body: body, __query: query || {} })
  }

  return {
    api, mod, hooks, routes, settings, config, asks, dir, call, runHook,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
