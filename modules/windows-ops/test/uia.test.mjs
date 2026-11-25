// uia.test.mjs —— windows-ops 的 UIA（无障碍树）层测试
// 来源：aurabot 模块库 modules/windows-ops（MIT）。全部用注入的 fake ps，不打真 PowerShell、不动真界面。
// 覆盖：选择器解析（键白名单/前缀/大小写/非法输入）、5 个操作的参数顺序与脚本生成
//       （含「用户输入绝不拼进脚本」的注入断言）、脚本输出的解释（成功/找不到元素/不支持模式）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { b64arg } from '../lib/ps.mjs'
import { createOps, OPS } from '../lib/ops.mjs'
import { UIA_OPS, UIA_SELECTOR_KEYS, parseSelector, prepareUia, interpretUia } from '../lib/uia.mjs'

const DATA = mkdtempSync(join(tmpdir(), 'wops-uia-'))

/** 造一个假的 ps：记录每次脚本，回复可以是固定串或按脚本计算的函数。 */
function fakePs(reply = '') {
  const calls = []
  return {
    calls,
    isWin: () => true,
    b64arg,
    run: async (script) => {
      calls.push(script)
      return typeof reply === 'function' ? reply(script) : reply
    },
  }
}

/** PowerShell 侧 Emit 的输出形态：压缩 JSON 再套一层 UTF-8 base64。 */
const uiaOut = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')

/** 从生成的脚本里抠出 $a 数组并解码（base64 里没有单引号和右括号，正则安全）。 */
function argvOf(script) {
  const m = script.match(/\$a=@\(([^)]*)\)/)
  if (!m) return []
  return (m[1].match(/'([^']*)'/g) || []).map((q) => Buffer.from(q.slice(1, -1), 'base64').toString('utf8'))
}

// ---------- 选择器解析 ----------

test('parseSelector：单个条件', () => {
  const p = parseSelector('AutomationId=submitBtn')
  assert.deepEqual(p.map((x) => [x.key, x.value]), [['AutomationId', 'submitBtn']])
  assert.equal(p[0].raw, 'AutomationId=submitBtn')
})

test('parseSelector：多条件按 && 串成链，顺序保留', () => {
  const p = parseSelector('Name=提交&&ControlType=Button&&ClassName=Button')
  assert.deepEqual(p.map((x) => x.key), ['Name', 'ControlType', 'ClassName'])
})

test('parseSelector：键大小写不敏感，统一成规范写法', () => {
  const p = parseSelector('automationid=x&&nAmE=y&&controltype=Button')
  assert.deepEqual(p.map((x) => x.key), ['AutomationId', 'Name', 'ControlType'])
})

test('parseSelector：值里的 = 保留（只按第一个 = 切键值）', () => {
  const p = parseSelector('Name=a=b')
  assert.equal(p[0].value, 'a=b')
})

test('parseSelector：空串 → 空数组（uia.tree 可以不给选择器）', () => {
  assert.deepEqual(parseSelector(''), [])
  assert.deepEqual(parseSelector(undefined), [])
  assert.deepEqual(parseSelector('   '), [])
})

test('parseSelector：非法输入抛可读错误（不悄悄放过）', () => {
  assert.throws(() => parseSelector('AutomationId'), /键=值/)
  assert.throws(() => parseSelector('Title=x'), /不支持/)
  assert.throws(() => parseSelector('Name='), /不能为空/)
  assert.throws(() => parseSelector('Name=abc*'), /通配/)
  assert.throws(() => parseSelector('&&'), /键=值/)
})

test('UIA_SELECTOR_KEYS：只有契约里的四个键', () => {
  assert.deepEqual(UIA_SELECTOR_KEYS, ['AutomationId', 'Name', 'ControlType', 'ClassName'])
})

// ---------- 操作目录与参数 ----------

test('OPS：5 个 UIA 操作都在目录里，danger 符合契约', () => {
  const want = { 'uia.tree': 'safe', 'uia.click': 'input', 'uia.setValue': 'input', 'uia.getText': 'safe', 'uia.invoke': 'input' }
  for (const [op, danger] of Object.entries(want)) {
    assert.ok(OPS[op], `${op} 应在 OPS 里`)
    assert.equal(OPS[op].danger, danger, `${op} 的 danger`)
    assert.equal(OPS[op], UIA_OPS[op])
    assert.ok(OPS[op].label.length > 0)
  }
})

