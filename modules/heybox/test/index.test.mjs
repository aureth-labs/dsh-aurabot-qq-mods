import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
  // 版本不再写死在测试里：按 CONTRIBUTING 的要求断言「入口文件与 module.json 的
  // id/version/api 一致」，这样升版本时不会再莫名挂掉一条测试。
  const manifest = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8'))
  assert.equal(mod.version, manifest.version, 'index.mjs 与 module.json 的 version 要一致')
  assert.equal(mod.id, manifest.id)
  assert.equal(mod.api, manifest.api)
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
