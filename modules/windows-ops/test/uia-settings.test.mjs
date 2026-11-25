// uia-settings.test.mjs —— preferUia（优先用元素定位）的运行时接线测试
// 来源：aurabot 模块库 modules/windows-ops（MIT）。用 fake api 装配整个模块，不打真 PowerShell、不动界面。
// 覆盖：默认值（缺省 true、只有明确 false 才算关）、status() 呈现、工具描述按开关切换、
//       总纲注入在关掉时补一句。注意这里只碰 index.mjs 的接线，不涉及 panel.js / guides.mjs 的内容。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'
import { b64arg } from '../lib/ps.mjs'

const DATA = mkdtempSync(join(tmpdir(), 'wops-uia-set-'))

/**
 * 造一个最小的 fake api（对齐 src/core/modules.js 的 makeApi 面，只给本测试要用的那几项）。
 * settings 通过 settingsPatch 控制；rule/tool 把注册回调存下来，测试里手动调用取回内容。
 */
function fakeApi(settingsPatch = {}) {
  const out = { rules: [], tools: [] }
  const api = {
    dataDir: () => DATA,
    settings: () => ({ enabled: true, allowInput: true, confirmDanger: false, rateLimit: 0, ...settingsPatch }),
    rule: (scope, fn) => out.rules.push({ scope, fn }),
    defineTool: (def) => def,
    tool: (fn) => { out.tools = fn() },
    command: () => {},
    route: () => {},
    onDispose: () => {},
    core: { hub: { turnSendersAllOwner: () => true }, http: {} },
    // 注入 fake ps：装配期不碰真 PowerShell
    __windowsOpsTestHooks: { ps: { isWin: () => true, b64arg, run: async () => '' } },
  }
  out.exports = mod.setup(api)
  out.tool = (name) => out.tools.find((t) => t.name === name)
  out.ruleText = () => out.rules.find((r) => r.scope === 'private')?.fn() || ''
  return out
}

test('preferUia：默认值 true（面板还没落盘时也按「优先元素定位」）', () => {
  assert.equal(mod.defaults.preferUia, true)
  assert.equal(fakeApi({}).exports.status().preferUia, true)
})

test('preferUia：只有明确 false 才算关（缺省 / null / 0 都算开）', () => {
  assert.equal(fakeApi({ preferUia: undefined }).exports.status().preferUia, true)
  assert.equal(fakeApi({ preferUia: null }).exports.status().preferUia, true)
  assert.equal(fakeApi({ preferUia: 0 }).exports.status().preferUia, true)
  assert.equal(fakeApi({ preferUia: false }).exports.status().preferUia, false)
})

test('preferUia=true：windows_ops 工具描述提示「优先读树、坐标兜底」', () => {
  const desc = fakeApi({}).tool('windows_ops').description
  assert.match(desc, /优先用 uia\.tree 读无障碍树/)
  assert.match(desc, /仅作兜底/)
})

test('preferUia=false：windows_ops 工具描述改成「按坐标操作」', () => {
  const desc = fakeApi({ preferUia: false }).tool('windows_ops').description
  assert.match(desc, /按坐标操作/)
  assert.ok(!desc.includes('仅作兜底'), '关掉后不该再提示「优先读树」')
})

test('preferUia=false：总纲注入末尾补一句「按坐标操作」', () => {
  const text = fakeApi({ preferUia: false }).ruleText()
  assert.match(text, /元素定位优先已关闭/)
  assert.match(text, /按坐标操作/)
})

test('preferUia=true：总纲注入不带那句（保持原样）', () => {
  const text = fakeApi({}).ruleText()
  assert.ok(!text.includes('元素定位优先已关闭'))
  assert.match(text, /逛电脑总纲/)
})

test('总开关关着时不论 preferUia 都不注入总纲（原有行为不变）', () => {
  assert.equal(fakeApi({ enabled: false, preferUia: false }).ruleText(), '')
})

test('uia.* 走 exec 受安全闸门约束：uia.click 需开「允许键鼠模拟」', async () => {
  const t = fakeApi({ allowInput: false })
  const r = await t.exports.exec('uia.click', { pid: 1, sel: 'Name=确定' })
  assert.equal(r.ok, false)
  assert.match(r.message, /键鼠模拟没开/)
})

test('uia.tree 是安全操作：不用开键鼠开关，参数错时给可读提示', async () => {
  const t = fakeApi({ allowInput: false })
  const r = await t.exports.exec('uia.tree', { pid: 1, sel: 'Title=x' })
  assert.equal(r.ok, false)
  assert.match(r.message, /选择器键/)
})
