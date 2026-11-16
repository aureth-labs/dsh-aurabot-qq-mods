import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import breeze from '../modules/breeze/index.mjs'

test('停用桥接会取消在途合成，排队请求不会在停用后调用上游', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'breeze-lifecycle-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let handler, dispose, calls = 0, activeSignal
  const srv = new EventEmitter()
  srv.listen = (_port, _host, ready) => { queueMicrotask(ready); return srv }
  srv.address = () => ({ port: 47653 })
  srv.close = () => srv
  t.mock.method(http, 'createServer', fn => { handler = fn; return srv })
  let resolveFetch
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    calls++
    activeSignal = init.signal
    return new Promise((resolve, reject) => {
      resolveFetch = () => resolve(new Response(Buffer.alloc(500)))
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  })
  let cfg = { voice: { engine: 'windows', http: {} } }
  breeze.setup({
    settings: () => ({ on: true, apiKey: 'fixture-key', voiceId: 'fixture-voice', checkinOn: false }),
    config: () => cfg,
    setConfig: patch => { cfg = { ...cfg, ...patch } },
    core: { setConfig: next => { cfg = next } },
    dataDir: () => dir,
    log: { info() {}, warn() {}, debug() {} },
    onDispose: fn => { dispose = fn }, on() {}, later() {}, route() {},
  })
  await new Promise(setImmediate)
  const response = () => Object.assign(new EventEmitter(), { writableEnded: false, writeHead() {}, end() { this.writableEnded = true } })
  const first = handler({ url: '/?text=first' }, response())
  await new Promise(setImmediate)
  const second = handler({ url: '/?text=second' }, response())
  dispose()
  // Release a pre-fix request too, so the counterexample never hangs the test process.
  const abortedAtDispose = activeSignal.aborted
  resolveFetch()
  await new Promise(setImmediate)
  resolveFetch()
  await Promise.all([first, second])
  assert.equal(abortedAtDispose, true)
  assert.equal(calls, 1)
})
