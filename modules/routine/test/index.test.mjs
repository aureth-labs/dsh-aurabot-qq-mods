// routine 作息模块验证：状态机 / livin 开关沿 / 三层日程覆盖 / 压力结账与请假 / 扰动生成 / 注入文本
// 直接挂真实模块文件 + 桩 api（同 livin-dayroll.test.mjs 的路子）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
const mod = (await import(pathToFileURL(fileURLToPath(new URL('../index.mjs', import.meta.url))).href)).default

const DIR = mkdtempSync(join(tmpdir(), 'routine-test-'))
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} })

const MONDAY_1030 = new Date('2026-11-16T10:30:00').getTime() // 2026-11-16 是周一

function makeApi({ ext = {}, settings = {} } = {}) {
  const config = { ext: { livin: { enabled: false }, ...ext } }
  const tools = []
  const contexts = []
  let logLines = []
  const api = {
    id: 'routine',
    settings: () => ({ ...settings }),
    saveSettings: (p) => Object.assign(settings, p),
    config: () => config,
    setConfig: (p) => { // 深合并，只动给的键（宿主 core/modules.js 的语义）
      if (p.ext) for (const [k, v] of Object.entries(p.ext)) config.ext[k] = { ...(config.ext[k] || {}), ...v }
      return config
    },
    dataDir: (...p) => join(DIR, ...p),
    use: (id) => (id === 'mood' ? { nudge: (d, reason) => { logLines.push(`nudge ${d} ${reason}`) }, label: () => '平静' } : null),
    log: { info: (m) => logLines.push(String(m)), warn: (m) => logLines.push('WARN ' + m), debug: () => {} },
    every: () => {}, later: () => {}, on: () => {}, route: () => {}, command: () => {},
    tool: (fn) => tools.push(...fn()),
    defineTool: (t) => t,
    context: (fn) => contexts.push(fn),
    core: { http: { body: async () => ({}) } },
  }
  return { api, config, tools, contexts, get logs() { return logLines } }
}

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }
const at = (day, hm) => { const [h, m] = hm.split(':').map(Number); return new Date(new Date(day).getFullYear(), new Date(day).getMonth(), new Date(day).getDate(), h, m).getTime() }
// 上面 new Date(day) 对 '2026-11-16' 会按 UTC 解析出本地 8 点，取 y/m/d 再拼，保证用本地时区
const D = (s) => { const [y, m, dd] = s.split('-').map(Number); return `${y}-${m}-${dd}` }

test('work 时段 stateAt 判 work 且 livin=false；setConfig 深合并只改 livin.enabled', async () => {
  const { api, config } = makeApi({ settings: { enabled: true } })
  const exp = mod.setup(api)
  const t1 = at(D('2026-11-16'), '10:30')
  const r1 = exp.stateAt(t1)
  assert.equal(r1.state, 'work')
  assert.equal(r1.livin, false)
  assert.equal(config.ext.livin.enabled, false)
})

test('stateAt：休息日全天 home，通勤窗在班段前', () => {
  const { api } = makeApi()
  const exp = mod.setup(api)
  const sat = '2026-11-21'
  assert.equal(exp.stateAt(at(D(sat), '15:00')).state, 'home')
  assert.equal(exp.stateAt(at(D(sat), '15:00')).livin, true)
  // 周一 08:45（默认通勤 30 分钟）：commute
  const mon = '2026-11-16'
  assert.equal(exp.stateAt(at(D(mon), '08:45')).state, 'commute')
  assert.equal(exp.stateAt(at(D(mon), '08:45')).livin, false)
  // 早上 8:10（出了睡觉时段、还没进通勤窗）：home
  assert.equal(exp.stateAt(at(D(mon), '08:10')).state, 'home')
  // 睡觉时段：sleep
  assert.equal(exp.stateAt(at(D(mon), '03:00')).state, 'sleep')
  // 下班后：home
  assert.equal(exp.stateAt(at(D(mon), '19:30')).state, 'home')
  exp // keep ref
})

