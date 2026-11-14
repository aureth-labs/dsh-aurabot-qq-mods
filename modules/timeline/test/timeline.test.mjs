// 时间线（timeline）模块测试
// 覆盖：通用周模板、日程合并、话题注入、AI 拟稿、按人格重建周表、注册项。
// 全部走注入的 fake api / fake fetch，不打真网络、不写模块源码目录。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod, ex

const PERSONA = '你是测试人格小A，白天上课，晚上自习。'

const planJson = (note) => JSON.stringify({
  blocks: [
    { start: '08:30', end: '12:00', title: '上午安排' },
    { start: '12:00', end: '13:00', title: '午饭' },
    { start: '14:00', end: '18:00', title: '下午安排' },
    { start: '19:00', end: '22:00', title: '晚间自由' },
  ],
  note: note || '测试拟稿',
})

function makeApi({ personaId = 'test-persona', body = {}, ask, settings = {} } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'aurabot-timeline-'))
  const routes = {}
  const tools = []
  const rules = []
  const commands = []
  const everyFns = []
  const hooks = {}
  const logs = []
  const defaults = { ...mod.defaults, ...settings }
  const api = {
    dataDir: (...p) => join(dataRoot, ...p),
    settings: () => defaults,
    config: () => ({ ownerQQ: '10001', ownerName: '主人', persona: { current: personaId } }),
    log: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
      debug: (m) => logs.push(['debug', m]),
    },
    use: (name) => name === 'mood' ? { label: () => '平静' } : { contextFor: () => '' },
    core: {
      http: { body: async () => body },
      personas: {
        list: () => [{ id: personaId, name: '测试人格' }],
        read: (id) => id === personaId ? { id, name: '测试人格', body: PERSONA, tags: [] } : null,
        current: () => PERSONA,
      },
    },
    ask: ask || (async () => '普通工作日'),
    tool: (b) => { tools.push(b); return () => {} },
    defineTool: (t) => { tools.push(t); return t },
    rule: (b) => { rules.push(b); return () => {} },
    command: (c) => { commands.push(c); return () => {} },
    route: (p, fn) => { routes[p] = fn; return () => {} },
    every: (ms, fn, label) => { everyFns.push({ ms, fn, label }); return () => {} },
    on: (evt, fn) => { (hooks[evt] = hooks[evt] || []).push(fn); return () => {} },
    onDispose: () => {},
    has: () => false,
    lazy: () => null,
    context: () => null,
    lib: null,
    dsh: null,
    root: '',
  }
  return { api, routes, tools, rules, commands, everyFns, hooks, logs, defaults, dataRoot, body }
}

before(async () => {
  mod = (await import('../index.mjs')).default
})

beforeEach(() => {
  // 天气走全局 fetch：测试一律离线，不依赖网络也不拖慢
  globalThis.fetch = async () => { throw new Error('offline stub') }
})

// ---------- 模块定义 ----------
test('模块定义：id/version/api/panel 齐全', () => {
  assert.equal(mod.id, 'timeline')
  assert.equal(mod.version, '1.0.0')
  assert.equal(mod.api, 1)
  assert.equal(mod.panel, 'panel.js')
  assert.equal(typeof mod.setup, 'function')
  for (const k of ['enabled', 'injectMode', 'aiAutoEnabled', 'autoRebuildWeek', 'aiAutoTime', 'topics']) {
    assert.ok(k in mod.defaults, `defaults 里有 ${k}`)
  }
})

// ---------- 通用周模板 ----------
test('默认周表：周一到周日都有，是通用作息不是学生课表', () => {
  const { api } = makeApi()
  const d = mod.setup(api).load()
  for (const k of [1, 2, 3, 4, 5, 6, 7]) assert.ok(Array.isArray(d.week[k]) && d.week[k].length, `周${k} 有块`)
  const text = JSON.stringify(d.week)
  assert.doesNotMatch(text, /早八|上课|自习|概率论|操作系统|晚自习|图书馆/, '不应出现学生专属内容')
  assert.match(text, /起床|上午安排|午饭|午休|下午安排|晚饭|晚间自由|睡觉/, '应覆盖典型一天')
})

// ---------- 日程计算 ----------
test('planFor：按星期取模板，时间段按时间升序', () => {
  const { api } = makeApi()
  const out = mod.setup(api).planFor('2026-11-10')
  assert.ok(out.length >= 5, '一天至少 5 个块')
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].start >= out[i - 1].start, '按时间升序')
  }
  assert.ok(out[0].start < '12:00', '第一个块在午饭前')
})

test('planFor：当日 overrides 覆盖周模板', async () => {
  const { api, routes, body } = makeApi()
  const e = mod.setup(api)
  const d = e.load()
  d.overrides['2026-11-10'] = [{ start: '09:00', end: '10:30', title: '临时安排' }]
  body.json = JSON.stringify(d)
  assert.equal((await routes['/timeline/save']()).ok, true)
  const blocks = e.planFor('2026-11-10')
  assert.ok(blocks.some((b) => b.title === '临时安排'), 'override 生效')
})