test('prepareUia：pid 校验（正整数，字符串数字也收）', () => {
  assert.equal(prepareUia('uia.tree', { pid: 1234 }).argv[0], '1234')
  assert.equal(prepareUia('uia.tree', { pid: '1234' }).argv[0], '1234')
  assert.throws(() => prepareUia('uia.tree', {}), /pid/)
  assert.throws(() => prepareUia('uia.tree', { pid: 0 }), /pid/)
  assert.throws(() => prepareUia('uia.tree', { pid: 'abc' }), /pid/)
})

test('prepareUia：uia.tree 允许空选择器（整棵树），其余 4 个必须给', () => {
  assert.deepEqual(prepareUia('uia.tree', { pid: 9 }).argv, ['9'])
  assert.match(prepareUia('uia.tree', { pid: 9 }).summary, /整棵树/)
  for (const op of ['uia.click', 'uia.setValue', 'uia.getText', 'uia.invoke']) {
    assert.throws(() => prepareUia(op, { pid: 9 }), /需要选择器 sel/)
  }
})

test('prepareUia：选择器片段顺序决定 argv 顺序（pid 永远第 0 位）', () => {
  const { argv } = prepareUia('uia.click', { pid: 7, sel: 'Name=提交&&ControlType=Button' })
  assert.deepEqual(argv, ['7', 'Name=提交', 'ControlType=Button'])
})

test('prepareUia：uia.setValue 的写入值固定占第 1 位（值里带 = 也不会被当条件）', () => {
  const { argv, summary } = prepareUia('uia.setValue', { pid: 7, sel: 'AutomationId=edit', text: 'a=b&&c*' })
  assert.deepEqual(argv, ['7', 'a=b&&c*', 'AutomationId=edit'])
  assert.match(summary, /← 7 个字符/)
})

test('prepareUia：text 为空也允许（等价于清空输入框）', () => {
  assert.deepEqual(prepareUia('uia.setValue', { pid: 7, sel: 'AutomationId=edit' }).argv, ['7', '', 'AutomationId=edit'])
})

test('createOps.prepare：UIA 操作走同一张参数校验表', () => {
  const ops = createOps({ ps: fakePs(''), dataDir: DATA })
  assert.match(ops.prepare('uia.getText', { pid: 3, sel: 'Name=正文' }).summary, /pid 3/)
  assert.throws(() => ops.prepare('uia.bogus', { pid: 3 }), /未知操作/)
})

// ---------- 脚本生成 ----------

test('5 个操作的脚本都加载 UIAutomationClient/UIAutomationTypes，且不缓存元素', async () => {
  for (const op of Object.keys(UIA_OPS)) {
    const ps = fakePs(uiaOut({ ok: true, items: [], text: '', via: 'invoke' }))
    const ops = createOps({ ps, dataDir: DATA })
    await ops.run(op, { pid: 4242, sel: 'AutomationId=x', text: 'v' })
    const script = ps.calls[0]
    assert.match(script, /Add-Type -AssemblyName UIAutomationClient/, `${op} 要加载 UIAutomationClient`)
    assert.match(script, /Add-Type -AssemblyName UIAutomationTypes/, `${op} 要加载 UIAutomationTypes`)
    // 每次操作现取根、现查元素：TreeScope.Descendants + FromHandle，没有缓存变量
    assert.match(script, /TreeScope\]::Descendants/, `${op} 要 Descendants 遍历`)
    assert.match(script, /::FromHandle\(\$h\)/, `${op} 要从主窗口句柄现取元素`)
    assert.match(script, /ConvertTo-Json -Compress/, `${op} 输出要紧凑 JSON`)
    // 沿用 PREFIX：压掉 PowerShell 进度流（真机踩过的坑）
    assert.match(script, /^\$ProgressPreference='SilentlyContinue'/, `${op} 要带 PREFIX`)
    // 解码底座：用户值只经 D() 取，脚本里不出现原文
    assert.deepEqual(argvOf(script).slice(0, 1), ['4242'])
  }
})

