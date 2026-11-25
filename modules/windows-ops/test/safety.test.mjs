// safety.test.mjs —— windows-ops 安全闸门测试（纯逻辑，不打真 PowerShell）
// 来源：aurabot 模块库 modules/windows-ops（MIT）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSafety } from '../lib/safety.mjs'
import { OPS } from '../lib/ops.mjs'

/** 一套可改的假设置。 */
function makeSettings(patch = {}) {
  const s = { opsWhitelist: [], allowInput: false, confirmDanger: true, dryRun: false, rateLimit: 0, ...patch }
  return () => s
}

function makeSafety(patch = {}) {
  return createSafety({ dataDir: mkdtempSync(join(tmpdir(), 'wops-test-')), getSettings: makeSettings(patch), opsMeta: OPS, windowMs: 1000 })
}

test('未知操作拒绝；白名单拦不在名单里的操作', () => {
  const s = makeSafety()
  assert.equal(s.checkOp('nope').ok, false)
  assert.equal(s.checkOp('window.list').ok, true)
  const s2 = createSafety({ dataDir: mkdtempSync(join(tmpdir(), 'wops-test-')), getSettings: makeSettings({ opsWhitelist: ['window.list'] }), opsMeta: OPS })
  assert.equal(s2.checkOp('clipboard.read').ok, false)
  assert.equal(s2.checkOp('window.list').ok, true)
})

test('键鼠类操作没开「允许键鼠模拟」不放行', () => {
  const s = makeSafety()
  assert.equal(s.checkOp('mouse.click').ok, false)
  const s2 = makeSafety({ allowInput: true })
  assert.equal(s2.checkOp('mouse.click').ok, true)
})

test('试运行返回 DRY_RUN，不执行', () => {
  const s = makeSafety({ dryRun: true })
  assert.equal(s.gate({ op: 'clipboard.read', summary: '' }).verdict, 'DRY_RUN')
})

test('安全操作直接放行', () => {
  const s = makeSafety()
  assert.equal(s.gate({ op: 'clipboard.write', summary: '3 个字符' }).verdict, 'ALLOW')
})

test('危险操作：先 NEED_CONFIRM，批准后一次性放行，再下次又要确认', () => {
  const s = makeSafety({ allowInput: true })
  const g1 = s.gate({ op: 'window.close', summary: 'pid 123' })
  assert.equal(g1.verdict, 'NEED_CONFIRM')
  // 同动作重复 gate 不产生重复确认项
  const g2 = s.gate({ op: 'window.close', summary: 'pid 123' })
  assert.equal(g2.verdict, 'NEED_CONFIRM')
  assert.equal(g2.id, g1.id)
  // 批准后放行一次
  assert.equal(s.approveConfirm(g1.id), true)
  assert.equal(s.gate({ op: 'window.close', summary: 'pid 123' }).verdict, 'ALLOW')
  // 一次性消耗完：又要确认
  assert.equal(s.gate({ op: 'window.close', summary: 'pid 123' }).verdict, 'NEED_CONFIRM')
})

test('拒绝的待确认项：REJECT 后再批准无效', () => {
  const s = makeSafety()
  const g = s.gate({ op: 'clipboard.write', summary: 'x' }) // safe：直接放行，无确认项
  assert.equal(g.verdict, 'ALLOW')
  assert.equal(s.rejectConfirm('不存在'), false)
})

test('限速：窗口内超过上限就拒', () => {
  const s = makeSafety({ rateLimit: 2 })
  assert.equal(s.checkRate(), true)
  assert.equal(s.checkRate(), true)
  assert.equal(s.checkRate(), false) // 第 3 次超限
})
