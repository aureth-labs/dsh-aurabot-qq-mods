// guides.mjs 单元测试：内置指引、自定义覆盖层、resolve 挑选规则——不打浏览器、不碰真数据目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuides, BUILTIN_GUIDES } from '../lib/guides.mjs'

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'browser-ops-guides-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('内置指引：main 不挂关键词、generic 永远有、场景手册三段结构齐全', () => {
  const keys = Object.keys(BUILTIN_GUIDES)
  for (const must of ['main', 'generic', 'login', 'search', 'read', 'form']) {
    assert.ok(keys.includes(must), `缺内置指引 ${must}`)
    assert.ok(BUILTIN_GUIDES[must].text.includes('总则'), `${must} 缺「总则」节`)
    // main 是章程（怎么排/红线/收尾），场景手册才必有「操作套路」与「坑」
    if (must !== 'main') {
      assert.ok(BUILTIN_GUIDES[must].text.includes('操作套路'), `${must} 缺「操作套路」节`)
      assert.ok(BUILTIN_GUIDES[must].text.includes('坑'), `${must} 缺「坑」节`)
    } else {
      assert.ok(BUILTIN_GUIDES[must].text.includes('总纲 · 主流程'), 'main 该有总纲标记')
    }
  }
  assert.deepEqual(BUILTIN_GUIDES.main.keywords, [], 'main 不该挂关键词')
  for (const [key, g] of Object.entries(BUILTIN_GUIDES)) {
    if (key !== 'main' && key !== 'generic') assert.ok(g.keywords.length, `${key} 该挂关键词`)
  }
})

test('resolve：关键词挑场景手册，main 永远不会被自动挑中', () => {
  const { dir, cleanup } = tmp()
  try {
    const g = createGuides(dir)
    assert.equal(g.resolve({ goal: '帮我登录一下知乎' }), 'login')
    assert.equal(g.resolve({ goal: '搜一下天气' }), 'search')
    assert.equal(g.resolve({ goal: '读一下这篇文章' }), 'read')
    assert.equal(g.resolve({ goal: '填一下报名表单' }), 'form')
    assert.equal(g.resolve({ goal: '随便逛逛' }), 'generic')
    assert.notEqual(g.resolve({ goal: '登录并搜索' }), 'main')
    assert.equal(g.resolve({ goal: '任意任务', sceneGuide: 'my-scene' }), 'my-scene') // 显式指定优先
  } finally { cleanup() }
})

test('自定义覆盖层：upsert 覆盖内置、remove 回到内置、越目录 key 被拦', () => {
  const { dir, cleanup } = tmp()
  try {
    const g = createGuides(dir)
    // 自定义层生效 + 首行改名
    g.upsert('login', { name: '我家登录法', text: '◆ 总则\n- 自定义版本' })
    let login = g.list().find((x) => x.key === 'login')
    assert.equal(login.source, 'custom')
    assert.equal(login.name, '我家登录法')
    assert.match(login.text, /自定义版本/)
    assert.equal(g.get('login'), '◆ 总则\n- 自定义版本')
    // 删除 = 回到内置版
    assert.equal(g.remove('login'), true)
    login = g.list().find((x) => x.key === 'login')
    assert.equal(login.source, 'builtin')
    assert.equal(login.name, '登录')
    // 纯新增 key
    g.upsert('my-scene', { name: '我的场景', text: '◆ 总则\n- 新场景' })
    const mine = g.list().find((x) => x.key === 'my-scene')
    assert.equal(mine.source, 'custom')
    // main 的自定义层可以覆盖（编辑总纲），但 remove 只删层、get 回退内置
    g.upsert('main', { text: '【总纲 · 主流程】\n◆ 我的总纲' })
    assert.match(g.get('main'), /我的总纲/)
    g.remove('main')
    assert.match(g.get('main'), /【总纲 · 主流程】/)
    // 越目录 key：upsert 抛错、remove 静默 false、get 当没有自定义层
    assert.throws(() => g.upsert('../evil', { text: 'x' }), /key/)
    assert.equal(g.remove('../../evil'), false)
    assert.equal(g.get('../../evil'), null)
    // 非法 key upsert 拒绝
    assert.throws(() => g.upsert('BAD_KEY', { text: 'x' }), /key/)
    assert.throws(() => g.upsert('a', { text: 'x' }), /key/) // 太短
  } finally { cleanup() }
})

test('自定义层是普通 .md 文件也能被 list 认出（手工放文件）', () => {
  const { dir, cleanup } = tmp()
  try {
    mkdirSync(join(dir, 'guides'), { recursive: true })
    writeFileSync(join(dir, 'guides', 'handmade.md'), '<!-- name: 手写的 -->\n◆ 总则\n- 手放文件', 'utf8')
    const g = createGuides(dir)
    const mine = g.list().find((x) => x.key === 'handmade')
    assert.equal(mine.source, 'custom')
    assert.equal(mine.name, '手写的')
    assert.match(g.get('handmade'), /手放文件/)
  } finally { cleanup() }
})