test('三层覆盖：扰动 > 自记 > 底座', () => {
  const { api } = makeApi()
  const exp = mod.setup(api)
  const mon = '2026-11-16'
  // 自记 busy 覆盖不了已有扰动的日子
  exp.set({ disturb: [{ id: 'd1', day: D(mon), type: 'rest', segments: [], note: '调休' }] })
  assert.equal(exp.resolveDay(D(mon), new Date(at(D(mon), '10:00'))).type, 'rest')
  exp.set({ disturb: [] })
  // 自记 busy：周六值班
  exp.set({ self: [{ id: 's1', day: D('2026-11-21'), start: '10:00', end: '16:00', kind: 'busy', what: '值班' }] })
  const sat = exp.resolveDay(D('2026-11-21'), new Date(at(D('2026-11-21'), '12:00')))
  assert.equal(sat.type, 'work')
  assert.deepEqual(sat.segments, [[600, 960]])
  // 自记 off：工作日整天休
  exp.set({ self: [{ id: 's2', day: D(mon), kind: 'off', what: '年假' }] })
  assert.equal(exp.resolveDay(D(mon), new Date(at(D(mon), '12:00'))).type, 'rest')
  exp.set({ self: [] })
  // override 最高
  exp.set({ overrides: { [D(mon)]: { type: 'leave', note: '压力请假' } } })
  const ov = exp.resolveDay(D(mon), new Date(at(D(mon), '12:00')))
  assert.equal(ov.type, 'leave')
  assert.equal(ov.src, 'override')
})

test('注入：内容、长度、画图免责、system 不注入', () => {
  const { api, contexts } = makeApi({ settings: { enabled: true } })
  mod.setup(api)
  assert.equal(contexts.length, 1)
  const ctx = contexts[0]
  assert.equal(ctx({ chat: { kind: 'system' } }), '')
  const out = ctx({ chat: { kind: 'private' } })
  assert.match(out, /【此刻·作息】/)
  assert.match(out, /画稿/)
  assert.ok(out.length <= 160, `注入太长：${out.length}`)
})

test('压力：翻日结账只结一次，攒满自动请假并写 override', async () => {
  const { api: a, config } = makeApi({ settings: { enabled: true, pressureOn: true, pressureThreshold: 20, pressurePerWorkDay: 10, pressureLeaveRecover: 25 } })
  const exp = mod.setup(a)
  const mon = '2026-11-16' // 周一
  // 周一上班日 → 周二翻日结账 +10，到 10；周二又上班 +10 = 20 达阈值 → 周三请假
  const tTue = at(D('2026-11-17'), '09:30')
  exp.set({ day: D(mon), pressure: 0, overrides: {}, disturb: [], self: [] })
  await exp.rollDay(tTue)
  assert.equal(exp.st().pressure, 10)
  assert.ok(!exp.st().overrides[D('2026-11-18')])
  const tWed = at(D('2026-11-18'), '09:30')
  await exp.rollDay(tWed)
  // 周二也是上班日：+10 = 20 >= 20 → 触发请假（周四），压力 -25
  assert.equal(exp.st().pressure, 0)
  assert.equal(exp.st().overrides[D('2026-11-19')].type, 'leave')
  // 同一天再翻不重复结账/不重复请假
  await exp.rollDay(at(D('2026-11-18'), '15:00'))
  assert.equal(exp.st().overrides[D('2026-11-20')], undefined)
})

test('扰动生成：一周最多两条，只落休→班或班→休', () => {
  const { api } = makeApi()
  const exp = mod.setup(api)
  const sun = '2026-11-22' // 周日
  const t = at(D(sun), '20:00')
  exp.set({ disturb: [], distWeek: '' })
  exp.genDisturb(t)
  const d = exp.st().disturb
  assert.ok(d.length <= 2)
  for (const e of d) {
    assert.ok(['work', 'rest'].includes(e.type))
    if (e.type === 'work') assert.ok(e.segments.length > 0)
    assert.match(e.note, /临时加班|调休/)
  }
})

test('托管开启沿：tick 检测到 enabled false→true 立刻对齐 livin，不等状态沿', async () => {
  const settings = { enabled: false, pressureOn: true }
  const { api, config } = makeApi({ settings })
  const exp = mod.setup(api)
  // 周一 10:30 是班段内（work）——但不能控 Date.now()，改在真实时刻跑逻辑：直接调用导出的 tick
  // tick 用 Date.now()，当前真实时刻是什么状态就按什么状态断言「对齐到该状态的 livin 值」
  await exp.tick()
  const before = config.ext.livin.enabled
  // 关掉再打开托管，模拟开启沿
  settings.enabled = false
  await exp.tick()
  settings.enabled = true
  await exp.tick()
  const res = exp.stateAt(Date.now())
  assert.equal(config.ext.livin.enabled, res.livin === true)
  assert.equal(exp.st().managedOn, true)
  // 稳定态下再 tick 不改写（沿才写）
  const stable = config.ext.livin.enabled
  await exp.tick()
  assert.equal(config.ext.livin.enabled, stable)
  void before
})

