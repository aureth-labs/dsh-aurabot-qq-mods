// 模块本体（index.mjs）的集成测试：用一个最小的假 api 把 setup() 跑起来，
// 验证「吃了多少就是多少」、面板接口的数据形状、设置开关真的起作用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../index.mjs'
import { makeApi, pinHunger } from './helpers.mjs'

test('模块元信息：id、版本、面板、设置项', () => {
  assert.equal(plugin.id, 'feed')
  assert.equal(plugin.name, '喂食')
  assert.equal(plugin.version, '3.2.0')
  assert.equal(plugin.api, 1)
  assert.equal(plugin.tab, 'persona')
  assert.equal(plugin.panel, 'panel.js')

  const keys = plugin.settings.map((s) => s.key)
  assert.deepEqual(keys, [
    'foods', 'favorites', 'taste', 'mealTimes', 'activityGain', 'snackIdleHours',
    'canFeed', 'mealBump', 'selfSnack', 'snackAt', 'proactive', 'proactiveAt',
  ])
  // 布尔项必须是 switch，否则设置页会渲染成一行 "true" 的文本框
  for (const key of ['canFeed', 'mealBump', 'selfSnack', 'proactive']) {
    assert.equal(plugin.settings.find((s) => s.key === key).type, 'switch', key + ' 应该是 switch')
  }
  assert.equal(plugin.defaults.mealTimes, '06:30, 11:40, 17:40')
})

test('setup 注册了面板路由、命令和工具', (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  for (const path of ['/status', '/curve', '/preview', '/feed', '/craving', '/config', '/set', '/snack', '/reset', '/poke']) {
    assert.ok(env.routes.has(path), '缺路由 ' + path)
  }
  assert.ok(env.commands.has('喂食'))
  assert.equal(env.tools[0].name, 'qq_feed')
  assert.equal(env.timers.length, 2)
})

test('/status 返回面板需要的字段', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const st = await env.call('/status')
  assert.equal(st.ok, true)
  assert.equal(st.version, '3.2.0')
  assert.equal(typeof st.hunger, 'number')
  assert.equal(st.satiety, 100 - st.hunger)
  assert.ok(st.label)
  assert.deepEqual(st.mealsPlan.map((m) => m.key), ['早餐', '午餐', '晚餐'])
  assert.equal(st.mealsPlan.length, 3)
  assert.ok(st.mealsPlan[0].atText.match(/^\d{2}:\d{2}$/))
  assert.equal(st.portions.length, 4)
  assert.ok(st.stats && typeof st.stats.fed === 'number')
  assert.ok(st.nextMeal && typeof st.nextMeal.atText === 'string')
  assert.ok(['breakfast', 'lunch', 'dinner'].includes(Object.keys(st.meals)[0]))
})

test('饭点按设置走：改了 mealTimes 立刻生效', async (t) => {
  const env = makeApi({ settings: { mealTimes: '05:00, 12:10, 19:30' } })
  t.after(env.cleanup)
  const st = await env.call('/status')
  assert.deepEqual(st.mealsPlan.map((m) => m.atText), ['05:00', '12:10', '19:30'])
})

test('饭点容忍全角冒号和中文逗号', async (t) => {
  const env = makeApi({ settings: { mealTimes: '6：30，11:20、17:30' } })
  t.after(env.cleanup)
  const st = await env.call('/status')
  assert.deepEqual(st.mealsPlan.map((m) => m.atText), ['06:30', '11:20', '17:30'])
})

test('快吃饱时预览不报虚数：能吃下多少就报多少', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  await pinHunger(env, 17)
  const p = await env.call('/preview', { food: '火锅', flavor: '辣', portion: '管饱' })
  assert.equal(p.ok, true)
  assert.equal(p.hunger, 17)
  assert.ok(p.gain <= 17, '预览的 gain 不能超过当前饥饿：' + p.gain)
  assert.equal(p.hungerAfter, 0)
  assert.equal(p.satietyAfter, 100)
})

test('口味对了会写在预览的 notes 里', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  await pinHunger(env, 60)
  const p = await env.call('/preview', { food: '豆腐脑', flavor: '咸', portion: '一份' })
  assert.ok(p.notes.includes('口味正合她意'), 'notes: ' + p.notes.join('；'))
  const bad = await env.call('/preview', { food: '豆腐脑', flavor: '甜', portion: '一份' })
  assert.ok(bad.notes.some((n) => n.includes('口味不太对')))
})

