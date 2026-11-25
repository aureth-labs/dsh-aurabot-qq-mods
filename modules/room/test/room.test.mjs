// 小鱼小屋的离线自测：用假的 api 跑 setup，不连 DSH、不发消息。
// 覆盖：初始状态、买/卖/摆放、每日上限、心情降级、面板路由、目录清理。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mod from '../index.mjs'

let dir
let cfg
let moodImpl

// 假的扩展 API：只实现 room 用到的那几个
function makeApi() {
  const routes = {}
  const events = {}
  const tools = {}
  const commands = {}
  return {
    routes,
    events,
    tools,
    commands,
    dataDir: () => dir,
    settings: () => cfg,
    log: { info() {}, warn() {}, error() {} },
    route: (path, fn) => { routes[path] = fn },
    on: (name, fn) => { (events[name] ||= []).push(fn) },
    defineTool: (t) => { tools[t.name] = t },
    command: (c) => { commands[c.name] = c },
    context: () => {},
    rule: () => {},
    use: (id) => {
      if (id === 'mood') return moodImpl()
      return null
    },
    core: { http: { body: async (req) => req.body || {} } },
  }
}

function boot(settings = {}) {
  cfg = { coinName: '鱼币', startCoins: 420, earnPerMessage: 1, earnPerDay: 60, ...settings }
  moodImpl = () => { throw new Error('mood 模块没装') }
  const api = makeApi()
  const out = mod.setup(api)
  return { api, out }
}

// 还没写过盘时返回一份空状态，省得每个用例都先 state() 一下
const read = () => {
  const f = join(dir, 'room.json')
  if (!existsSync(f)) return { coins: 0, items: [], earn: { day: '', got: 0 } }
  return JSON.parse(readFileSync(f, 'utf8'))
}

beforeEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = mkdtempSync(join(tmpdir(), 'room-test-'))
})

test('初始状态：余额是初始值，屋里只有小鱼', () => {
  const { out } = boot()
  const s = out.state()
  assert.equal(s.coins, 420)
  assert.equal(s.coinName, '鱼币')
  assert.equal(s.items.length, 1)
  assert.equal(s.items[0].kind, 'fish')
  assert.equal(s.items[0].name, '小鱼')
  assert.equal(s.catalog.length, 18)
  assert.ok(s.catalog.every((c) => c.owned === false))
})

test('首次落盘后能读回来，小鱼不会重复加', () => {
  const { api, out } = boot()
  api.events.activity.forEach((fn) => fn({ kind: 'in', text: '我回来了' }))
  assert.ok(existsSync(join(dir, 'room.json')), '有动静就写盘')
  out.state()
  out.state()
  assert.equal(read().items.filter((i) => i.kind === 'fish').length, 1)
})

test('买家具要扣钱；重复买、没这种、钱不够都要拒绝', () => {
  const { out } = boot()
  const r1 = out.buy('rug')
  assert.equal(r1.ok, true)
  assert.match(r1.message, /买下了地毯/)
  assert.equal(read().coins, 420 - 40)

  assert.equal(out.buy('rug').ok, false, '已经有地毯了')
  assert.match(out.buy('rug').message, /已经有/)
  assert.equal(out.buy('nope').ok, false)
  assert.match(out.buy('nope').message, /没有这个家具/)

  assert.match(out.buy('fish').message, /不用买/)
  assert.equal(read().coins, 420 - 40, '拒绝时不能扣钱')
})

test('钱不够时不扣钱，提示还差多少', () => {
  const { api, out } = boot({ startCoins: 100 })
  api.events.activity.forEach((fn) => fn({ kind: 'in', text: '在吗' })) // 攒到 101，顺便落盘
  const r = out.buy('pc') // 200
  assert.equal(r.ok, false)
  assert.match(r.message, /还差 99/)
  assert.equal(read().coins, 101, '拒绝时余额一分不动')
})

test('摆放：坐标被夹在 0–100，没有的东西摆不了', () => {
  const { out } = boot()
  out.buy('desk')
  out.place('desk', 140, -20)
  const it = read().items.find((i) => i.kind === 'desk')
  assert.equal(it.x, 100)
  assert.equal(it.y, 0)

  out.place('desk', 12.5, 66)
  const it2 = read().items.find((i) => i.kind === 'desk')
  assert.equal(it2.x, 12.5)
  assert.equal(it2.y, 66)

  assert.equal(out.place('sofa', 10, 10).ok, false, '没买沙发')
})

test('卖掉退一半，小鱼卖不掉', () => {
  const { out } = boot()
  out.buy('sofa') // 120
  const coinsAfterBuy = read().coins
  const r = out.sell('sofa')
  assert.equal(r.ok, true)
  assert.equal(read().coins, coinsAfterBuy + 60)
  assert.equal(read().items.some((i) => i.kind === 'sofa'), false)

  assert.equal(out.sell('fish').ok, false)
  assert.match(out.sell('fish').message, /不能把小鱼卖掉/)
})

test('每日上限：聊再多次也只涨到 earnPerDay', () => {
  const { api } = boot({ startCoins: 0, earnPerMessage: 5, earnPerDay: 20 })
  const fire = () => api.events.activity.forEach((fn) => fn({ kind: 'in', text: '在吗' }))
  for (let i = 0; i < 20; i++) fire()
  assert.equal(read().coins, 20, '20 封顶')
  assert.equal(read().earn.got, 20)
})

