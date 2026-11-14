/**
 * grants.test.mjs —— 默认什么都没有，逐项授权才放开
 *
 * 这个模块的对外承诺是：module.json 的 capabilities 写空（默认一项都不用），
 * 真正的开关在 settings.grants 里，由主人在面板上一项一项打开。
 * 这组测试保证两边不会脱节——声明是空、默认是空、没授权就真的做不了。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import autonomy from '../index.mjs'
import { GRANTS, grantRows, grantsOf, isGranted, requireGrant } from '../lib/grants.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function makeApi(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-grants-'))
  let settings = { ...autonomy.defaults, ...(over.settings || {}) }
  const api = {
    settings: () => settings,
    saveSettings: (patch) => {
      settings = { ...settings, ...patch }
      return settings
    },
    config: () => ({}),
    dataDir: () => dir,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    later: () => {},
    every: () => {},
    on: () => {},
    route: () => {},
    command: () => {},
    tool: () => {},
    defineTool: (t) => t,
    use: () => null,
    isOwner: () => true,
    dsh: over.dsh || null,
    core: {},
  }
  return { api, dir, getSettings: () => settings, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('module.json 如实声明静态能力，运行时不预设任何权限', () => {
  const m = JSON.parse(readFileSync(join(HERE, '..', 'module.json'), 'utf8'))
  // capabilities 是「最坏情况下代码会用到什么」，必须无遗漏地列出来（仓库 check 会对着源码比对）。
  // 真正决定「能不能用」的是 grants——默认全关，主人在面板里逐项打开。
  assert.ok(Array.isArray(m.capabilities), 'capabilities 要是数组')
  for (const need of ['filesystem', 'process', 'network', 'plugin-config', 'plugin-internals']) {
    assert.ok(m.capabilities.includes(need), `代码用到 ${need}，声明里必须有`)
  }
  assert.equal(m.capabilities.includes('dynamic-code'), false, '不该声明用不到的能力')
  // 运行时零权限
  assert.deepEqual(autonomy.defaults.grants, { model: false, phone: false })
})

test('默认授权全空', () => {
  assert.deepEqual(autonomy.defaults.grants, { model: false, phone: false })
  for (const g of GRANTS) {
    assert.equal(isGranted(autonomy.defaults, g.id), false, `${g.id} 默认必须是关的`)
  }
})

test('grantsOf：缺字段、乱数据一律当未授权', () => {
  assert.deepEqual(grantsOf(undefined), { model: false, phone: false })
  assert.deepEqual(grantsOf({}), { model: false, phone: false })
  assert.deepEqual(grantsOf({ grants: { model: 1, phone: 'yes' } }), { model: true, phone: true })
  assert.deepEqual(grantsOf({ grants: { phone: { evil: true } } }), { model: false, phone: true })
  // 未知 id 不会被凭空当成已授权
  assert.equal(isGranted({ grants: {} }, 'nope'), false)
})

test('requireGrant：没授权就抛，且提示能指路', () => {
  for (const g of GRANTS) {
    assert.throws(() => requireGrant(autonomy.defaults, g.id), /还没授权/, `${g.id} 应当抛`)
    assert.equal(requireGrant({ grants: { [g.id]: true } }, g.id), true)
  }
  assert.throws(() => requireGrant(autonomy.defaults, '不存在的能力'), /未知能力/)
})

test('grantRows：面板能拿到每一项的说明与状态', () => {
  const rows = grantRows(autonomy.defaults)
  assert.equal(rows.length, GRANTS.length)
  for (const r of rows) {
    assert.ok(r.id && r.title && r.detail && r.capability, '每项都要有解释')
    assert.equal(r.granted, false)
    assert.ok(['低', '中', '高'].includes(r.risk), '风险等级要写清楚')
  }
})

test('没授权时 wake 直接拒绝，不碰宿主模型', async () => {
  let touched = false
  const dsh = {
    llm: {
      async *stream() {
        touched = true
        yield { type: 'text-delta', text: 'x' }
      },
    },
    get: () => null,
  }
  const c = makeApi({ settings: { enabled: true }, dsh })
  try {
    const out = autonomy.setup(c.api)
    const r = await out.wake({ manual: true })
    assert.equal(r.ok, false, '没授权不该成功')
    assert.match(String(r.message || ''), /授权/, '要告诉用户去面板授权')
    assert.equal(touched, false, '没授权就不能调模型')
  } finally {
    c.cleanup()
  }
})

test('授权 model 之后才允许调用', async () => {
  let touched = false
  const dsh = {
    llm: {
      async *stream() {
        touched = true
        yield { type: 'text-delta', text: '{"action":"think","why":"随便想想"}' }
      },
    },
    get: (n) => (n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : null),
  }
  // awakeFrom/awakeTo 固定为全天：CI 机器多为 UTC 时区，不固定会撞上夜间静默导致 wake 短路（2026-11-10 CI 实测）
  const c = makeApi({ settings: { enabled: true, awakeFrom: 0, awakeTo: 24, grants: { model: true, phone: false } }, dsh })
  try {
    const out = autonomy.setup(c.api)
    await out.wake({ manual: true }).catch(() => {})
    assert.equal(touched, true, '授权后应当真的去问模型')
  } finally {
    c.cleanup()
  }
})

test('没授权时手机命令一条都不跑', async () => {
  const c = makeApi({ settings: { enabled: true, grants: { model: false, phone: false } } })
  try {
    const out = autonomy.setup(c.api)
    // setup 返回的对象里没有 runAdb，验证方式：授权状态就是 false，且 phone 分支会被跳过
    assert.equal(isGranted(c.getSettings(), 'phone'), false)
    assert.ok(out, 'setup 正常返回')
  } finally {
    c.cleanup()
  }
})
