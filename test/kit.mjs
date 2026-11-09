// 模块测试共用的「假 api」：按插件 src/core/modules.js 的 makeApi 面构造，
// 只实现被测模块真正用到的那几个，其余给最小占位。
// 目的不是模拟整个插件，而是让模块能真的 setup 起来、路由能被调用、工具能被执行。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 每个测试用独立数据目录，互不干扰。 */
export function tempDataDir(prefix) {
  return mkdtempSync(join(tmpdir(), `aurabot-test-${prefix}-`))
}

/**
 * 造一个假 api。
 * @param {object} opts
 * @param {object} opts.settings   初始设置（api.settings() 返回它）
 * @param {string} opts.dataRoot   数据根目录（默认新建临时目录）
 * @param {string} opts.moduleDir  模块目录（默认调用方传）
 * @param {object} opts.modules    可被 api.use / api.lazy 拿到的兄弟模块
 * @param {object} opts.stubs      覆盖任意 api 方法
 */
export function makeFakeApi(opts = {}) {
  const settings = { ...(opts.settings || {}) }
  const routes = new Map()
  const tools = []
  const commands = []
  const timers = []
  const emitted = []
  const logs = []
  const sent = []
  const dataRoot = opts.dataRoot || tempDataDir(opts.id || 'mod')
  const moduleDir = opts.moduleDir || process.cwd()

  const api = {
    id: opts.id || 'test',
    dir: moduleDir,
    version: 'test',
    log: {
      info: (...a) => logs.push(['info', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      debug: (...a) => logs.push(['debug', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')]),
    },
    dataDir: (...parts) => {
      const d = join(dataRoot, 'modules-data', opts.id || 'test', ...parts.slice(0, 0))
      // 模块调用 dataDir('a','b') 时应得到 <root>/modules-data/<id>/a/b
      const base = join(dataRoot, 'modules-data', opts.id || 'test')
      mkdirSync(base, { recursive: true })
      return parts.length ? join(base, ...parts) : base
    },
    config: () => opts.config || {},
    settings: () => ({ ...settings }),
    saveSettings: (patch) => { Object.assign(settings, patch || {}); return { ...settings } },
    setConfig: (patch) => { opts.config = { ...(opts.config || {}), ...(patch || {}) }; return opts.config },
    route: (path, handler) => { routes.set(path, handler) },
    tool: (fn) => { tools.push(fn) },
    defineTool: (def) => def,
    command: (def) => { commands.push(def) },
    every: (ms, fn) => { timers.push({ ms, fn }); return () => {} },
    later: (ms, fn) => { timers.push({ ms, fn }); return () => {} },
    onDispose: (fn) => { api.__dispose = fn },
    has: (id) => Boolean(opts.modules && opts.modules[id]),
    use: (id) => (opts.modules ? opts.modules[id] : null),
    lazy: (id) => (opts.modules ? opts.modules[id] : null),
    emit: (type, payload) => { emitted.push({ type, payload }) },
    on: () => () => {},
    send: (...a) => { sent.push(a) },
    core: {
      http: {
        send: (res, code, body) => { res.statusCode = code; res.body = JSON.stringify(body); res.end?.(res.body) },
        query: (req) => {
          try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams) } catch { return {} }
        },
        body: async (req) => req.__json ?? {},
      },
      guard: () => ({ ok: true }),
      token: () => 'test-token',
      audio: { store: () => ({ url: '/aurabot/api/audio/test.wav' }) },
    },
    // 常用便利方法
    think: async () => '',
    ask: async () => '',
  }

  Object.assign(api, opts.stubs || {})

  /** 调一个已注册路由。返回 { status, body, json } */
  async function call(path, { method = 'GET', query = {}, json, headers } = {}) {
    const handler = routes.get(path.split('?')[0])
    if (!handler) return { status: 404, body: null, json: null, missing: true }
    const qs = new URLSearchParams(query).toString()
    const req = {
      method,
      url: `${path}${qs ? '?' + qs : ''}`,
      headers: { host: '127.0.0.1:12345', ...(headers || {}) },
      __json: json,
    }
    const res = {
      statusCode: 200, body: null, headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(b) { this.body = b },
    }
    await handler(req, res)
    let parsed = null
    try { parsed = JSON.parse(res.body) } catch {}
    return { status: res.statusCode, body: res.body, json: parsed, headers: res.headers }
  }

  /** 拿到当前可用的工具定义（有些模块按上下文动态给）。 */
  function toolDefs(ctx = { chat: { kind: 'private', chatId: '10001' }, level: 'owner', sessionId: 's1' }) {
    const out = []
    for (const t of tools) {
      const got = typeof t === 'function' ? t(ctx) : t
      if (Array.isArray(got)) out.push(...got)
      else if (got) out.push(got)
    }
    return out
  }

  /** 按名字执行一个工具。 */
  async function runTool(name, args = {}, ctx) {
    const def = toolDefs(ctx).find((d) => d && d.name === name)
    if (!def) return { ok: false, message: 'no such tool' }
    return def.execute(args, ctx || {})
  }

  /** 让所有注册的定时器跑一次（异步的也等）。 */
  async function tickAll() {
    const results = []
    for (const t of timers) {
      try { results.push(await t.fn()) } catch (e) { results.push(String(e)) }
    }
    return results
  }

  return {
    api, routes, tools, commands, timers, emitted, logs, sent, settings,
    dataRoot, call, toolDefs, runTool, tickAll,
    cleanup() { try { rmSync(dataRoot, { recursive: true, force: true }) } catch {} },
    readJson: (rel) => { try { return JSON.parse(readFileSync(join(dataRoot, rel), 'utf8')) } catch { return null } },
    writeFile: (rel, body) => {
      const p = join(dataRoot, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
    },
    exists: (rel) => existsSync(join(dataRoot, rel)),
    ls: (rel) => { try { return readdirSync(join(dataRoot, rel)) } catch { return [] } },
  }
}

/** 从一个 ES 模块取出 default 导出并 setup。 */
export async function setupModule(entryUrl, api) {
  const mod = (await import(entryUrl)).default
  const exports = mod.setup(api) || {}
  return { mod, exports }
}
