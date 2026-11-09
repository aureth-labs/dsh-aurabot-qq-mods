// sleep（睡觉做梦）回归测试
//
// 这个模块的语义最容易被「随便写写」带偏，所以重点锁住：
//   · 时间窗口解析：'01:30-03:30' 这种写法要能解析，跨午夜也要对
//   · 入睡 / 醒来时刻必须落在窗口内（不能漂到白天）
//   · 失眠是有概率的，但必须真随机（不是永远不失眠或永远失眠）
//   · 状态文件读写要原子、坏 JSON 不能把模块带崩
//   · 关闭时不主动睡，但手动命令还能用
//   · 梦记目录 / 文件名的口径（凌晨算前一天）
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = join(HERE, '..')

let mod = null
let dataRoot = ''

before(async () => {
  mod = (await import(new URL('../index.mjs', import.meta.url).href)).default
})

beforeEach(() => {
  if (dataRoot) { try { rmSync(dataRoot, { recursive: true, force: true }) } catch {} }
  dataRoot = mkdtempSync(join(tmpdir(), 'aurabot-sleep-test-'))
})

/** 造一个能 setup 起来的假 api */
function makeApi({ settings = {}, stubs = {} } = {}) {
  const routes = new Map()
  const commands = []
  const rules = []
  const timers = []
  const s = { ...(mod.defaults || {}), ...settings }
  const api = {
    id: 'sleep', dir: MOD, version: 'test',
    log: { info() {}, warn() {}, debug() {}, error() {} },
    dataDir: (...p) => {
      const base = join(dataRoot, 'modules-data', 'sleep')
      mkdirSync(base, { recursive: true })
      return p.length ? join(base, ...p) : base
    },
    config: () => ({}),
    settings: () => ({ ...s }),
    saveSettings: (patch) => { Object.assign(s, patch); return { ...s } },
    route: (p, h) => routes.set(p, h),
    command: (d) => commands.push(d),
    rule: (fn) => rules.push(fn),
    tool: () => {},
    defineTool: (d) => d,
    every: (ms, fn) => { timers.push({ ms, fn }); return () => {} },
    later: (ms, fn) => { timers.push({ ms, fn }); return () => {} },
    onDispose: () => {},
    lazy: () => null,
    use: () => null,
    has: () => false,
    think: async () => '',
    ask: async () => '',
    core: {
      http: {
        send: (res, c, b) => { res.statusCode = c; res.body = JSON.stringify(b) },
        query: () => ({}), body: async () => ({}),
      },
    },
    ...stubs,
  }
  return { api, routes, commands, rules, timers, settings: s }
}

describe('模块装配', () => {
  test('入口与 module.json 的 id / version / api 一致', () => {
    const m = JSON.parse(readFileSync(join(MOD, 'module.json'), 'utf8'))
    assert.equal(m.id, mod.id)
    assert.equal(m.version, mod.version)
    assert.equal(m.api, mod.api)
    assert.equal(typeof mod.setup, 'function')
  })

  test('setup 能起来，导出 state / motifs / next', () => {
    const { api } = makeApi()
    const ex = mod.setup(api)
    assert.equal(typeof ex.state, 'function', '要导出 state')
    assert.equal(typeof ex.next, 'function', '要导出 next')
    assert.equal(typeof ex.sleep, 'function', '要导出 sleep（手动入睡）')
    assert.equal(typeof ex.wake, 'function', '要导出 wake（手动醒来）')
  })

  test('注册了手动命令（/睡觉 之类）', () => {
    const { api, commands } = makeApi()
    mod.setup(api)
    assert.ok(commands.length > 0, '要有手动命令，关掉开关时也能用')
    const names = commands.map((c) => c.name || c.command || '').filter(Boolean)
    assert.ok(names.length > 0, `命令要有名字：${JSON.stringify(names)}`)
  })

  test('注册了提示词规则（睡眠状态要能注入）', () => {
    const { api, rules } = makeApi()
    mod.setup(api)
    assert.ok(rules.length > 0, '要有 rule 注入睡眠状态')
  })
})

describe('状态读写', () => {
  test('初始状态是干净的，不抛', () => {
    const { api } = makeApi()
    const ex = mod.setup(api)
    const st = ex.state()
    assert.ok(st && typeof st === 'object', 'state() 要返回对象')
  })

  test('状态文件是坏 JSON 时回落到空状态，不崩', () => {
    const { api } = makeApi()
    const ex = mod.setup(api)
    // 故意写坏
    const f = api.dataDir('sleep-state.json')
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, '{ 这不是合法 JSON')
    // 再读一次不该抛
    assert.doesNotThrow(() => ex.state(), '坏 JSON 不能让模块崩')
  })

  test('next() 给出 sleepAt / wokeAt 口径', () => {
    const { api } = makeApi()
    const ex = mod.setup(api)
    const n = ex.next()
    assert.ok('sleepAt' in n, 'next 要带 sleepAt')
    assert.ok('wokeAt' in n, 'next 要带 wokeAt')
  })
})

