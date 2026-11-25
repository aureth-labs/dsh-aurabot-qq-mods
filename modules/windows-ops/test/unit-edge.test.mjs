// unit-edge.test.mjs —— windows-ops 单元补缺：guides resolve 映射 / safety 确认队列 / 白名单边界
// 来源：aurabot 模块库 modules/windows-ops（MIT）。纯逻辑，不打真 PowerShell、不动真键鼠。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuides } from '../lib/guides.mjs'
import { createSafety } from '../lib/safety.mjs'
import { OPS } from '../lib/ops.mjs'

const mkData = () => mkdtempSync(join(tmpdir(), 'wops-edge-'))
const makeSettings = (patch = {}) => {
  const s = { opsWhitelist: [], allowInput: false, confirmDanger: true, dryRun: false, rateLimit: 0, ...patch }
  return () => s
}
const makeSafety = (patch = {}) =>
  createSafety({ dataDir: mkData(), getSettings: makeSettings(patch), opsMeta: OPS, windowMs: 1000 })

// ---- guides resolve 映射全覆盖 ----
test('resolve：全部 10 个操作 id 都映射到正确手册', () => {
  const g = createGuides(mkData())
  const want = {
    'clipboard.read': 'clipboard', 'clipboard.write': 'clipboard',
    'screenshot': 'screenshot',
    'window.list': 'window', 'window.activate': 'input', 'window.close': 'window',
    'mouse.move': 'input', 'mouse.click': 'input',
    'key.text': 'input', 'key.press': 'input', 'paste': 'input',
  }
  for (const [op, key] of Object.entries(want)) assert.equal(g.resolve({ op }), key, `resolve(${op})`)
})

test('resolve：guides key 本身不作操作 id（main/window 等按前缀语义不走 key 直查）', () => {
  const g = createGuides(mkData())
  // 历史教训：resolve 曾按 BUILTIN_GUIDES[op].cat 直查——传 op='window' 这类“像 key 的值”
  // 会错拿手册而不是报 generic；现在 window.activate 归 input，window.list/close 归 window。
  assert.equal(g.resolve({ op: 'window.activate' }), 'input')
  assert.equal(g.resolve({ op: 'window.close' }), 'window')
})

test('resolve：自定义指引覆盖后映射结果不变（映射按操作类型，不按自定义内容）', () => {
  const g = createGuides(mkData())
  g.upsert('input', { name: '我的键鼠手册', text: '自定义正文' })
  assert.equal(g.resolve({ op: 'mouse.click' }), 'input')
  assert.equal(g.get('input'), '自定义正文')
})

// ---- safety 确认队列边界 ----
test('确认队列：不同参数是不同的确认项（同 op 不同 summary 不合并）', () => {
  const s = makeSafety({ allowInput: true })
  const a = s.gate({ op: 'window.close', summary: 'pid 1' })
  const b = s.gate({ op: 'window.close', summary: 'pid 2' })
  assert.equal(a.verdict, 'NEED_CONFIRM')
  assert.equal(b.verdict, 'NEED_CONFIRM')
  assert.notEqual(a.id, b.id)
  assert.equal(s.listConfirms().length, 2)
})

test('确认队列：批准只对「同 op + 同参数」放行，换参数仍要确认', () => {
  const s = makeSafety({ allowInput: true })
  const a = s.gate({ op: 'mouse.click', summary: '(10, 20) 左键' })
  s.approveConfirm(a.id)
  assert.equal(s.gate({ op: 'mouse.click', summary: '(10, 20) 左键' }).verdict, 'ALLOW')
  assert.equal(s.gate({ op: 'mouse.click', summary: '(99, 99) 左键' }).verdict, 'NEED_CONFIRM')
})

test('确认队列：拒绝后同动作再次 gate 会生成新确认项', () => {
  const s = makeSafety({ allowInput: true })
  const a = s.gate({ op: 'window.close', summary: 'pid 3' })
  s.rejectConfirm(a.id)
  assert.equal(s.listConfirms().length, 0)
  const b = s.gate({ op: 'window.close', summary: 'pid 3' })
  assert.equal(b.verdict, 'NEED_CONFIRM')
  assert.notEqual(b.id, a.id)
})

test('确认队列：关掉 confirmDanger 后危险操作直接放行（不建议但面板可配）', () => {
  const s = makeSafety({ allowInput: true, confirmDanger: false })
  assert.equal(s.gate({ op: 'window.close', summary: 'pid 4' }).verdict, 'ALLOW')
})

// ---- 白名单边界 ----
test('白名单：显式白名单拦下不在名单里的操作，即使它是安全类', () => {
  const s = makeSafety({ opsWhitelist: ['screenshot'] })
  assert.equal(s.checkOp('clipboard.read').ok, false)
  assert.equal(s.checkOp('screenshot').ok, true)
})

test('白名单与键鼠开关叠加：白名单放行了键鼠操作，开关没开照样拦', () => {
  const s = makeSafety({ opsWhitelist: ['mouse.click'], allowInput: false })
  assert.equal(s.checkOp('mouse.click').ok, false)
  const s2 = makeSafety({ opsWhitelist: ['mouse.click'], allowInput: true })
  assert.equal(s2.checkOp('mouse.click').ok, true)
})

test('白名单空白项/重复项/首尾空格都容忍，trim 后精确匹配', () => {
  const s = makeSafety({ opsWhitelist: [' window.list ', '', 'clipboard.read', 'clipboard.read'] })
  assert.equal(s.checkOp('window.list').ok, true)
  assert.equal(s.checkOp('clipboard.read').ok, true)
  assert.equal(s.checkOp('key.text').ok, false)
})

// ---- exec 链路对齐：闸门判定顺序（REJECT > DRY_RUN > NEED_CONFIRM > 限速 > 执行）----
test('dryRun 优先于确认：试运行时不产生确认项', () => {
  const s = makeSafety({ allowInput: true, dryRun: true })
  const g = s.gate({ op: 'window.close', summary: 'pid 5' })
  assert.equal(g.verdict, 'DRY_RUN')
  assert.equal(s.listConfirms().length, 0)
})

test('未知操作在白名单为空时也拒绝；summary 由 ops.prepare 校验（参数错在 gate 前抛错）', () => {
  const s = makeSafety()
  assert.equal(s.checkOp('made.up').ok, false)
})
