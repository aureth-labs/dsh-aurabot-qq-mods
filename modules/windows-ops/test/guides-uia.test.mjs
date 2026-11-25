// guides-uia.test.mjs —— UIA（元素定位）配套的指引与面板断言
// 来源：aurabot 模块库 modules/windows-ops（MIT）
// 作用：锁住 v1.2.0 的 UIA 配套文案——uia 手册存在且讲清选择器语法与坐标兜底、
//       main 总纲把「能读无障碍树就先读树」写成第一原则、resolve 把 uia.* 映射到 uia、
//       面板有「优先用元素定位」开关（preferUia，默认 true）。
// 纯逻辑：只读源码与指引文本，不打真 PowerShell、不开 UIA。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuides, BUILTIN_GUIDES } from '../lib/guides.mjs'

const mkData = () => mkdtempSync(join(tmpdir(), 'wops-uia-guides-'))
const ROOT = new URL('..', import.meta.url)
const readSrc = (rel) => readFileSync(new URL(rel, ROOT), 'utf8')

// ---- uia 手册本体 ----
test('uia 手册是内置指引，正文够厚且分段齐全', () => {
  const g = BUILTIN_GUIDES.uia
  assert.ok(g, '缺内置指引 uia')
  assert.ok(g.text.length > 500, 'uia 手册正文太短')
  assert.equal(g.cat, 'uia')
  for (const sec of ['【元素定位（UIA）· 操作手册】', '◆ 总则', '◆ 选择器语法', '◆ 操作套路', '◆ 控件不支持 pattern 时怎么办', '◆ 坐标兜底', '◆ 坑']) {
    assert.ok(g.text.includes(sec), `uia 手册缺分节：${sec}`)
  }
})

test('uia 手册有「控件不支持 pattern」一节，写明读得到≠能操作、真实报错与应对三级降级', () => {
  const t = BUILTIN_GUIDES.uia.text
  // 小节标题与「读得到不等于能操作」这条核心认知
  assert.match(t, /◆ 控件不支持 pattern 时怎么办/, '缺「控件不支持 pattern」这一节')
  assert.match(t, /读得到 ≠ 该元素能操作/, '没写「读得到 ≠ 能操作」')
  assert.match(t, /uia\.tree 读得到 ≠ 该元素能操作/, '没把「读得到不等于能操作」钉在 uia.tree 上')
  assert.match(t, /先看 ControlType 再选操作方式/, '没写「先看 ControlType 再选操作方式」')
  // 真机事实：经典 Win32/WinForms 控件一个 pattern 都不支持；记事本编辑区三个字段
  assert.match(t, /Win32|WinForms/, '没写经典 Win32/WinForms 控件')
  assert.match(t, /一个 pattern 都不支持/, '没写「一个 pattern 都不支持」')
  assert.match(t, /ControlType=Pane/, '缺记事本编辑区的 ControlType=Pane')
  assert.match(t, /ClassName=Edit/, '缺记事本编辑区的 ClassName=Edit')
  assert.match(t, /AutomationId=15/, '缺记事本编辑区的 AutomationId=15')
  assert.match(t, /没提供 UIA provider/, '没说明是对方没提供 UIA provider，不是脚本的错')
  // 各 op 的如实报错表现
  assert.match(t, /该控件不支持 ValuePattern\.SetValue/, '没写 setValue 的真实报错原文')
  // 应对顺序 ①②③
  assert.match(t, /① 换一个支持 pattern 的元素/, '缺应对第一步：换元素')
  assert.match(t, /② 文本输入改用 clipboard\.write \+ paste/, '缺应对第二步：clipboard.write + paste')
  assert.match(t, /③ .*bounds.*中心/, '缺应对第三步：用 bounds 算中心坐标')
  assert.match(t, /比盲猜准/, '没写 bounds 中心比盲猜准')
  assert.match(t, /via=mouse/, '没提 uia.click 内部已经降级到鼠标（via=mouse）')
  // 只读文本元素 → 文字在 Name，getText 三级回退，via=name 正常
  assert.match(t, /TextBlock|Label/, '没写只读文本元素 TextBlock/Label')
  assert.match(t, /TextPattern → ValuePattern → Name/, '没写 getText 三级回退顺序')
  assert.match(t, /via=name/, '没写 via=name 是正常现象')
  assert.match(t, /正常现象/, '没说明 via=name 属正常现象、不是读失败')
})