test('投喂：记录里的 before / after / gain 三者对得上', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  await pinHunger(env, 52)
  const r = await env.call('/feed', { food: '白米饭', portion: '一份', react: false })
  assert.equal(r.ok, true)
  assert.equal(r.record.before, 52)
  assert.equal(r.record.after, r.hunger)
  assert.equal(r.record.gain, r.record.before - r.record.after)
  assert.ok(r.record.gain >= 0)

  const st = await env.call('/status')
  assert.equal(st.log[0].before, r.record.before)
  assert.equal(st.log[0].after, r.record.after)
  assert.equal(st.log[0].gain, r.record.gain)
})

test('投喂：gain 不会超过吃之前的饥饿值', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  await pinHunger(env, 3)
  const r = await env.call('/feed', { food: '火锅', portion: '管饱', react: false })
  assert.equal(r.ok, true)
  assert.equal(r.before, 3)
  assert.ok(r.gain <= 3, 'gain=' + r.gain)
  assert.ok(r.hunger >= 0)
})

test('投喂：没说要吃什么就拒绝', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const r = await env.call('/feed', {})
  assert.equal(r.ok, false)
  assert.equal(r.error, '没说要吃什么')
})

test('投喂：关掉 canFeed 之后喂不了', async (t) => {
  const env = makeApi({ settings: { canFeed: false } })
  t.after(env.cleanup)
  const r = await env.call('/feed', { food: '苹果', portion: '半份' })
  assert.equal(r.ok, false)
  assert.equal(r.error, '投喂关着')
})

test('投喂会涨好感度，自己吃不会', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  assert.equal((await env.call('/status')).affection, 0)

  const r = await env.call('/feed', { food: '小蛋糕', flavor: '甜', portion: '一份', react: false })
  assert.equal(r.ok, true)
  assert.equal((await env.call('/status')).affection, 1)

  env.mod.feed({ food: '苹果', portion: '半份', source: '自己吃' })
  assert.equal((await env.call('/status')).affection, 1, '自己吃不该涨好感度')
})

test('投喂之后她会回一句话', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const r = await env.call('/feed', { food: '苹果', portion: '半份' })
  assert.equal(r.ok, true)
  assert.equal(r.say, '吃完啦，哥哥～')
  assert.ok(env.sent.some((s) => s.think && s.think.includes('哥哥刚喂了你')))
  // 面板上的反应只回面板，不应该顺手发到 QQ
  assert.equal(env.sent.filter((s) => s.chatId).length, 0)
})

test('她说的话失败时也有兜底，不会返回空', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  env.api.think = async () => { throw new Error('no llm') }
  const r = await env.call('/feed', { food: '苹果', portion: '半份' })
  assert.equal(r.ok, true)
  assert.ok(r.say.length > 0)
})

test('/curve 给出 24 小时的目标曲线和饭点', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const c = await env.call('/curve', { h: 12 })
  assert.equal(c.ok, true)
  assert.ok(c.points.length >= 4)
  for (const p of c.points) {
    assert.ok(p.t >= 0)
    assert.ok(p.v >= 0 && p.v <= 100)
  }
  assert.equal(c.meals.length, 3)
  assert.equal(c.target, Math.round(c.target))
})

test('/set 改饥饿值会被夹到 0~100', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  await env.call('/set', { hunger: 999 })
  assert.equal((await env.call('/status')).hunger, 100)
  await env.call('/set', { hunger: -5 })
  assert.equal((await env.call('/status')).hunger, 0)
})

test('/reset 清空记录', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  await env.call('/feed', { food: '苹果', portion: '半份', react: false })
  const r = await env.call('/reset', { hunger: 40 })
  assert.equal(r.ok, true)
  const st = await env.call('/status')
  assert.equal(st.hunger, 40)
  assert.equal(st.log.length, 0)
  assert.equal(st.cravings.length, 0)
})

test('命令 /喂食 不带参数时报现在的状态', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const out = await env.commands.get('喂食').run('')
  assert.match(out, /^饥饿 \d+\/100/)
  assert.match(out, /好感度 \d+/)
})

test('工具 qq_feed 会写进同一条记录', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const tool = env.tools[0]
  const r = await tool.execute({ food: '苹果', portion: '半份', source: '投喂' }, {})
  assert.equal(r.ok, true)
  assert.match(r.say, /半份/)
  assert.equal((await env.call('/status')).log.length, 1)
})