test('用户输入不拼进脚本：注入串只在 base64 里出现，脚本正文看不到原文', async () => {
  const evil = "'; Remove-Item C:\\ -Recurse -Force; '"
  const ps = fakePs(uiaOut({ ok: true, name: 'x', len: 3 }))
  const ops = createOps({ ps, dataDir: DATA })
  await ops.run('uia.setValue', { pid: 11, sel: `Name=${evil}`, text: evil })
  const script = ps.calls[0]
  assert.ok(!script.includes('Remove-Item'), '脚本里不能出现原文')
  assert.ok(!script.includes('Recurse'), '脚本里不能出现原文片段')
  const argv = argvOf(script)
  assert.equal(argv[0], '11')
  assert.equal(argv[1], evil) // 写入值第 1 位
  assert.equal(argv[2], `Name=${evil}`) // 选择器片段在 base64 里
})

test('选择器片段按「键=值」传给脚本，脚本用前缀匹配（StartsWith）而非全等', async () => {
  const ps = fakePs(uiaOut({ ok: true, items: [] }))
  const ops = createOps({ ps, dataDir: DATA })
  await ops.run('uia.tree', { pid: 5, sel: 'Name=提交&&ControlType=Button' })
  const script = ps.calls[0]
  assert.deepEqual(argvOf(script), ['5', 'Name=提交', 'ControlType=Button'])
  assert.match(script, /\.StartsWith\(\$v,\[System\.StringComparison\]::OrdinalIgnoreCase\)/)
})

test('uia.click：先试 InvokePattern，再退中心坐标模拟点击', async () => {
  const ps = fakePs(uiaOut({ ok: true, via: 'invoke', name: '保存' }))
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('uia.click', { pid: 6, sel: 'AutomationId=save' })
  assert.equal(r.ok, true)
  const script = ps.calls[0]
  assert.match(script, /InvokePattern\]::Pattern/)
  assert.match(script, /BoundingRectangle/)
  assert.match(script, /mouse_event\(0x0002/) // 左键按下
  assert.match(script, /mouse_event\(0x0004/) // 左键抬起
  assert.match(script, /SetCursorPos/)
})

test('uia.setValue：ValuePattern.SetValue 直写，并检查 IsReadOnly', async () => {
  const ps = fakePs(uiaOut({ ok: true, name: '文本编辑', len: 2 }))
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('uia.setValue', { pid: 8, sel: 'ControlType=Edit', text: '你好' })
  assert.equal(r.ok, true)
  const script = ps.calls[0]
  assert.match(script, /ValuePattern\]::Pattern/)
  assert.match(script, /\$vp\.SetValue\(\$val\)/)
  assert.match(script, /IsReadOnly/)
  assert.equal(argvOf(script)[1], '你好')
})

test('uia.getText：TextPattern.DocumentRange 优先，退 ValuePattern，最后退 Name', async () => {
  const ps = fakePs(uiaOut({ ok: true, text: '正文', via: 'text' }))
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('uia.getText', { pid: 9, sel: 'ControlType=Document' })
  assert.equal(r.ok, true)
  const script = ps.calls[0]
  assert.match(script, /TextPattern\]::Pattern/)
  assert.match(script, /DocumentRange\.GetText/)
  assert.match(script, /ValuePattern\]::Pattern/) // 第二级兜底
  // 第三级：真机踩坑（2026-11-06）——TextBlock/Label 这类只读文本元素既无 TextPattern 也无
  // ValuePattern，文字只在 Name 里；少了这一级会读回空串，让人误判「控件没内容」
  assert.match(script, /\$el\.Current\.Name/)
  assert.match(script, /via='name'/)
})

test('uia.getText：Name 回退路径的结果如实标注（只读文本控件）', () => {
  const r = interpretUia('uia.getText', uiaOut({ ok: true, text: 'checked', via: 'name' }))
  assert.equal(r.ok, true)
  assert.equal(r.data.text, 'checked')
  assert.equal(r.data.via, 'name')
  assert.match(r.message, /Name/)
})

