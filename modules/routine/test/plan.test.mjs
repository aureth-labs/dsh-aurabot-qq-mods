// 她自己拿主意那一层：池子覆盖 / 干活推进 / 摸鱼概率 / 出门概率 / 决定落地（日志·心情·记忆·分享）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { PROFESSIONS } from '../professions.mjs'
import { WORK_TASKS, SLACKS, OUTINGS, tasksFor, newTask, advance, willSlack, willGoOut, newOuting, doWork, doSlack, taskFailed, leaderOf, caughtChance, pickFresh } from '../plan.mjs'

const mod = (await import(pathToFileURL(fileURLToPath(new URL('../index.mjs', import.meta.url))).href)).default

const DIRS = []
process.on('exit', () => { for (const d of DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

const at = (day, hm) => { const [y, m, d] = day.split('-').map(Number); const [h, mi] = hm.split(':').map(Number); return new Date(y, m - 1, d, h, mi).getTime() }
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }
const MON = '2026-11-16' // 周一
const SAT = '2026-11-21' // 周六

// 固定随机序列：测概率分支时别靠运气
function withRand(seq, fn) {
  const orig = Math.random
  let i = 0
  Math.random = () => seq[i++ % seq.length]
  try { return fn() } finally { Math.random = orig }
}

function makeApi({ settings = {}, ext = { livin: { enabled: true } } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'routine-plan-'))
  DIRS.push(dir) // 每个用例独立数据目录，状态不串
  const config = { ownerQQ: '10001', ext: { ...ext } }
  const sent = []
  const remembered = []
  const nudges = []
  const logs = []
  const api = {
    id: 'routine',
    settings: () => ({ ...settings }),
    saveSettings: (p) => Object.assign(settings, p),
    config: () => config,
    setConfig: (p) => { if (p.ext) for (const [k, v] of Object.entries(p.ext)) config.ext[k] = { ...(config.ext[k] || {}), ...v }; return config },
    dataDir: (...p) => join(dir, ...p),
    use: (id) => id === 'mood'
      ? { nudge: (d, why) => nudges.push({ d, why }), state: () => ({ value: 60 }), label: () => '平静' }
      : id === 'memory' ? { addEvent: (e) => remembered.push(e) } : null,
    send: (chatId, text) => sent.push({ chatId, text }),
    log: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m), debug: () => {} },
    every: () => {}, later: () => {}, on: () => {}, route: () => {}, command: () => {},
    tool: () => {}, defineTool: (t) => t, context: () => {},
    core: { http: { body: async () => ({}) } },
  }
  return { api, config, sent, remembered, nudges, logs }
}

test('每个职业都有活可干：任务池不落空、至少三条、扣题不串行', () => {
  for (const id of Object.keys(PROFESSIONS)) {
    const pool = tasksFor(id)
    assert.ok(Array.isArray(pool) && pool.length >= 3, `${id} 的活太少`)
    assert.equal(pool, WORK_TASKS[id], `${id} 应该有专属池子，不要落到 office`)
    for (const t of pool) assert.ok(typeof t === 'string' && t.length >= 4 && !t.includes('undefined'))
  }
})

test('池子够大：每个职业 ≥16 条活、摸鱼 ≥20 种、去处 ≥20 个，且互不重复', () => {
  for (const [id, pool] of Object.entries(WORK_TASKS)) {
    assert.ok(pool.length >= 16, `${id} 只有 ${pool.length} 条活，容易重样`)
    assert.equal(new Set(pool).size, pool.length, `${id} 的池子里有重复条目`)
  }
  assert.ok(SLACKS.length >= 20, `摸鱼只有 ${SLACKS.length} 种`)
  assert.ok(OUTINGS.length >= 20, `去处只有 ${OUTINGS.length} 个`)
  assert.equal(new Set(SLACKS).size, SLACKS.length, '摸鱼条目有重复')
  assert.equal(new Set(OUTINGS).size, OUTINGS.length, '去处有重复')
})

test('pickFresh：避开用过的；整池都用完才允许重样', () => {
  assert.equal(pickFresh(['a', 'b', 'c'], ['a', 'b'], () => 0), 'c')
  assert.equal(pickFresh(['a', 'b'], ['a', 'b'], () => 0), 'a', '全用过时回退到原池，不能返回 undefined')
})

test('同一天的几条活不重样：avoid 把已经抽到的挡掉', () => {
  const now = at(MON, '10:00')
  const used = []
  for (let i = 0; i < 10; i++) {
    const t = newTask('office', now, { hours: 3, avoid: used })
    used.push(t.title)
  }
  assert.equal(new Set(used).size, 10, `10 次抽到了重复的活：${used.join(' / ')}`)
})

test('摸鱼与出门也不连着重样，且说的和记的是同一件事', () => {
  const now = at(MON, '10:00')
  const seen = []
  for (let i = 0; i < 12; i++) {
    const d = doSlack({ profId: 'nurse', recent: seen, rand: () => 0.99 })
    if (d.kind === 'slack') { seen.push(d.text); assert.equal(d.say, d.text, '说的和记的必须同一件事') }
  }
  assert.equal(new Set(seen).size, seen.length, `摸鱼重样了：${seen.join(' / ')}`)

  const acts = []
  for (let i = 0; i < 10; i++) {
    const o = newOuting(now, { recent: acts, rand: () => 0.5 })
    acts.push(o.act)
  }
  assert.equal(new Set(acts).size, 10, `去的地方重样了：${acts.join(' / ')}`)
})