test('planFor：events 整天覆盖，holidays 追加整天块', async () => {
  const { api, routes, body } = makeApi()
  const e = mod.setup(api)
  const d = e.load()
  d.events['2026-06-19'] = { title: '期末考试', note: '全天' }
  d.holidays['2026-06-20'] = '端午'
  body.json = JSON.stringify(d)
  assert.equal((await routes['/timeline/save']()).ok, true)
  const ev = e.planFor('2026-06-19')
  assert.equal(ev.length, 1, 'events 覆盖整天')
  assert.match(ev[0].title, /期末考试/)
  const hol = e.planFor('2026-06-20')
  assert.ok(hol.some((b) => /端午/.test(b.title)), 'holidays 加整天块')
})

test('renderTrack / renderDay：给出当前块与当天日程', () => {
  const { api } = makeApi()
  const e = mod.setup(api)
  const t = e.renderTrack(Date.now())
  assert.match(t, /时间线/)
  const day = e.renderDay('2026-11-10')
  assert.equal(day.day, '2026-11-10')
  assert.ok(day.note.length > 0)
  assert.ok(day.blocks.length > 0)
})

// ---------- 话题注入 ----------
test('classify：命中时间话题，普通闲聊不命中', () => {
  const { api } = makeApi()
  const e = mod.setup(api)
  for (const s of ['你在做什么', '今天有什么安排', '几点吃饭', '明天几点上课', '周末干嘛']) {
    assert.equal(e.classify(s).hit, true, `命中：${s}`)
  }
  for (const s of ['嗯嗯', '哈哈', '好的呀', '在的', '随便']) {
    assert.equal(e.classify(s).hit, false, `不命中：${s}`)
  }
})

test('prompt 注入：只主人私聊、命中话题才注入', async () => {
  const { api, hooks } = makeApi()
  mod.setup(api)
  const fn = hooks['prompt'][0]
  const content = [{ type: 'text', text: '在吗' }]
  // 命中 + 主人私聊 → 注入
  const out = await fn(content, { chat: { kind: 'private', userId: '10001' }, queryText: '你在做什么' })
  assert.ok(Array.isArray(out) && out[0].text.includes('时间线'), '注入了时间线片段')
  // 群聊不注入
  const g = await fn(content, { chat: { kind: 'group', userId: '99999' }, queryText: '你在做什么' })
  assert.deepEqual(g, content, '群聊原样返回')
  // 普通闲聊不注入
  const c = await fn(content, { chat: { kind: 'private', userId: '10001' }, queryText: '嗯嗯' })
  assert.deepEqual(c, content, '闲聊原样返回')
})

test('injectMode=off 时不注入', async () => {
  const { api, hooks } = makeApi({ settings: { injectMode: 'off' } })
  mod.setup(api)
  const fn = hooks['prompt'][0]
  const content = [{ type: 'text', text: 'x' }]
  const out = await fn(content, { chat: { kind: 'private', userId: '10001' }, queryText: '你在做什么' })
  assert.deepEqual(out, content)
})

// ---------- AI 拟稿 ----------
test('parsePlan：标准 JSON / 带解释文字 / 无效输入', () => {
  const { api } = makeApi()
  const e = mod.setup(api)
  assert.equal(e.parsePlan(planJson('n')).ok, true)
  assert.equal(e.parsePlan('好的，安排如下：\n' + planJson('n')).ok, true)
  assert.equal(e.parsePlan('没有 JSON').ok, false)
  assert.equal(e.parsePlan(JSON.stringify({ blocks: [] })).ok, false)
})

test('aiPlan：拟稿提示词带上当前人格正文', async () => {
  const prompts = []
  const { api } = makeApi({
    ask: async (opts) => {
      if (String(opts.system).includes('节假日助手')) return '普通工作日'
      prompts.push(opts.text)
      return planJson('测试')
    },
  })
  const e = mod.setup(api)
  const r = await e.aiPlan('2026-06-19')
  assert.equal(r.ok, true)
  assert.ok(r.blocks.length >= 4)
  const p = prompts.find((x) => x.includes('身份信息'))
  assert.ok(p, '拟稿提示词含身份信息段')
  assert.match(p, /测试人格小A/, '带上人格正文')
})

test('rebuildWeek：返回周表，模型给不全时补全缺失的天', async () => {
  const { api } = makeApi({
    ask: async (opts) => {
      if (String(opts.system).includes('节假日助手')) return '普通工作日'
      return JSON.stringify({ week: { 1: [['09:00', '12:00', '上班']] }, note: '只有周一' })
    },
  })
  const e = mod.setup(api)
  const r = await e.rebuildWeek(e.load())
  assert.equal(r.ok, true)
  assert.ok(Array.isArray(r.week[1]))
  assert.ok(r.week[7].length > 0, '缺的天被补全')
})