test('存盘原子化：无 .tmp 残留', async () => {
  const { api } = makeApi()
  const exp = mod.setup(api)
  await exp.rollDay(at(D('2026-11-17'), '09:30'))
  const files = readdirSync(DIR)
  assert.ok(!files.some((f) => f.endsWith('.tmp')), '有 .tmp 残留：' + files.join(','))
  assert.ok(files.includes('routine.json') && files.includes('schedule.json'))
})

// ---------- 多职业（v1.1.0） ----------
// 轮班周序号：锚点 2024-01-01（周一），2026-11-16 那周 idx=150（%3=0 白班/早班/大周末，%2=0 白班/大周末）
// idx1 = 2026-11-23 那周（小夜/中班/小周末/工厂夜班），idx2 = 2026-11-30 那周（大夜/夜班）

test('多职业：餐饮双班——午市/班间/晚市/下班，周二轮休', () => {
  const { api } = makeApi({ settings: { profession: 'restaurant' } })
  const exp = mod.setup(api)
  exp.applyProfession(at(D('2026-11-16'), '10:00'))
  const mon = '2026-11-16'
  const r1 = exp.stateAt(at(D(mon), '11:00'))
  assert.equal(r1.state, 'work')
  assert.match(r1.label, /10:00–14:00/)
  const r2 = exp.stateAt(at(D(mon), '15:00'))
  assert.equal(r2.state, 'home')
  assert.match(r2.label, /班间休息/)
  assert.equal(r2.livin, true)
  assert.equal(exp.stateAt(at(D(mon), '20:00')).state, 'work')
  const r4 = exp.stateAt(at(D(mon), '22:30'))
  assert.equal(r4.state, 'home')
  assert.match(r4.label, /下班到家/)
  const tue = exp.stateAt(at(D('2026-11-17'), '15:00'))
  assert.equal(tue.state, 'home')
  assert.match(tue.label, /休息日/)
})

test('多职业：护士三班倒——白班周/大夜周，凌晨压过睡觉时段，下夜班补觉', () => {
  const { api } = makeApi({ settings: { profession: 'nurse' } })
  const exp = mod.setup(api)
  // 白班周（idx0）：周一 15:00 上班，周六休
  exp.applyProfession(at(D('2026-11-16'), '10:00'))
  assert.equal(exp.stateAt(at(D('2026-11-16'), '15:00')).state, 'work')
  assert.equal(exp.stateAt(at(D('2026-11-21'), '15:00')).state, 'home')
  // 大夜周（idx2）：周一凌晨 3 点在班上（睡觉时段被班段压过），10 点下班补觉
  exp.applyProfession(at(D('2026-11-30'), '10:00'))
  const r3 = exp.stateAt(at(D('2026-11-30'), '03:00'))
  assert.equal(r3.state, 'work')
  assert.equal(r3.night, true)
  assert.match(r3.label, /夜班中/)
  assert.match(r3.label, /00:00–08:00/)
  const r10 = exp.stateAt(at(D('2026-11-30'), '10:00'))
  assert.equal(r10.state, 'home')
  assert.match(r10.label, /下夜班/)
  assert.equal(r10.livin, true)
})

test('多职业：医生周三夜班跨午夜，周四早上还是班上、下午补休', () => {
  const { api } = makeApi({ settings: { profession: 'doctor' } })
  const exp = mod.setup(api)
  exp.applyProfession(at(D('2026-11-16'), '10:00'))
  const wed = exp.stateAt(at(D('2026-11-18'), '16:00'))
  assert.equal(wed.state, 'work')
  const thuEarly = exp.stateAt(at(D('2026-11-19'), '06:00'))
  assert.equal(thuEarly.state, 'work') // 周三夜班延续到周四早上
  const thuNoon = exp.stateAt(at(D('2026-11-19'), '14:00'))
  assert.equal(thuNoon.state, 'home')
  assert.match(thuNoon.label, /休息日|请假|在家/)
  // 周六上午半天门诊：结束在中午前但不是夜班（v1.1.1 修正夜班启发式）
  const satAm = exp.stateAt(at(D('2026-11-21'), '10:00'))
  assert.equal(satAm.state, 'work')
  assert.equal(satAm.night, false)
  const satPm = exp.stateAt(at(D('2026-11-21'), '13:30'))
  assert.equal(satPm.state, 'home')
  assert.doesNotMatch(satPm.label, /下夜班/)
})