test('newTask：截止时间落在 hours 附近，进度从 0 起，标题来自本职业池', () => {
  const now = at(MON, '10:00')
  const t = newTask('nurse', now, { rand: () => 0.5, hours: 3 })
  assert.equal(t.progress, 0)
  assert.equal(t.done, false)
  assert.ok(t.deadline > now)
  assert.ok(t.deadline - now > 2 * 3600_000 && t.deadline - now < 4.5 * 3600_000, `到期应在 2~4.5 小时内：${(t.deadline - now) / 3600_000}h`)
  assert.ok(tasksFor('nurse').includes(t.title))
})

test('advance：一次推进 25%~45%，两到三次能干完，不会超过 100', () => {
  const t = { progress: 0 }
  let rounds = 0
  while (!advance(t, () => 0.5)) { rounds++ ; if (rounds > 10) break }
  assert.ok(t.progress === 100)
  const t2 = { progress: 95 }
  advance(t2, () => 0.5)
  assert.equal(t2.progress, 100, '封顶 100')
})

test('willSlack：心情差更容易摸鱼，手上有急活就不敢摸', () => {
  const now = at(MON, '10:00')
  const count = (opts) => { let n = 0; for (let i = 0; i < 2000; i++) if (willSlack({ now, ...opts })) n++; return n }
  const calm = count({ mood: 70, pressure: 10 })
  const down = count({ mood: 30, pressure: 10 })
  const urgent = count({ mood: 30, pressure: 10, urgent: true })
  assert.ok(down > calm + 100, `心情差该更想摸鱼：${calm} vs ${down}`)
  assert.ok(urgent < down - 100, `有急活该收敛：${down} vs ${urgent}`)
})

test('willGoOut：夜里/心情差更想窝着，白天心情好更愿意出门', () => {
  const count = (day, hm, opts = {}) => { const now = at(day, hm); let n = 0; for (let i = 0; i < 2000; i++) if (willGoOut({ now, ...opts })) n++; return n }
  const afternoon = count(SAT, '15:00', { mood: 70, pressure: 20 })
  const night = count(SAT, '21:30', { mood: 70, pressure: 20 })
  const low = count(SAT, '15:00', { mood: 30, pressure: 20 })
  assert.ok(afternoon > night + 200, `晚上该更不想出门：${afternoon} vs ${night}`)
  assert.ok(afternoon > low + 200, `心情差该更想窝着：${afternoon} vs ${low}`)
})

test('newOuting：时长在 1~3.5 小时，去处来自池子，记得回程时间', () => {
  const now = at(SAT, '14:00')
  const o = newOuting(now, { rand: () => 0.99 })
  assert.ok(o.until > now + 3600_000 * 0.9 && o.until <= now + 3600_000 * 3.6)
  assert.ok(typeof o.act === 'string' && o.act.length > 0)
})

test('摸鱼被抓：严格的职业更容易被抓，被抓心情 -6；没被抓心情 +2', () => {
  assert.ok(caughtChance('nurse') > caughtChance('programmer'))
  const caught = doSlack({ profId: 'nurse', rand: () => 0.01 })
  assert.equal(caught.kind, 'slack-caught')
  assert.equal(caught.mood, -6)
  assert.match(caught.text, new RegExp(leaderOf('nurse')))
  const free = doSlack({ profId: 'programmer', rand: () => 0.5 })
  assert.equal(free.kind, 'slack')
  assert.equal(free.mood, 2)
})

test('taskFailed：主管按职业称呼，心情 -8，进记忆', () => {
  const f = taskFailed({ task: { id: 't1', title: '核对三床的用药单' }, profId: 'nurse' })
  assert.match(f.text, /护士长/)
  assert.equal(f.mood, -8)
  assert.equal(f.memory, true)
})

test('工作日：进班就备好今天的活，决定按间隔节流，不会每个 tick 刷一条', () => {
  const { api } = makeApi({ settings: { enabled: true, planIntervalMin: 30, tasksPerDay: 2, taskOn: true, planShareChance: 0 } })
  const exp = mod.setup(api)
  const t0 = at(MON, '10:00')
  withRand([0.5], () => {
    exp.planTick(t0, exp.stateAt(t0))
    assert.equal(exp.plan().tasks.length, 2, '两条活')
    const n1 = exp.plan().log.length
    assert.ok(n1 >= 1, '第一次决定应该有日志')
    exp.planTick(t0 + 10 * 60_000, exp.stateAt(t0 + 10 * 60_000))
    assert.equal(exp.plan().log.length, n1, '10 分钟后不该再做决定')
    exp.planTick(t0 + 31 * 60_000, exp.stateAt(t0 + 31 * 60_000))
    assert.ok(exp.plan().log.length > n1, '过了间隔才做下一次决定')
  })
})