test('非入站消息不涨币；earning 关掉也不涨', () => {
  const { api } = boot({ startCoins: 0 })
  api.events.activity.forEach((fn) => fn({ kind: 'out', text: '我说的话' }))
  assert.equal(read().coins, 0, '自己发的消息不该涨币')

  const { api: api2 } = boot({ startCoins: 0, earnPerMessage: 0 })
  api2.events.activity.forEach((fn) => fn({ kind: 'in', text: '你好' }))
  assert.equal(read().coins, 0)
})

test('过了一天，每日额度会重置', () => {
  const { out } = boot({ startCoins: 0 })
  out.state()
  const d = read()
  d.earn = { day: '2000-01-01', got: 60 }
  writeFileSync(join(dir, 'room.json'), JSON.stringify(d), 'utf8')
  const { api } = boot({ startCoins: 0 })
  api.events.activity.forEach((fn) => fn({ kind: 'in', text: '早' }))
  assert.equal(read().earn.got, 1, '新的一天从 0 开始重新攒')
})

test('心情：拿不到 mood 模块就返回 null，不崩', () => {
  const { out } = boot()
  assert.equal(out.state().mood, null)
})

test('心情：mood 模块可用时带上数值和标签', () => {
  boot()
  moodImpl = () => ({ state: () => ({ value: 72 }), label: () => '心情不错' })
  const out = mod.setup(makeApi())
  const s = out.state()
  assert.equal(s.mood.value, 72)
  assert.equal(s.mood.label, '心情不错')
})

test('心情：没有模块时退回读 plugins-data/aurabot/mood.json', () => {
  boot()
  const root = join(dir, '..', '..')
  writeFileSync(join(root, 'mood.json'), JSON.stringify({ value: 33 }), 'utf8')
  try {
    const out = mod.setup(makeApi())
    assert.equal(out.state().mood.value, 33)
  } finally {
    rmSync(join(root, 'mood.json'), { force: true })
  }
})

test('一键布置：已有的挪到原位，缺的只补 8 件基础款', () => {
  const { out } = boot({ startCoins: 1000 })
  out.buy('tv') // 装饰件，preset 不该再买别的贵东西
  const r = out.preset()
  assert.equal(r.ok, true)
  const d = read()
  assert.equal(d.items.find((i) => i.kind === 'tv').x, 46, '电视被挪到标准位')
  assert.equal(d.items.find((i) => i.kind === 'rug').x, 46)
  assert.equal(d.items.find((i) => i.kind === 'desk').x, 33)
  assert.equal(d.items.find((i) => i.kind === 'fish').x, 49, '小鱼也在标准位')
  for (const k of ['shelf', 'mirror', 'cushion', 'pc']) {
    assert.equal(d.items.some((i) => i.kind === k), false, `${k} 不该被自动买`)
  }
})

test('一键布置：钱不够就只摆已有的，不会把余额扣成负数', () => {
  const { out } = boot({ startCoins: 50 })
  out.preset()
  const d = read()
  assert.ok(d.coins >= 0)
  assert.equal(d.items.some((i) => i.kind === 'bed'), false, '5 件买不起')
})

test('面板路由：/state /buy /place /sell /preset 都能用', async () => {
  const { api, out } = boot({ startCoins: 500 })
  const st = await api.routes['/state']({})
  assert.equal(st.ok, true)
  assert.equal(st.coins, 500)

  const bought = await api.routes['/buy']({ body: { kind: 'lamp' } })
  assert.equal(bought.ok, true)
  assert.equal(read().coins, 410)

  const placed = await api.routes['/place']({ body: { kind: 'lamp', x: 30, y: 40 } })
  assert.equal(placed.ok, true)
  assert.equal(read().items.find((i) => i.kind === 'lamp').x, 30)

  const sold = await api.routes['/sell']({ body: { kind: 'lamp' } })
  assert.equal(sold.ok, true)
  assert.equal(read().coins, 410 + 45)

  const pre = await api.routes['/preset']({})
  assert.equal(pre.ok, true)
  await out.state()
})

test('房间文件里混进未知家具会被清掉，小鱼留下', () => {
  writeFileSync(join(dir, 'room.json'), JSON.stringify({
    coins: 99,
    items: [
      { kind: 'fish', x: 1, y: 2 },
      { kind: 'rocket', x: 5, y: 5 },
      { kind: 'desk', x: 10, y: 20 },
    ],
    earn: { day: '2000-01-01', got: 0 },
  }), 'utf8')
  const { out } = boot()
  const s = out.state()
  assert.deepEqual(s.items.map((i) => i.kind).sort(), ['desk', 'fish'])
  assert.equal(s.coins, 99, '已有余额不被覆盖')
})

test('工具与命令：按名字模糊找家具，找不到给提示', async () => {
  const { api, out } = boot({ startCoins: 300 })
  assert.match(await api.tools.room_buy.execute({ item: '台灯' }), /买下了鲸鱼台灯/)
  assert.match(await api.tools.room_move.execute({ item: '台灯', x: 10, y: 20 }), /摆好了/)
  assert.match(await api.tools.room_buy.execute({ item: '宇宙飞船' }), /没有这种家具/)
  assert.match(await api.tools.room_status.execute({}), /余额 210 鱼币/)

  assert.match(await api.commands['买'].run('沙发'), /买下了深蓝沙发椅/)
  assert.match(await api.commands['给币'].run('100'), /给了 \+100/)
  assert.match(await api.commands['房间'].run(''), /【我的小屋】/)
})