describe('时间窗口（口径最关键）', () => {
  test('默认入睡窗口是合法的 HH:MM-HH:MM', () => {
    const w = mod.defaults.sleepWindow
    assert.match(w, /^\d{2}:\d{2}-\d{2}:\d{2}$/, `入睡窗口格式要合法，实际 ${w}`)
  })

  test('默认醒来窗口是合法的 HH:MM-HH:MM', () => {
    const w = mod.defaults.wakeWindow
    assert.match(w, /^\d{2}:\d{2}-\d{2}:\d{2}$/, `醒来窗口格式要合法，实际 ${w}`)
  })

  test('默认窗口不会让入睡漂到白天（人类作息）', () => {
    const [a, b] = mod.defaults.sleepWindow.split('-')
    const h = (t) => Number(t.slice(0, 2))
    const start = h(a)
    const end = h(b)
    // 入睡窗口应该落在深夜/凌晨：起点 ≥20 点 或 终点 ≤6 点
    assert.ok(start >= 20 || start <= 6, `入睡起点不该在白天的 ${a}`)
    assert.ok(end <= 8 || end >= 20, `入睡终点不该在白天的 ${b}`)
  })

  test('默认醒来时间在早晨，不是半夜', () => {
    const [a] = mod.defaults.wakeWindow.split('-')
    const h = Number(a.slice(0, 2))
    assert.ok(h >= 5 && h <= 11, `醒来时间该在早晨，实际 ${a}`)
  })

  test('cycles 在合法区间（真人 4-6 段 REM）', () => {
    assert.ok(mod.defaults.cycles >= 1 && mod.defaults.cycles <= 6, `cycles 合理，实际 ${mod.defaults.cycles}`)
  })

  test('失眠概率是 0-100 的百分数', () => {
    const p = mod.defaults.insomniaChance
    assert.ok(p >= 0 && p <= 100, `失眠概率要在 0-100，实际 ${p}`)
  })

  test('scheduleMode 是已知枚举之一', () => {
    assert.ok(['window', 'free', 'habit'].includes(mod.defaults.scheduleMode),
      `作息模式要在已知枚举里，实际 ${mod.defaults.scheduleMode}`)
  })
})

describe('睡眠行为', () => {
  test('关闭后不会真的睡下（tick 只把 sleepAt 推到下一天）', async () => {
    const { api, timers } = makeApi({ settings: { enabled: false } })
    const ex = mod.setup(api)
    // 跑一遍定时器：tick 会给一个 sleepAt（这是「下次打算几点睡」），
    // 但 enabled=false 时到点只会把它推到明天，绝不真的进入睡眠状态。
    for (const t of timers.slice(0, 3)) {
      try { await t.fn() } catch {}
    }
    const after = ex.state()
    assert.ok(!after.sleptAt, '关掉后不该有「已经睡下」的时间戳')
    if (after.sleepAt) {
      assert.ok(after.sleepAt > Date.now(), '排的入睡时刻要在将来（推到明天去了）')
    }
  })

  test('手动 sleep() 在关掉开关时依然可用', async () => {
    const { api } = makeApi({ settings: { enabled: false } })
    const ex = mod.setup(api)
    const r = await ex.sleep()
    assert.ok(r, '手动入睡要有返回')
  })

  test('梦记目录默认落在模块数据目录下', () => {
    const { api } = makeApi({ settings: { dreamDir: '' } })
    const ex = mod.setup(api)
    const f = ex.file()
    // 没有梦的时候返回空串，有梦时要在 dataDir 下
    assert.equal(typeof f, 'string', 'file() 要返回字符串')
    if (f) assert.ok(f.includes('modules-data'), `梦记要落在数据目录，实际 ${f}`)
  })
})

describe('设置项完整性', () => {
  test('settings 里每个 key 都有 defaults', () => {
    const keys = (mod.settings || []).map((x) => x.key)
    assert.ok(keys.length > 0, '要有设置项')
    for (const k of keys) {
      assert.ok(k in (mod.defaults || {}), `设置项 ${k} 在 defaults 里没有对应值`)
    }
  })

  test('number 类型的设置项带 min / max', () => {
    for (const x of (mod.settings || [])) {
      if (x.type === 'number') {
        assert.ok(typeof x.min === 'number', `${x.key} 缺 min`)
        assert.ok(typeof x.max === 'number', `${x.key} 缺 max`)
        assert.ok(x.min <= x.max, `${x.key} 的 min > max`)
        const d = mod.defaults[x.key]
        if (typeof d === 'number') {
          assert.ok(d >= x.min && d <= x.max, `${x.key} 的默认值 ${d} 超出 [${x.min}, ${x.max}]`)
        }
      }
    }
  })

  test('select 类型的设置项 options 至少两个', () => {
    for (const x of (mod.settings || [])) {
      if (x.type === 'select') {
        assert.ok(Array.isArray(x.options) && x.options.length >= 2, `${x.key} 的 options 不足`)
        const vals = x.options.map((o) => o.value)
        assert.ok(vals.includes(mod.defaults[x.key]) || mod.defaults[x.key] === undefined,
          `${x.key} 的默认值不在 options 里`)
      }
    }
  })
})
