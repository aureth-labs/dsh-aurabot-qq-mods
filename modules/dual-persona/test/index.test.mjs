import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mod from '../index.mjs'
import { defaultPlan, normalizePlan } from '../lib/plan.mjs'
import { dueSlots, matchBand, pickWeighted, rollOnce } from '../lib/schedule.mjs'
import { splitMapOf } from '../lib/split.mjs'

const PERSONAS = [
  { id: 'p1', name: '老实鱼', chars: 10 },
  { id: 'p2', name: '暴躁鱼', chars: 10 },
  { id: 'p3', name: '温柔鱼', chars: 10 },
]
const LOOPBACK = { remoteAddress: '127.0.0.1' }

function makeApi({ settings = {}, mood = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dual-persona-'))
  const cfg = {
    persona: { current: 'p1' },
    mood: { base: 50 },
    allow: { private: ['1773199891'], groups: ['170625223'] },
  }
  // 计划存在模块设置里（api.saveSettings 写到 ext），这里用同一个对象模拟
  const store = { enabled: true, pollSec: 20, ...settings }
  const ctx = { contextFn: null, rules: [], routes: new Map(), routeOptions: new Map(), every: [], later: [], commands: [] }
  const api = {
    dataDir: () => dir,
    settings: () => ({ ...store }),
    saveSettings: (patch) => { Object.assign(store, patch); return { ...store } },
    config: () => cfg,
    setConfig: (patch) => Object.assign(cfg.persona, patch.persona || {}),
    use: () => mood,
    every: (ms, fn) => { ctx.every.push({ ms, fn }); return () => {} },
    later: (ms, fn) => { ctx.later.push({ ms, fn }); return () => {} },
    context: (fn) => { ctx.contextFn = fn; return () => {} },
    rule: (fn) => { ctx.rules.push(fn); return () => {} },
    route: (path, fn, options) => { ctx.routes.set(path, fn); ctx.routeOptions.set(path, options || null); return () => {} },
    command: (spec) => { ctx.commands.push(spec); return () => {} },
    onDispose: () => {},
    log: { info() {}, warn() {}, error() {} },
    core: {
      personas: { list: () => PERSONAS, read: (id) => ({ id, body: `BODY:${id}` }) },
      http: { body: async () => ({}) },
    },
  }
  const exp = mod.setup(api)
  // 模块把 setup 的返回值暴露给别的模块；测试里挂在 ctx 上，方便 tick(ctx) 直接调
  ctx.exp = exp
  return { api, ctx, cfg, dir, exp }
}

const tick = (ctx) => ctx.exp.tick()
// 大部分用例测的是「全局切换」下的行为；分裂/关闭的用例单独传 mode
const postPlan = async (api, ctx, plan, mode = 'global') => {
  const merged = { ...plan, mode: mode === 'global' ? 'global' : 'split' }
  api.core.http.body = async () => ({ plan: merged })
  return ctx.routes.get('/plan')({ method: 'POST', socket: LOOPBACK })
}
const chatOf = (chatId, kind = 'private') => ({ chatId, kind })

test('normalizePlan 把坏数据收敛成安全默认', () => {
  const p = normalizePlan({
    timed: { enabled: 1, slots: [{ at: '8:5', persona: 'p1' }, { at: '25:00', persona: 'p2' }, { at: '09:30', persona: '' }] },
    mood: { enabled: 'yes', bands: [{ min: 80, max: 20, persona: 'p2' }, { min: 0, max: 10 }] },
    randomFixed: { totalPercent: 999, pool: [{ persona: 'p1', weight: -3 }, { persona: '', weight: 1 }] },
  })
  assert.equal(p.timed.enabled, false, '只认真正的 true，1 这种脏值当关着')
  assert.deepEqual(p.timed.slots, [{ at: '08:05', persona: 'p1' }])
  assert.equal(p.mood.enabled, false)
  assert.deepEqual(p.mood.bands, [{ min: 20, max: 80, persona: 'p2' }])
  assert.equal(p.randomFixed.totalPercent, 100)
  assert.deepEqual(p.randomFixed.pool, [{ persona: 'p1', weight: 0 }])
})

test('defaultPlan 默认：模式是人格分裂、五个子规则都关着', () => {
  const p = defaultPlan()
  assert.equal(p.mode, 'split', '默认就是人格分裂')
  assert.equal('enabled' in p, false, '开没开由模块设置项管，计划里不存总开关')
  assert.deepEqual(p.split, { default: '', rows: [] })
  const sum = p.timed.enabled || p.monthly.enabled || p.mood.enabled || p.randomFixed.enabled || p.randomTemp.enabled
  assert.equal(sum, false)
})

test('normalizePlan 收敛模式、旧开关/旧 mode 字段与分裂表', () => {
  const bad = normalizePlan({ enabled: 1, switchGlobal: 1, switchSplit: 'yes', split: { default: ' p2 ', rows: [{ ids: ' 170625223 ', persona: 'p1' }, 'nope', { ids: '', persona: '' }, { ids: 'x', persona: '' }] } })
  assert.equal(bad.mode, 'split')
  assert.equal(bad.split.default, 'p2')
  assert.deepEqual(bad.split.rows, [{ ids: '170625223', persona: 'p1' }, { ids: '', persona: '' }, { ids: 'x', persona: '' }], '空行留着给面板编辑')
  assert.equal(normalizePlan({ mode: 'split' }).mode, 'split', '旧 mode 还能认')
  assert.equal(normalizePlan({ mode: 'global' }).mode, 'global')
  assert.equal(normalizePlan({ switchSplit: true }).mode, 'split')
  assert.equal(normalizePlan({ switchGlobal: true }).mode, 'global')
  assert.equal(normalizePlan({ enabled: true, mode: 'global' }).mode, 'global')
  assert.equal('enabled' in normalizePlan({ enabled: true }), false, '总开关不进计划')
})

test('dueSlots 过了就补：只回已过且今天没跑过的', () => {
  const at = (h, m) => new Date(2026, 0, 1, h, m)
  const slots = [{ at: '08:00', persona: 'p1' }, { at: '08:30', persona: 'p2' }, { at: '12:00', persona: 'p3' }]
  assert.deepEqual(dueSlots(slots, at(9, 0)).map((s) => s.at), ['08:00', '08:30'], '过了的按时间升序返回')
  assert.deepEqual(dueSlots(slots, at(9, 0), ['08:00']).map((s) => s.at), ['08:30'], '跑过的跳过')
  assert.deepEqual(dueSlots(slots, at(7, 0)), [], '还没到的不会提前跑')
  assert.deepEqual(dueSlots(slots, at(8, 30)).map((s) => s.at), ['08:00', '08:30'], '正好这一分钟也算到点')
})

test('matchBand 按区间命中', () => {
  const bands = [{ min: 0, max: 30, persona: 'p2' }, { min: 31, max: 100, persona: 'p3' }]
  assert.equal(matchBand(bands, 12).persona, 'p2')
  assert.equal(matchBand(bands, 80).persona, 'p3')
  assert.equal(matchBand(bands, 30).persona, 'p2')
})

test('rollOnce 先过总概率，再按权重', () => {
  assert.equal(rollOnce(0, [{ persona: 'p1', weight: 1 }]), null)
  assert.equal(rollOnce(100, [{ persona: 'p1', weight: 0 }]), null)
  assert.equal(rollOnce(100, [{ persona: 'p1', weight: 1 }]), 'p1')
  for (let i = 0; i < 30; i++) {
    assert.equal(rollOnce(100, [{ persona: 'a', weight: 0 }, { persona: 'b', weight: 1 }]), 'b')
  }
  assert.equal(rollOnce(50, [{ persona: 'p1', weight: 1 }], () => 0.49), 'p1')
  assert.equal(rollOnce(50, [{ persona: 'p1', weight: 1 }], () => 0.51), null)
})

test('pickWeighted 权重比例对得上', () => {
  const pool = [{ persona: 'a', weight: 3 }, { persona: 'b', weight: 1 }]
  assert.equal(pickWeighted(pool, () => 0.1), 'a')
  assert.equal(pickWeighted(pool, () => 0.6), 'a')
  assert.equal(pickWeighted(pool, () => 0.9), 'b')
})

test('定时到点只换一次，同一分钟不重复触发', async () => {
  const { api, ctx, cfg } = makeApi()
  const now = new Date()
  const at = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  await postPlan(api, ctx, { ...defaultPlan(), timed: { enabled: true, slots: [{ at, persona: 'p2' }] } })
  tick(ctx)
  assert.equal(cfg.persona.current, 'p2')
  cfg.persona.current = 'p1'
  tick(ctx)
  assert.equal(cfg.persona.current, 'p1', '同一分钟不该再触发')
})

test('过了设定时间还没跑，下次检查补上，只补一次', async () => {
  const { api, ctx, cfg } = makeApi()
  const now = new Date()
  const past = new Date(now.getTime() - 5 * 60000)
  // 刚过零点时「5 分钟前」是昨天，用它就不是今天的档期了；这种情况退回当前分钟
  const at = past.getDate() === now.getDate()
    ? `${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}`
    : `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  await postPlan(api, ctx, { ...defaultPlan(), timed: { enabled: true, slots: [{ at, persona: 'p2' }] } })
  tick(ctx)
  assert.equal(cfg.persona.current, 'p2', '错过的档期要补上')
  cfg.persona.current = 'p1'
  tick(ctx)
  assert.equal(cfg.persona.current, 'p1', '补过一次就记下了，不重复补')
})

test('错过多档时按时间顺序补，最后生效的是最近那档', async () => {
  const { api, ctx, cfg } = makeApi()
  const now = new Date()
  const minute = now.getHours() * 60 + now.getMinutes()
  // 只在 00:05 之后测，否则造不出两个「今天已经过了」的点
  if (minute < 6) return
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  await postPlan(api, ctx, {
    ...defaultPlan(),
    timed: { enabled: true, slots: [{ at: fmt(minute - 5), persona: 'p2' }, { at: fmt(minute - 2), persona: 'p3' }] },
  })
  tick(ctx)
  assert.equal(cfg.persona.current, 'p3')
  assert.deepEqual(ctx.exp.state.history.slice(-2).map((h) => h.to), ['p2', 'p3'])
  cfg.persona.current = 'p1'
  tick(ctx)
  assert.equal(cfg.persona.current, 'p1')
})

test('每月到日子只换一次', async () => {
  const { api, ctx, cfg } = makeApi()
  const day = String(new Date().getDate())
  await postPlan(api, ctx, { ...defaultPlan(), monthly: { enabled: true, days: { [day]: 'p3' } } })
  tick(ctx)
  assert.equal(cfg.persona.current, 'p3')
  cfg.persona.current = 'p1'
  tick(ctx)
  assert.equal(cfg.persona.current, 'p1')
})

test('心情落在区间里换一次，越界不换', async () => {
  const { api, ctx, cfg } = makeApi({ mood: { state: () => ({ value: 10 }) } })
  await postPlan(api, ctx, {
    ...defaultPlan(),
    mood: { enabled: true, source: 'auto', manual: 50, bands: [{ min: 0, max: 30, persona: 'p2' }] },
  })
  tick(ctx)
  assert.equal(cfg.persona.current, 'p2')
  cfg.persona.current = 'p1'
  tick(ctx)
  assert.equal(cfg.persona.current, 'p1', '同一条心情区间不反复换')
})

test('心情越界时不动', async () => {
  const { api, ctx, cfg } = makeApi({ mood: { state: () => ({ value: 90 }) } })
  await postPlan(api, ctx, {
    ...defaultPlan(),
    mood: { enabled: true, source: 'auto', manual: 50, bands: [{ min: 0, max: 30, persona: 'p2' }] },
  })
  tick(ctx)
  assert.equal(cfg.persona.current, 'p1')
})

test('随机临时：只给这一轮，下一轮清掉', async () => {
  const { api, ctx } = makeApi()
  await postPlan(api, ctx, {
    ...defaultPlan(),
    randomTemp: { enabled: true, totalPercent: 100, pool: [{ persona: 'p3', weight: 1 }] },
  })
  const chat = chatOf('private:1')
  const first = ctx.contextFn({ chat, sessionId: 's1' })
  assert.match(first, /本会话人格/)
  assert.match(first, /BODY:p3/)
  assert.equal(ctx.contextFn({ chat, sessionId: 's1' }), '')
})

test('随机固定：同一会话一直用，不重复掷', async () => {
  const { api, ctx } = makeApi()
  await postPlan(api, ctx, {
    ...defaultPlan(),
    randomFixed: { enabled: true, scope: 'chat', totalPercent: 100, pool: [{ persona: 'p2', weight: 1 }] },
  })
  const chat = chatOf('group:9', 'group')
  assert.match(ctx.contextFn({ chat, sessionId: 's9' }), /BODY:p2/)
  assert.match(ctx.contextFn({ chat, sessionId: 's9' }), /BODY:p2/)
})

test('随机固定：全局作用域命中后真的换卡', async () => {
  const { api, ctx, cfg } = makeApi()
  await postPlan(api, ctx, {
    ...defaultPlan(),
    randomFixed: { enabled: true, scope: 'global', totalPercent: 100, pool: [{ persona: 'p3', weight: 1 }] },
  })
  ctx.contextFn({ chat: chatOf('private:20002'), sessionId: 's2' })
  assert.equal(cfg.persona.current, 'p3')
})

test('总概率 0 时一次都不换', async () => {
  const { api, ctx, cfg } = makeApi()
  await postPlan(api, ctx, {
    ...defaultPlan(),
    randomTemp: { enabled: true, totalPercent: 0, pool: [{ persona: 'p2', weight: 1 }] },
  })
  assert.equal(ctx.contextFn({ chat: chatOf('private:3'), sessionId: 's3' }), '')
  assert.equal(cfg.persona.current, 'p1')
})

test('关掉总开关后不换卡、不注入', async () => {
  const { api, ctx, cfg } = makeApi({ settings: { enabled: false } })
  await postPlan(api, ctx, {
    ...defaultPlan(),
    randomTemp: { enabled: true, totalPercent: 100, pool: [{ persona: 'p3', weight: 1 }] },
  })
  tick(ctx)
  assert.equal(cfg.persona.current, 'p1')
  assert.equal(ctx.contextFn({ chat: chatOf('private:4'), sessionId: 's4' }), '')
})

test('面板 /apply 只能换成存在的人格卡', async () => {
  const { api, ctx, cfg } = makeApi()
  api.core.http.body = async () => ({ persona: 'p3' })
  const ok = await ctx.routes.get('/apply')({ socket: LOOPBACK })
  assert.equal(ok.ok, true)
  assert.equal(cfg.persona.current, 'p3')

  api.core.http.body = async () => ({ persona: 'nope' })
  const bad = await ctx.routes.get('/apply')({ socket: LOOPBACK })
  assert.equal(bad.ok, false)
})

test('面板接口只接受本机访问', async () => {
  const { ctx } = makeApi()
  const res = await ctx.routes.get('/state')({ socket: { remoteAddress: '10.0.0.8' } })
  assert.equal(res.ok, false)
})

test('切换后会写进历史', async () => {
  const { api, ctx } = makeApi()
  const day = String(new Date().getDate())
  await postPlan(api, ctx, { ...defaultPlan(), monthly: { enabled: true, days: { [day]: 'p3' } } })
  tick(ctx)
  const view = await ctx.routes.get('/state')({ socket: LOOPBACK })
  assert.equal(view.current.id, 'p3')
  assert.ok(view.history.length >= 1)
  assert.equal(view.history[0].to, 'p3')
})

test('总开关关着时：配了分裂也不注入，定时也不换卡', async () => {
  const { api, ctx, cfg } = makeApi({ settings: { enabled: false } })
  const now = new Date()
  const at = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  await postPlan(api, ctx, {
    ...defaultPlan(),
    timed: { enabled: true, slots: [{ at, persona: 'p3' }] },
    split: { default: 'p2', rows: [{ ids: '20002', persona: 'p3' }] },
  }, 'global')
  tick(ctx)
  assert.equal(cfg.persona.current, 'p1', '关闭时不碰全局卡')
  assert.equal(ctx.contextFn({ chat: chatOf('private:20002'), sessionId: 's1' }), '', '关闭时不注入本会话人格')
})

test('分裂模式：每个会话用自己的卡，全局卡不动', async () => {
  const { api, ctx, cfg } = makeApi()
  await postPlan(api, ctx, {
    ...defaultPlan(),
    split: { default: 'p2', rows: [{ ids: '20002', persona: 'p3' }] },
  }, 'split')

  const one = ctx.contextFn({ chat: chatOf('private:20002'), sessionId: 's1' })
  assert.match(one, /BODY:p3/)
  const other = ctx.contextFn({ chat: chatOf('private:20009'), sessionId: 's2' })
  assert.match(other, /BODY:p2/)
  assert.equal(cfg.persona.current, 'p1', '分裂不换全局卡')
})

test('分裂表：裸号按已知群号判断群还是私聊，带前缀的听前缀，后面的组覆盖前面的', () => {
  const groups = new Set(['170625223'])
  const { map } = splitMapOf([
    { ids: '170625223, 1773199891', persona: 'p1' },
    { ids: 'group:170625223', persona: 'p2' },
    { ids: 'group:908975701, 私聊:20002', persona: 'p3' },
    { ids: 'abc', persona: 'p1' },
  ], groups)
  assert.equal(map.get('group:170625223'), 'p2', '后一组覆盖前一组')
  assert.equal(map.get('private:1773199891'), 'p1')
  assert.equal(map.get('group:908975701'), 'p3')
  assert.equal(map.get('private:20002'), 'p3')
  assert.equal(map.size, 4, '认不出的号码不进表')
})

test('分裂模式：定时到点不动全局卡', async () => {
  const { api, ctx, cfg } = makeApi()
  const now = new Date()
  const at = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  await postPlan(api, ctx, { ...defaultPlan(), timed: { enabled: true, slots: [{ at, persona: 'p3' }] } }, 'split')
  tick(ctx)
  assert.equal(cfg.persona.current, 'p1')
})

test('分裂模式：定时填了范围，只改范围里的聊天', async () => {
  const { api, ctx, cfg } = makeApi()
  const now = new Date()
  const at = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  await postPlan(api, ctx, {
    ...defaultPlan(),
    timed: { enabled: true, scope: 'private:20003', slots: [{ at, persona: 'p3' }] },
  }, 'split')
  tick(ctx)
  assert.equal(cfg.persona.current, 'p1', '不动全局卡')
  assert.match(ctx.contextFn({ chat: chatOf('private:20003'), sessionId: 's3' }), /BODY:p3/)
  assert.equal(ctx.contextFn({ chat: chatOf('private:20004'), sessionId: 's4' }), '', '范围外的聊天不变')
})

test('分裂模式：没填生效范围的规则不生效', async () => {
  const { api, ctx } = makeApi()
  await postPlan(api, ctx, {
    ...defaultPlan(),
    timed: { enabled: true, slots: [{ at: '00:00', persona: 'p3' }] },
    randomFixed: { enabled: true, totalPercent: 100, pool: [{ persona: 'p2', weight: 1 }] },
  }, 'split')
  tick(ctx)
  assert.equal(ctx.contextFn({ chat: chatOf('group:9'), sessionId: 's9' }), '')
  assert.deepEqual(ctx.exp.state.sessions['group:9']?.persona || '', '')
})


test('分裂模式：随机固定选「全局」也只落会话', async () => {
  const { api, ctx, cfg } = makeApi()
  await postPlan(api, ctx, {
    ...defaultPlan(),
    randomFixed: { enabled: true, scope: 'private:20008', target: 'global', totalPercent: 100, pool: [{ persona: 'p3', weight: 1 }] },
  }, 'split')
  const text = ctx.contextFn({ chat: chatOf('private:20008'), sessionId: 's8' })
  assert.match(text, /BODY:p3/)
  assert.equal(cfg.persona.current, 'p1', '分裂模式下不真换全局卡')
})

test('面板能保存模式与分裂表，view 里带解析预览', async () => {
  const { api, ctx } = makeApi()
  const saved = await postPlan(api, ctx, { ...defaultPlan(), split: { default: 'p2', rows: [{ ids: '170625223', persona: 'p3' }] } }, 'split')
  assert.equal(saved.ok, true)
  const view = await ctx.routes.get('/state')({ socket: LOOPBACK })
  assert.equal('enabled' in view.plan, false, '计划里不再有总开关')
  assert.equal(view.plan.mode, 'split')
  assert.equal(view.plan.split.rows[0].persona, 'p3')
  assert.equal(view.splitPreview[0].resolved[0].chatId, 'group:170625223', '白名单里的群号按群解析')
  assert.ok(Array.isArray(view.chats))
})

test('四条面板路由都声明成 panel，交给宿主的闸先拦', () => {
  const { ctx } = makeApi()
  for (const path of ['/state', '/plan', '/apply', '/reset']) {
    assert.ok(ctx.routes.has(path), `缺路由 ${path}`)
    assert.deepEqual(ctx.routeOptions.get(path), { access: 'panel' }, `${path} 没带 access: panel`)
  }
})

test('默认值：装上就什么都不做——模式是分裂、五条规则全关', async () => {
  const { ctx } = makeApi()
  const view = await ctx.routes.get('/state')({ socket: LOOPBACK })
  assert.equal(view.plan.mode, 'split')
  for (const key of ['timed', 'monthly', 'mood', 'randomFixed', 'randomTemp']) {
    assert.equal(view.plan[key].enabled, false, `${key} 默认应该关着`)
  }
  assert.equal(view.plan.split.rows.length, 0)
  assert.equal(view.plan.split.default, '')
  // 默认状态下既不改全局卡，也不往会话里塞人格
  assert.equal(ctx.contextFn({ chat: chatOf('group:9'), sessionId: 's9' }), '')
})

test('module.json：能力声明与实际用到的一致，入口版本号对齐', () => {
  const json = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8'))
  assert.equal(json.id, mod.id)
  assert.equal(json.version, mod.version)
  assert.deepEqual(json.capabilities.sort(), ['filesystem', 'plugin-config', 'plugin-internals'])
  assert.equal(json.license, 'MIT')
})