test('uia.invoke：依次尝试 Toggle → SelectionItem → ExpandCollapse', async () => {
  const ps = fakePs(uiaOut({ ok: true, via: 'toggle', name: '同意' }))
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('uia.invoke', { pid: 10, sel: 'Name=同意' })
  assert.equal(r.ok, true)
  const script = ps.calls[0]
  const iToggle = script.indexOf('TogglePattern')
  const iSelect = script.indexOf('SelectionItemPattern')
  const iExpand = script.indexOf('ExpandCollapsePattern')
  assert.ok(iToggle > 0 && iSelect > iToggle && iExpand > iSelect, '尝试顺序必须是 Toggle → SelectionItem → ExpandCollapse')
})

// ---------- 输出解释 ----------

test('interpretUia uia.tree：每行 index｜ControlType｜Name｜AutomationId｜ClassName｜bounds', () => {
  const out = uiaOut({
    ok: true,
    total: 2,
    items: [
      { i: 0, ct: 'Window', n: '记事本', aid: 'Main', cls: 'Notepad', x: 10, y: 20, w: 800, h: 600 },
      { i: 1, ct: 'Edit', n: '文本编辑器', aid: 'editor', cls: 'Edit', x: 12, y: 60, w: 776, h: 500 },
    ],
  })
  const r = interpretUia('uia.tree', out)
  assert.equal(r.ok, true)
  assert.equal(r.data.length, 2)
  assert.deepEqual(r.data[1].bounds, { x: 12, y: 60, w: 776, h: 500 })
  assert.equal(r.data[1].controlType, 'Edit')
  assert.match(r.message, /^无障碍树 2 个元素/)
  assert.match(r.message, /1｜Edit｜文本编辑器｜editor｜Edit｜\(12,60,776×500\)/)
})

test('interpretUia uia.tree：单元素时 ConvertTo-Json 退化成标量也能收成数组', () => {
  const out = uiaOut({ ok: true, total: 1, items: { i: 0, ct: 'Button', n: '确定', aid: 'ok', cls: 'Button', x: 1, y: 2, w: 3, h: 4 } })
  const r = interpretUia('uia.tree', out)
  assert.equal(r.ok, true)
  assert.equal(r.data.length, 1)
})

test('interpretUia：找不到元素 → ok:false 且不抛（脚本内已翻成结构化输出）', () => {
  const miss = uiaOut({ ok: false, message: '没找到匹配的元素：窗口里没有满足选择器的控件（先用 uia.tree 看有哪些元素；选择器值只做前缀匹配）' })
  for (const op of ['uia.click', 'uia.setValue', 'uia.getText', 'uia.invoke']) {
    const r = interpretUia(op, miss)
    assert.equal(r.ok, false)
    assert.match(r.message, /没找到匹配的元素/)
  }
})

test('interpretUia：控件不支持某模式时如实转达脚本给的原因', () => {
  assert.match(interpretUia('uia.setValue', uiaOut({ ok: false, message: '控件是只读的（ValuePattern.IsReadOnly），写不进去' })).message, /只读/)
  assert.match(interpretUia('uia.invoke', uiaOut({ ok: false, message: '该控件不支持 Toggle/SelectionItem/ExpandCollapse 任一模式' })).message, /不支持/)
})

test('interpretUia uia.click：两条分支（Invoke / 坐标兜底）措辞不同', () => {
  const inv = interpretUia('uia.click', uiaOut({ ok: true, via: 'invoke', name: '保存' }))
  assert.match(inv.message, /InvokePattern/)
  assert.deepEqual(inv.data, { via: 'invoke', name: '保存' })
  const mouse = interpretUia('uia.click', uiaOut({ ok: true, via: 'mouse', x: 100, y: 200, name: '保存' }))
  assert.match(mouse.message, /中心坐标 \(100, 200\)/)
  assert.equal(mouse.data.via, 'mouse')
})

