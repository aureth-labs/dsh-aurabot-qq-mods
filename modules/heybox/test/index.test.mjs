import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defer, ok } from './helpers.mjs'

test('模块注册面板接口，dispose 中断未完成的请求', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'heybox-module-test-'))
  const oldFetch = globalThis.fetch
  const oldProfile = process.env.USERPROFILE
  process.env.USERPROFILE = dir
  t.after(() => { globalThis.fetch = oldFetch; if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile; rmSync(dir, { recursive: true, force: true }) })
  const { default: mod } = await import('../index.mjs')
  let config = { enabled: true, dryRun: false, heybox: { enabled: true, cookie: 'pkey=old' } }
  const routes = new Map()
  const api = {
    core: { hub: {}, http: {}, onebot: {} },
    config: () => config,
    setConfig: (fn) => { config = fn(config) },
    lazy: () => null, use: () => null, log: {},
    every: () => {}, tool: () => {}, rule: () => {}, route: (path, fn) => routes.set(path, fn),
  }
  const hb = mod.setup(api)
  t.after(() => hb.dispose())
  assert.equal(mod.version, '1.5.1')
  for (const path of ['/heybox/state', '/heybox/risk', '/heybox/risk/clear', '/heybox/qr/start', '/heybox/qr/poll', '/heybox/verify/start', '/heybox/verify/finish', '/heybox/verify/show']) assert.equal(typeof routes.get(path), 'function')
  assert.equal((await routes.get('/heybox/verify/finish')()).ok, false)
  const gate = defer()
  globalThis.fetch = async (url, options) => {
    if (url.pathname === '/account/get_qrcode_url') {
      gate.resolve(options.signal)
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', reject, { once: true }))
    }
    return ok()
  }
  const pending = routes.get('/heybox/qr/start')()
  const signal = await gate.promise
  hb.dispose()
  assert.equal(signal.aborted, true)
  assert.equal((await pending).ok, false)
  assert.equal(config.heybox.cookie, 'pkey=old')
})
