// guides.test.mjs —— windows-ops 指引库测试（纯逻辑，不打真 PowerShell）
// 来源：aurabot 模块库 modules/windows-ops（MIT）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuides, BUILTIN_GUIDES } from '../lib/guides.mjs'

const DATA = mkdtempSync(join(tmpdir(), 'wops-guides-'))

test('内置指引齐全：main 总纲 + 四类手册 + generic，都有正文', () => {
  for (const key of ['main', 'input', 'window', 'clipboard', 'screenshot', 'generic']) {
    assert.ok(BUILTIN_GUIDES[key], `缺内置指引 ${key}`)
    assert.ok(BUILTIN_GUIDES[key].text.length > 50, `${key} 正文太短`)
  }
})

test('resolve：按操作类型挑手册，不认识回 generic，main 永远不被自动挑中', () => {
  const g = createGuides(DATA)
  assert.equal(g.resolve({ op: 'mouse.click' }), 'input')
  assert.equal(g.resolve({ op: 'key.text' }), 'input')
  assert.equal(g.resolve({ op: 'window.close' }), 'window')
  assert.equal(g.resolve({ op: 'clipboard.read' }), 'clipboard')
  assert.equal(g.resolve({ op: 'screenshot' }), 'screenshot')
  assert.equal(g.resolve({ op: '不存在的操作' }), 'generic')
  assert.equal(g.resolve({}), 'generic')
  // resolve 的返回值永远不会是 main（总纲只做常驻注入）
  for (const op of Object.keys(BUILTIN_GUIDES)) assert.notEqual(g.resolve({ op }), 'main')
})

test('upsert/list/get：自定义层覆盖内置，删除即回到内置版', () => {
  const g = createGuides(DATA)
  g.upsert('window', { name: '我的窗口手册', text: '自定义窗口手册正文' })
  assert.equal(g.get('window'), '自定义窗口手册正文')
  const item = g.list().find((x) => x.key === 'window')
  assert.equal(item.source, 'custom')
  assert.equal(item.name, '我的窗口手册')
  // 删除（remove）后回到内置
  assert.equal(g.remove('window'), true)
  assert.equal(g.get('window'), BUILTIN_GUIDES.window.text)
})

test('remove 的边界：main/generic 不可删，越目录 key 不认，不存在的删不掉', () => {
  const g = createGuides(DATA)
  assert.equal(g.remove('main'), false)
  assert.equal(g.remove('generic'), false)
  assert.equal(g.remove('../../evil'), false)
  assert.equal(g.remove('nope'), false)
})

test('自定义指引落盘在 dataDir/guides/<key>.md，首行可带改名注释', () => {
  const g = createGuides(DATA)
  g.upsert('my-op', { name: '我的手册', text: '正文内容' })
  const p = join(DATA, 'guides', 'my-op.md')
  assert.ok(existsSync(p))
  assert.match(readFileSync(p, 'utf8'), /^<!-- name: 我的手册 -->\n/)
  const item = g.list().find((x) => x.key === 'my-op')
  assert.equal(item.name, '我的手册')
  assert.equal(item.text, '正文内容')
})

test('key 白名单：非法 key 的 upsert 直接抛错，不落盘', () => {
  const g = createGuides(DATA)
  assert.throws(() => g.upsert('../evil', { text: 'x' }))
  assert.throws(() => g.upsert('', { text: 'x' }))
  assert.throws(() => g.upsert('A_大写', { text: 'x' }))
})