test('超时没做完：标失败、心情下降、进记忆、写日志（只记一次）', () => {
  const { api, nudges, remembered } = makeApi({ settings: { enabled: true, planIntervalMin: 30, tasksPerDay: 1, taskOn: true, planShareChance: 0 } })
  const exp = mod.setup(api)
  const t0 = at(MON, '10:00')
  withRand([0.5], () => exp.planTick(t0, exp.stateAt(t0)))
  const task = exp.plan().tasks[0]
  task.deadline = t0 - 60_000 // 已经过期
  withRand([0.5], () => exp.planTick(t0, exp.stateAt(t0)))
  assert.equal(task.failed, true)
  assert.equal(nudges.filter((n) => n.d === -8).length, 1)
  assert.ok(remembered.some((m) => String(m.text).includes(task.title)))
  const before = exp.plan().log.length
  withRand([0.5], () => exp.planTick(t0 + 60_000, exp.stateAt(t0 + 60_000)))
  assert.equal(exp.plan().log.length, before, '同一条活不该反复记失败')
})

test('休息日出门：关掉过日子、日志有记录；到点回家，过日子还回来并写进记忆', () => {
  const { api, config, remembered } = makeApi({ settings: { enabled: true, planIntervalMin: 30, planShareChance: 0 } })
  const exp = mod.setup(api)
  const t0 = at(SAT, '14:00')
  // 0.01：willGoOut 命中；newOuting 里 0.01 取池子第一条、时长最短
  withRand([0.01], () => exp.planTick(t0, exp.stateAt(t0)))
  const outing = exp.plan().outing
  assert.ok(outing, '应该出门了')
  assert.equal(config.ext.livin.enabled, false, '出门了就别在家找乐子')
  assert.equal(exp.plan().log.at(-1).kind, 'out')

  // 到点回来（超过 until）
  const back = outing.until + 60_000
  withRand([0.01], () => exp.planTick(back, exp.stateAt(back)))
  assert.equal(exp.plan().outing, null)
  assert.equal(config.ext.livin.enabled, true, '回家了过日子要开回来')
  assert.equal(exp.plan().log.at(-1).kind, 'out-back')
  assert.ok(remembered.length >= 1, '出去玩要进记忆')
})

test('分享：概率 100 时说一次，45 分钟内不重复说；说的是第一人称短句', () => {
  const { api, sent } = makeApi({ settings: { enabled: true, planIntervalMin: 30, tasksPerDay: 1, taskOn: true, planShareChance: 100 } })
  const exp = mod.setup(api)
  const t0 = at(MON, '10:00')
  withRand([0.5], () => exp.planTick(t0, exp.stateAt(t0)))
  assert.equal(sent.length, 1, '该主动说一声')
  assert.equal(sent[0].chatId, 'private:10001')
  // 30 分钟后再次决定，但 45 分钟间隔没到
  withRand([0.5], () => exp.planTick(t0 + 31 * 60_000, exp.stateAt(t0 + 31 * 60_000)))
  assert.equal(sent.length, 1, '间隔内不再刷')
  // 过了 45 分钟才允许再说
  withRand([0.5], () => exp.planTick(t0 + 62 * 60_000, exp.stateAt(t0 + 62 * 60_000)))
  assert.equal(sent.length, 2)
})

test('托管没开就不拿主意：只备活不决定，日志不动', () => {
  const { api } = makeApi({ settings: { enabled: false, planIntervalMin: 30 } })
  const exp = mod.setup(api)
  const t0 = at(MON, '10:00')
  withRand([0.5], () => exp.planTick(t0, exp.stateAt(t0)))
  assert.equal(exp.plan().log.length, 0)
  assert.equal(exp.plan().tasks.length, 0)
})

test('跨天重置：昨天的活和出门不带进今天', () => {
  const { api } = makeApi({ settings: { enabled: true, planIntervalMin: 30, tasksPerDay: 1, taskOn: true, planShareChance: 0 } })
  const exp = mod.setup(api)
  const t1 = at(MON, '10:00')
  withRand([0.5], () => exp.planTick(t1, exp.stateAt(t1)))
  assert.ok(exp.plan().tasks.length > 0)
  const t2 = at('2026-11-17', '09:30')
  withRand([0.5], () => exp.planTick(t2, exp.stateAt(t2)))
  assert.equal(exp.plan().day, dayKey(t2))
  assert.ok(exp.plan().tasks.every((tk) => tk.at >= t2 - 60_000), '新一天重新备活')
})

test('doWork：有活推进并给进度，做完给心情加成；没活时只收个尾', () => {
  const t = { id: 'x', title: '把接口文档补完', progress: 0 }
  const step = doWork({ task: t, rand: () => 0.5 })
  assert.equal(step.kind, 'work')
  assert.match(step.text, /把接口文档补完/)
  assert.match(step.text, /\d+%/)
  t.progress = 90
  const done = doWork({ task: t, rand: () => 0.99 })
  assert.equal(done.kind, 'task-done')
  assert.equal(done.mood, 5)
  const idle = doWork({ task: null })
  assert.equal(idle.kind, 'work')
  assert.equal(idle.mood, 1)
})