test('多职业：保安夜班周——周六凌晨 2 点在班上（前一天跨午夜段），周日凌晨也是', () => {
  const { api } = makeApi({ settings: { profession: 'security' } })
  const exp = mod.setup(api)
  exp.applyProfession(at(D('2026-11-30'), '10:00')) // idx2 = 夜班周 23:00-07:00
  assert.equal(exp.stateAt(at(D('2026-12-04'), '23:30')).state, 'work') // 周五
  const sat = exp.stateAt(at(D('2026-12-05'), '02:00'))
  assert.equal(sat.state, 'work')
  const sun = exp.stateAt(at(D('2026-12-06'), '02:00'))
  assert.equal(sun.state, 'work') // 周六夜班延续到周日凌晨（周日表上是休）
})

test('多职业：销售随机商品——当天稳定、隔周周六轮换上班', () => {
  const { api } = makeApi({ settings: { profession: 'sales' } })
  const exp = mod.setup(api)
  // 大周末（idx0）：周六 11-21 上班，label 带在卖 X，当天两次一致
  exp.applyProfession(at(D('2026-11-16'), '10:00'))
  const s1 = exp.stateAt(at(D('2026-11-21'), '11:00'))
  assert.equal(s1.state, 'work')
  assert.match(s1.label, /在卖\S+/)
  const s2 = exp.stateAt(at(D('2026-11-21'), '12:00'))
  assert.equal(s2.label.match(/在卖(\S+)/)[1], s1.label.match(/在卖(\S+)/)[1])
  // 小周末（idx1）：周六 11-28 休息
  exp.applyProfession(at(D('2026-11-23'), '10:00'))
  assert.equal(exp.stateAt(at(D('2026-11-28'), '11:00')).state, 'home')
})

test('多职业：手动班表不被轮换覆盖；/professions 切职业强制重排', async () => {
  const { api, tools } = makeApi({ settings: { profession: 'nurse' } })
  const exp = mod.setup(api)
  exp.applyProfession(at(D('2026-11-30'), '10:00')) // 大夜周
  const before = JSON.stringify(exp.sched().week)
  assert.ok(before.includes('00:00'))
  // 手动班表：轮换暂停
  exp.sched().weekSource = 'custom'
  exp.applyProfession(at(D('2026-12-07'), '10:00'))
  assert.equal(JSON.stringify(exp.sched().week), before)
  // pendingProf（模拟面板/QQ 命令切职业）：强制重排
  exp.sched().pendingProf = true
  exp.applyProfession(at(D('2026-12-07'), '10:00')) // 12-07 那周 idx=153，%3=0 → 白班周
  assert.equal(JSON.stringify(exp.sched().week), JSON.stringify({ mon: [['08:00', '16:00']], tue: [['08:00', '16:00']], wed: [['08:00', '16:00']], thu: [['08:00', '16:00']], fri: [['08:00', '16:00']], sat: [], sun: [] }))
  assert.equal(exp.sched().weekSource, 'nurse#0')
  assert.ok(tools.some((t) => t.name === 'life_schedule'))
})

test('多职业：高中生——上课/课间/晚自习/放学，周六补课周日休，校园用语', () => {
  const { api } = makeApi({ settings: { profession: 'student' } })
  const exp = mod.setup(api)
  exp.applyProfession(at(D('2026-11-16'), '12:00'))
  const mon = '2026-11-16'
  // 早读上课中，措辞是「上课中」不是「上班中」
  const r1 = exp.stateAt(at(D(mon), '08:30'))
  assert.equal(r1.state, 'work')
  assert.match(r1.label, /上课中/)
  assert.doesNotMatch(r1.label, /上班中/)
  assert.match(r1.label, /07:30–12:00/)
  // 午休空档：在家，livin 开
  const r2 = exp.stateAt(at(D(mon), '12:30'))
  assert.equal(r2.state, 'home')
  assert.match(r2.label, /课间休息/)
  assert.equal(r2.livin, true)
  // 晚自习
  assert.equal(exp.stateAt(at(D(mon), '20:00')).state, 'work')
  assert.equal(exp.stateAt(at(D(mon), '20:00')).night, false) // 晚自习不算夜班
  // 放学到家
  const r3 = exp.stateAt(at(D(mon), '22:00'))
  assert.equal(r3.state, 'home')
  assert.match(r3.label, /放学到家/)
  // 周六上午补课、下午休；周日全天休
  const sat = exp.stateAt(at(D('2026-11-21'), '10:00'))
  assert.equal(sat.state, 'work')
  assert.match(sat.label, /08:00–12:00/)
  assert.equal(exp.stateAt(at(D('2026-11-21'), '15:00')).state, 'home')
  assert.match(exp.stateAt(at(D('2026-11-22'), '15:00')).label, /休息日/)
})