test('interpretUia uia.getText：有文本/没文本两种结果', () => {
  const got = interpretUia('uia.getText', uiaOut({ ok: true, text: '第一行\r\n第二行', via: 'value' }))
  assert.equal(got.ok, true)
  assert.match(got.message, /ValuePattern/)
  assert.equal(got.data.text, '第一行\r\n第二行')
  const empty = interpretUia('uia.getText', uiaOut({ ok: true, text: '', via: '' }))
  assert.equal(empty.ok, true)
  assert.match(empty.message, /没有可读文本/)
})

test('interpretUia uia.invoke：三种模式的措辞', () => {
  const want = { toggle: /TogglePattern 切换/, select: /SelectionItemPattern 选中/, expandcollapse: /ExpandCollapsePattern 展开\/收起/ }
  for (const [via, re] of Object.entries(want)) {
    assert.match(interpretUia('uia.invoke', uiaOut({ ok: true, via, name: '菜单' })).message, re)
  }
})

test('interpretUia：输出不是 base64 也不是 JSON 时给可读错误（不 throw）', () => {
  const r = interpretUia('uia.tree', 'CLIXML 一堆进度流乱码')
  assert.equal(r.ok, false)
  assert.match(r.message, /解析失败/)
})

test('interpretUia：JSON 直出也认（测试/回放注入方便）', () => {
  const r = interpretUia('uia.setValue', JSON.stringify({ ok: true, name: 'edit', len: 3 }))
  assert.equal(r.ok, true)
  assert.match(r.message, /3 个字符/)
})

// ---------- 端到端（fake ps 整链） ----------

test('createOps.run：uia.tree 成功时把元素列表放进 data', async () => {
  const ps = fakePs(uiaOut({ ok: true, total: 1, items: [{ i: 0, ct: 'Window', n: '记事本', aid: '', cls: 'Notepad', x: 0, y: 0, w: 640, h: 480 }] }))
  const r = await createOps({ ps, dataDir: DATA }).run('uia.tree', { pid: 1 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.data[0].bounds, { x: 0, y: 0, w: 640, h: 480 })
})

test('createOps.run：目标窗口不存在时返回 ok:false，不抛', async () => {
  const ps = fakePs(uiaOut({ ok: false, message: '找不到目标窗口：这个 pid 的进程不存在、已退出，或没有主窗口（先用 window.list 认准 pid）' }))
  const r = await createOps({ ps, dataDir: DATA }).run('uia.click', { pid: 99999, sel: 'Name=确定' })
  assert.equal(r.ok, false)
  assert.match(r.message, /找不到目标窗口/)
})

test('createOps.run：只读两件（uia.tree/uia.getText）失败重试一次，动作类（uia.click）不重试', async () => {
  const okOut = (op) =>
    op === 'uia.tree'
      ? uiaOut({ ok: true, total: 1, items: [{ i: 0, ct: 'Window', n: '记事本', aid: 'Main', cls: 'Notepad', x: 0, y: 0, w: 10, h: 10 }] })
      : uiaOut({ ok: true, text: 'ok', via: 'text' })
  for (const op of ['uia.tree', 'uia.getText']) {
    const calls = []
    const ps = {
      calls,
      isWin: () => true,
      b64arg,
      run: async (script) => {
        calls.push(script)
        if (calls.length === 1) throw new Error('PS 首次加载毛刺')
        return okOut(op)
      },
    }
    const r = await createOps({ ps, dataDir: DATA }).run(op, { pid: 2, sel: 'Name=x' })
    assert.equal(calls.length, 2, `${op} 应重试一次`)
    assert.equal(r.ok, true)
  }
  const calls = []
  const ps = {
    calls,
    isWin: () => true,
    b64arg,
    run: async (script) => { calls.push(script); throw new Error('炸了') },
  }
  await assert.rejects(createOps({ ps, dataDir: DATA }).run('uia.click', { pid: 2, sel: 'Name=x' }))
  assert.equal(calls.length, 1, '动作类不重试（防重复点击）')
})

test('createOps.run：非 Windows 平台给可读错误', async () => {
  const ps = { isWin: () => false, b64arg, run: async () => '' }
  const r = await createOps({ ps, dataDir: DATA }).run('uia.tree', { pid: 1 })
  assert.equal(r.ok, false)
  assert.match(r.message, /只能在 Windows/)
})
