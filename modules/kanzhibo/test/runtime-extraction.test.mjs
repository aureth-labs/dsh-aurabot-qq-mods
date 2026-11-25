import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateFlow } from '../lib/gateflow.mjs'
import { createGate } from '../lib/gate.mjs'
import { createPage } from '../lib/page.mjs'

test('gateflow 运行时：askOwner 能开闸并定时，confirmPending 能走 commit', async () => {
  const g = createGate({ ttlMs: 2000 })
  let commitCalled = 0
  const gf = createGateFlow({
    ctx: { viewport: { w: 1920, h: 1080 } },
    api: { sendText: async () => {}, sendImage: async () => {}, later: (ms, cb) => { const t = setTimeout(cb, ms); try { t.unref && t.unref() } catch {} return () => clearTimeout(t) }, settings: () => ({}) },
    note: () => {}, sleep: async () => {}, shot: async () => '', clicker: { markRect: async () => {}, unmark: async () => {} },
    gate: g, ownerChat: () => 'private:1', saveState: () => true, dayKey: () => '2026-01-06', journal: () => {},
    roomKeyOf: (u) => u, closeTaskPanel: async () => {},
    commitBadge: async () => { commitCalled++; return { ok: true, message: 'ok' } },
    commitGift: async () => ({ ok: true, message: 'ok' }),
    getBusy: () => false, setBusy: () => {},
  })
  const prep = { cand: { text: '送灯牌', rect: {} }, desc: '命中', point: { x: 1, y: 2 } }
  const r = await gf.askOwner({ kind: 'badge', label: '续灯牌', prepared: prep, data: {} })
  assert.equal(r.pending, true)
  assert.ok(g.peek(), '闸门应打开')
  const c = await gf.confirmPending()
  assert.equal(commitCalled, 1)
  assert.match(String(c), /✅ 灯牌/)
  gf.disposeGate()
})

test('page 运行时：shot 真落盘（writeFileSync 已修）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-page-'))
  const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
  const send = async (method) => {
    if (method === 'Page.captureScreenshot') return { data: png1x1 }
    if (method === 'Runtime.evaluate') return { result: { value: 0 } }
    return {}
  }
  const page = createPage({
    ctx: { cdp: { send } }, api: { dataDir: () => dir }, note: () => {}, sleep: async () => {},
    ensureMaximized: async () => {}, LIVE_RE: /^$/, pushSayLog: () => {}, clickBy: async () => {},
  })
  const file = await page.shot('t')
  assert.ok(file, 'shot 应返回路径')
  assert.equal(existsSync(file), true)
  assert.ok(statSync(file).size > 0)
  rmSync(dir, { recursive: true, force: true })
})