test('uia 手册写清选择器语法：四个键 + && 连接 + 前缀匹配 + 示例', () => {
  const t = BUILTIN_GUIDES.uia.text
  for (const key of ['AutomationId', 'Name', 'ControlType', 'ClassName']) assert.ok(t.includes(key), `选择器键缺 ${key}`)
  assert.ok(t.includes('&&'), '没写 && 多条件连接')
  assert.match(t, /前缀匹配/, '没写「值按前缀匹配」')
  assert.match(t, /不支持通配/, '没写「不支持通配符」')
  assert.match(t, /AutomationId=[A-Za-z]/, '没有 AutomationId=xxx 形式的示例')
  assert.match(t, /Name=[^\n]+&&ControlType=/, '没有「Name=&&ControlType=」组合示例')
})

test('uia 手册写清三件事：先读树别猜坐标、坐标才会受窗口挪动影响、setValue 不受输入法影响', () => {
  const t = BUILTIN_GUIDES.uia.text
  assert.match(t, /能读树就别猜坐标/, '没写「能读树就别猜坐标」')
  assert.match(t, /窗口挪动/, '没写窗口挪动对选择器无影响')
  assert.match(t, /主题/, '没写换主题不影响选择器')
  assert.match(t, /Canvas|游戏/, '没写 Canvas/游戏类无 UIA 的坐标兜底场景')
  assert.match(t, /兜底/, '没写坐标兜底')
  assert.match(t, /uia\.setValue/, '没提 setValue')
  assert.match(t, /输入法/, '没写 setValue 不受输入法影响')
  assert.match(t, /key\.text/, '没对比 key.text')
})

// ---- main 总纲第一原则 ----
test('main 总纲把「能读无障碍树就先读树，别盲点坐标」写成第一原则', () => {
  const t = BUILTIN_GUIDES.main.text
  assert.match(t, /第一原则/, 'main 没写「第一原则」')
  assert.match(t, /无障碍树/, 'main 没提无障碍树')
  assert.match(t, /别盲点坐标/, 'main 没写「别盲点坐标」')
  assert.match(t, /uia\.tree/, 'main 没提 uia.tree')
  // 第一原则必须排在「安全红线」之前（总则段落里），而不是散落在坑里
  assert.ok(t.indexOf('第一原则') < t.indexOf('◆ 安全红线'), '第一原则应写在总则里、安全红线之前')
})

// ---- resolve 映射 ----
test('resolve：五个 uia.* 操作都映射到 uia 手册', () => {
  const g = createGuides(mkData())
  for (const op of ['uia.tree', 'uia.click', 'uia.setValue', 'uia.getText', 'uia.invoke']) {
    assert.equal(g.resolve({ op }), 'uia', `resolve(${op})`)
  }
})

test('resolve 原有映射不被 uia 影响，main 仍永不被自动挑中', () => {
  const g = createGuides(mkData())
  assert.equal(g.resolve({ op: 'mouse.click' }), 'input')
  assert.equal(g.resolve({ op: 'window.close' }), 'window')
  assert.equal(g.resolve({ op: 'clipboard.read' }), 'clipboard')
  assert.equal(g.resolve({ op: 'screenshot' }), 'screenshot')
  assert.equal(g.resolve({ op: '不存在的操作' }), 'generic')
  for (const op of Object.keys(BUILTIN_GUIDES)) assert.notEqual(g.resolve({ op }), 'main')
})

test('uia 手册可被自定义覆盖并还原（走通用指引层，不特殊对待）', () => {
  const data = mkData()
  const g = createGuides(data)
  g.upsert('uia', { name: '我的元素手册', text: '自定义元素手册正文' })
  assert.equal(g.get('uia'), '自定义元素手册正文')
  assert.equal(g.list().find((x) => x.key === 'uia').source, 'custom')
  assert.equal(g.remove('uia'), true)
  assert.equal(g.get('uia'), BUILTIN_GUIDES.uia.text)
})

// ---- 面板区块 ----
test('面板有「元素定位（UIA）」区块与 preferUia 开关（默认 true），且插在风险提示之后、白名单之前', () => {
  const src = readSrc('panel.js')
  assert.match(src, /preferUia: true/, 'DEFAULTS 里没写 preferUia: true')
  assert.match(src, /优先用元素定位/, '没写「优先用元素定位」开关文案')
  assert.match(src, /swRow\('优先用元素定位', 'preferUia'/, '开关没用 swRow 挂到 preferUia 上')
  assert.match(src, /元素定位（UIA）/, '没有「元素定位（UIA）」卡')
  // 选择器示例要能在面板里看到
  assert.match(src, /AutomationId=submitBtn/, '面板里没有选择器示例')
  // 卡片位置：风险提示 → 元素定位 → 操作白名单
  const risk = src.indexOf('高权限风险提示')
  const uia = src.indexOf('元素定位（UIA）')
  const white = src.indexOf("title: '操作白名单'")
  assert.ok(risk > 0 && uia > 0 && white > 0, '卡片标记没找全')
  assert.ok(risk < uia && uia < white, '元素定位区块应插在风险提示之后、白名单之前')
})