// ---------- 按人格重建 ----------
test('parseWeek：字符串键 / 缺天补全 / 格式错', () => {
  const { api } = makeApi()
  const e = mod.setup(api)
  const full = JSON.stringify({
    1: [['08:00', '12:00', '上班']], 2: [['08:00', '12:00', '上班']], 3: [['08:00', '12:00', '上班']],
    4: [['08:00', '12:00', '上班']], 5: [['08:00', '12:00', '上班']], 6: [['09:00', '12:00', '自由']], 7: [['09:00', '12:00', '自由']],
  })
  assert.equal(e.parseWeek(full).ok, true)
  const partial = JSON.stringify({ 1: [['08:00', '12:00', 'x']], 2: [['08:00', '12:00', 'x']], 3: [['08:00', '12:00', 'x']] })
  const p = e.parseWeek(partial)
  assert.equal(p.ok, true)
  assert.ok(p.week[4] && p.week[4].length > 0, '缺的天被补上')
  assert.equal(e.parseWeek(JSON.stringify({ 1: [] })).ok, false)
  assert.equal(e.parseWeek('没有周表').ok, false)
})

test('personaBrief：读当前人格正文并识别身份倾向', () => {
  const { api } = makeApi()
  const e = mod.setup(api)
  const b = e.personaBrief()
  assert.equal(b.id, 'test-persona')
  assert.match(b.body, /测试人格小A/)
  assert.match(b.rhythm, /学生/, '识别出学生身份')
})

test('needsWeek / stalePersona：判断周表归属', () => {
  const { api } = makeApi()
  const e = mod.setup(api)
  assert.equal(e.needsWeek(e.load()), true, '没建过周表')
  const d = e.load()
  d.meta = { weekPersonaId: 'test-persona' }
  assert.equal(e.needsWeek(d), false)
  d.meta.weekPersonaId = 'other-persona'
  assert.equal(e.stalePersona(d), true, '换了人格 → 周表过期')
  d.meta.weekPersonaId = 'test-persona'
  assert.equal(e.stalePersona(d), false)
})

// ---------- 注册项 ----------
// 工具是「构造器」：api.tool(b) 存的是 b，要带 level 调用才得到工具对象
const builtTools = (tools) => tools.flatMap((t) => (typeof t === 'function' ? (t({ level: 'full' }) || []) : [t]))

test('注册项：路由 / 工具 / 命令 / 规则 / 定时器齐全', () => {
  const { api, routes, tools, rules, commands, everyFns } = makeApi()
  mod.setup(api)
  for (const p of ['/timeline', '/timeline/save', '/timeline/ai', '/timeline/apply', '/timeline/rebuild', '/timeline/log', '/timeline/weather']) {
    assert.equal(typeof routes[p], 'function', `路由 ${p}`)
  }
  assert.ok(builtTools(tools).some((t) => t && t.name === 'my_schedule'), 'my_schedule 工具')
  assert.ok(commands.some((c) => c.name === 'timeline' && (c.aliases || []).includes('重建模板')), '命令注册')
  assert.ok(rules.some((r) => Array.isArray(r('private')) && r('private').length > 0), 'private 规则')
  assert.ok(rules.every((r) => { const x = r('social'); return !x || (Array.isArray(x) && x.length === 0) }), 'social 不注入')
  assert.ok(everyFns.some((e) => e.ms === 60000), '60 秒轮询')
})

test('my_schedule 工具：返回当天日程', async () => {
  const { api, tools } = makeApi()
  mod.setup(api)
  const tool = builtTools(tools).find((t) => t && t.name === 'my_schedule')
  assert.ok(tool, 'my_schedule 存在')
  const r = await tool.execute({ date: '2026-11-10' })
  assert.equal(r.ok, true)
  assert.ok(r.message.length > 0)
})

test('命令：/timeline 返回指定日期的日程', async () => {
  const { api, commands } = makeApi()
  mod.setup(api)
  const cmd = commands.find((c) => c.name === 'timeline')
  const out = await cmd.run('2026-11-10')
  assert.match(out, /2026-11-10/)
})

test('路由 /timeline：返回数据 + 人格 + 状态', async () => {
  const { api, routes } = makeApi()
  mod.setup(api)
  const r = await routes['/timeline']()
  assert.equal(r.ok, true)
  assert.ok(r.data)
  assert.equal(r.persona.id, 'test-persona')
  assert.equal(r.status.needsWeek, true)
})

test('路由 /timeline/apply：写入 overrides 并生效', async () => {
  const { api, routes, body } = makeApi()
  const e = mod.setup(api)
  body.date = '2026-11-10'
  body.blocks = [{ start: '09:00', end: '10:00', title: '临时' }]
  const r = await routes['/timeline/apply']()
  assert.equal(r.ok, true)
  const d = e.load()
  assert.ok(d.overrides['2026-11-10'] && d.overrides['2026-11-10'].length === 1)
})

test('meta：记录周表归属与来源', () => {
  const { api } = makeApi()
  const d = mod.setup(api).load()
  assert.ok(d.meta)
  assert.equal(d.meta.weekSource, 'generic')
  assert.equal(d.meta.weekPersonaId, '')
})
