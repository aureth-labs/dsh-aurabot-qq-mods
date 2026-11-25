// 小游戏合集 · 冒烟测试（mock api，零联网；真下完三个游戏）
import assert from 'node:assert'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'

const dir = mkdtempSync(join(tmpdir(), 'minigame-test-'))
const routes = {}
const jobs = []
const nudges = []
const commands = []
let tools = null
let settingsVar = { enabled: true, intervalMinutes: 30, maxKeep: 30 }

const api = {
  dataDir: () => dir,
  settings: () => ({ ...settingsVar }),
  saveSettings: (patch) => { Object.assign(settingsVar, patch) },
  log: { info() {}, warn() {}, error() {} },
  use: (name) => (name === 'mood' ? { nudge: (...args) => nudges.push(args) } : null),
  tool: (fn) => { tools = fn() },
  context: (fn) => { fn() },
  command: (c) => { commands.push(c) },
  route: (p, fn) => { routes[p] = fn },
  every: (ms, fn, name) => { jobs.push({ ms, fn, name }) },
  emit: () => {},
  core: { http: { body: async (req) => req.__body } },
  defineTool: (p) => p,
}

const hooks = mod.setup(api)

test('模块元信息', () => {
  assert.equal(mod.id, 'minigame')
  assert.equal(mod.api, 1)
  assert.ok(mod.panel)
  assert.ok(Array.isArray(mod.settings) && mod.settings.length >= 2)
})

test('三个游戏都能下完并给出结果', () => {
  for (const id of ['2048', 'snake', 'minesweeper']) {
    const r = hooks.play(id)
    assert.equal(r.id, id, `${id} 返回 id 不对`)
    assert.ok(r.title, `${id} 缺 title`)
    assert.ok(r.detail, `${id} 缺 detail`)
    assert.equal(typeof r.won, 'boolean', `${id} 缺 won`)
  }
  assert.ok(hooks.stats().total >= 3, '总局数没累计')
})

test('战绩写盘且每游戏单独记', () => {
  const saved = JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8'))
  assert.ok(saved.total >= 3)
  assert.ok(saved.byGame['2048'] && saved.byGame['2048'].plays >= 1)
  assert.ok(saved.byGame.snake && saved.byGame.snake.plays >= 1)
  assert.ok(saved.byGame.minesweeper && saved.byGame.minesweeper.plays >= 1)
})

test('输赢会给她加心情', () => {
  assert.ok(nudges.length >= 3, '没有调用 mood.nudge')
})

test('工具与命令都在', () => {
  assert.ok(tools && tools.name === 'mini_game_play')
  assert.ok(commands.some((c) => c.name === '游戏'))
})

test('对局帧进 /live，面板能看现场', async () => {
  const live = await routes['/live']()
  assert.equal(live.ok, true)
  assert.ok(Array.isArray(live.frames) && live.frames.length > 0)
  assert.ok(live.byGame && live.byGame['2048'])
})

test('GET /state 汇总 + GET /play 当场玩一局', async () => {
  const st = await routes['/state']()
  assert.equal(st.ok, true)
  assert.ok(st.total >= 3 && Array.isArray(st.games))
  assert.equal(st.enabled, true)

  const before = st.total
  const r = await routes['/play']({ url: '/play?game=2048' })
  assert.equal(r.ok, true)
  assert.equal(r.id, '2048')
  const after = await routes['/state']()
  assert.equal(after.total, before + 1)
})

test('总开关：POST /enabled 落设置，关掉后自动玩不触发', async () => {
  const off = await routes['/enabled']({ __body: { on: false } })
  assert.equal(off.ok, true)
  assert.equal(off.enabled, false)
  assert.equal(settingsVar.enabled, false)

  const before = hooks.stats().total
  jobs[0].fn() // 自动玩定时器
  assert.equal(hooks.stats().total, before, '关掉后还在自动玩')

  const on = await routes['/enabled']({ __body: { on: true } })
  assert.equal(on.enabled, true)
  const st = await routes['/state']()
  assert.equal(st.enabled, true)
})
