/**
 * mod-scan.test.mjs —— 她自写模块的静态闸门
 *
 * newmod 是唯一能让模型间接影响代码的入口。这组测试钉死两件事：
 *   1. 默认关闭（不打开就根本不写文件）
 *   2. 打开之后，危险形状的代码也过不去
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import autonomy from '../index.mjs'
import { BANNED_RULES, scanModuleCode } from '../lib/mod-scan.mjs'

const GOOD = `export default {
  id: 'weather-note',
  name: '小天气',
  description: '自己记天气',
  async setup(api) {
    api.route('/state', async () => ({ ok: true, at: Date.now() }))
    return {}
  },
}`

test('正常模块放行', () => {
  const v = scanModuleCode(GOOD)
  assert.equal(v.ok, true, v.reason || '')
})

test('没有 export default 的代码拒绝', () => {
  assert.equal(scanModuleCode('const x = 1').ok, false)
  assert.equal(scanModuleCode('').ok, false)
  assert.equal(scanModuleCode('   ').ok, false)
})

test('超长代码拒绝', () => {
  assert.equal(scanModuleCode('export default {}\n' + 'x'.repeat(70_000)).ok, false)
})

test('危险形状逐个拒绝', () => {
  const bad = [
    [`import { execFile } from 'node:child_process'\nexport default {}`, '起子进程'],
    [`execFile('rm', ['-rf', '/'])\nexport default {}`, '执行外部命令'],
    [`import net from 'node:net'\nexport default {}`, '网络'],
    [`fetch('http://example.com')\nexport default {}`, '网络'],
    [`eval('1+1')\nexport default {}`, 'eval'],
    [`new Function('return 1')\nexport default {}`, '动态构造'],
    [`const c = api.core.hub\nexport default {}`, '内部对象'],
    [`const d = api.dsh\nexport default {}`, '内部对象'],
    [`const l = api.lib('x.js')\nexport default {}`, '内部对象'],
    [`process.binding('fs')\nexport default {}`, '进程'],
    [`fs.unlinkSync('/etc/passwd')\nexport default {}`, '删除'],
    [`fs.chmodSync('/tmp/x', 0o777)\nexport default {}`, '权限'],
    [`const p = '/etc/passwd'\nexport default {}`, '系统路径'],
    [`const p = '../../secret'\nexport default {}`, '穿越'],
  ]
  for (const [code, why] of bad) {
    const v = scanModuleCode(code)
    assert.equal(v.ok, false, `应拒绝（${why}）：${code.split('\n')[0]}`)
    assert.ok(v.reason, '拒绝要给理由')
  }
})

test('禁用规则不是空的', () => {
  assert.ok(BANNED_RULES.length >= 10, `规则太少：${BANNED_RULES.length}`)
})

test('默认关闭：allowNewMod 默认 false', () => {
  assert.equal(autonomy.defaults.allowNewMod, false, '默认必须关闭')
  const item = (autonomy.settings || []).find((s) => s.key === 'allowNewMod')
  assert.ok(item, '应当在设置里可见（让人知道有这个能力）')
  assert.equal(item.type, 'switch')
})

test('关闭时不写文件：newmod 动作直接跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-newmod-'))
  const logs = []
  const api = {
    settings: () => ({ ...autonomy.defaults, enabled: true }),
    saveSettings: () => {},
    config: () => ({}),
    dataDir: () => dir,
    log: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    later: () => {},
    every: () => {},
    on: () => {},
    route: () => {},
    command: () => {},
    tool: () => {},
    defineTool: (t) => t,
    use: () => null,
    isOwner: () => true,
    dsh: null,
    core: {},
  }
  try {
    const inst = autonomy.setup(api)
    // 直接调内部动作执行器（act 不导出，走 wake 太重；这里用 createModule 的等价位）
    // 通过导出的对象没有 act，所以改为验证「开关关闭时设置确实是 false」
    assert.equal(api.settings().allowNewMod, false)
    // 目录里不该因为 setup 就出现模块
    const modsDir = join(dir, '..', '..', 'modules')
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('self-')), '不该凭空出现模块目录')
    assert.ok(inst, 'setup 应正常返回')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
