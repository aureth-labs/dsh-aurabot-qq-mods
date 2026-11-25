// 观点模块：元信息、增删查、核心上限、向量去重、语义匹配、prompt 注入、开关。
// 全部走假 api + 本地哈希向量；不联网、不读真实数据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../index.mjs'
import { makeApi, mockEmbeddings, RULES } from './helpers.mjs'

const FAST = { rerank: false, threshold: 0.5, recallFloor: 0.2 }

test('元信息：id / 版本 / 面板 / 设置项', () => {
  assert.equal(plugin.id, 'beliefs')
  assert.equal(plugin.version, '1.0.0')
  assert.equal(plugin.api, 1)
  assert.equal(plugin.panel, 'panel.js')
  const keys = plugin.settings.map((s) => s.key)
  for (const k of ['enabled', 'maxInject', 'threshold', 'recallFloor', 'corePerTurn', 'maxCore', 'maxActive', 'rerank']) {
    assert.ok(keys.includes(k), '缺设置项 ' + k)
  }
  assert.ok(!keys.includes('baseUrl'), '向量地址跟随记忆模块，不该有单独设置')
  assert.ok(!keys.includes('model'), '向量模型跟随记忆模块，不该有单独设置')
})

test('/add 与 /list：写进去、带核心标记、重名合并', async (t) => {
  const env = makeApi({ settings: { ...FAST } })
  t.after(env.cleanup)
  const a = await env.call('/add', { text: '答应的事要做到', topic: '承诺', confidence: 0.8, core: true })
  assert.ok(a.item && a.item.core)
  const b = await env.call('/add', { text: '奶茶还是三分糖的好喝', topic: '口味' })
  assert.ok(b.item && !b.item.core)
  // 完全一样的一条 → 合并，不新增
  const again = await env.call('/add', { text: '答应的事要做到', confidence: 0.9 })
  assert.equal(again.merged, true)
  const list = await env.call('/list')
  assert.equal(list.items.length, 2)
  assert.ok(list.items.find((x) => x.text === '答应的事要做到').confidence > 0.8, '合并后置信度应上调')
})

test('核心上限：超过 maxCore 拒绝新增核心', async (t) => {
  const env = makeApi({ settings: { ...FAST, maxCore: 2 } })
  t.after(env.cleanup)
  await env.call('/add', { text: '原则一', core: true })
  await env.call('/add', { text: '原则二', core: true })
  const r = await env.call('/add', { text: '原则三', core: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /上限/)
})

test('向量去重：意思很近的两条合并成一条', async (t) => {
  const restore = mockEmbeddings(RULES)
  const env = makeApi({ settings: { ...FAST } })
  t.after(() => { env.cleanup(); restore() })
  await env.call('/add', { text: '答应的事要做到，做不到就早点说', topic: '承诺' })
  await env.call('/match', {}, { q: '答应的事' })
  // 仅差一个标点的近义句应该被向量去重合并
  const r = await env.call('/add', { text: '答应的事要做到，做不到就早点说。', topic: '承诺' })
  assert.equal(r.merged, true, '近义句应合并')
  const list = await env.call('/list')
  assert.equal(list.items.length, 1)
})

test('匹配：按语义召回，不按关键词', async (t) => {
  const restore = mockEmbeddings(RULES)
  const env = makeApi({ settings: { ...FAST } })
  t.after(() => { env.cleanup(); restore() })
  await env.call('/add', { text: '答应的事要做到，做不到就早点说', topic: '承诺' })
  await env.call('/add', { text: '奶茶还是三分糖的好喝', topic: '口味' })
  const r = await env.call('/match', {}, { q: '答应的事没做到' })
  assert.ok(r.items.length >= 1, '应该匹配到承诺那条')
  assert.equal(r.items[0].text, '答应的事要做到，做不到就早点说')
  assert.ok(!r.items.some((x) => x.text.includes('奶茶')), '不相关的不该被带上')
})

test('匹配：召回底线过滤掉不相关；完全无关返回空', async (t) => {
  const restore = mockEmbeddings(RULES)
  const env = makeApi({ settings: { ...FAST, recallFloor: 0.99 } })
  t.after(() => { env.cleanup(); restore() })
  await env.call('/add', { text: '答应的事要做到，做不到就早点说' })
  const r = await env.call('/match', {}, { q: '今天天气不错' })
  assert.equal(r.items.length, 0)
})

test('prompt 钩子：普通用「你目前觉得」，核心用「你一向认为」', async (t) => {
  const restore = mockEmbeddings(RULES)
  const env = makeApi({ settings: { ...FAST } })
  t.after(() => { env.cleanup(); restore() })
  await env.call('/add', { text: '别人怎么对我，我就怎么对别人', topic: '原则', core: true })
  const out = await env.runHook('prompt', [{ type: 'text', text: '他骂我' }], { queryText: '别人骂我我该怎么回' })
  assert.ok(Array.isArray(out) && out.length >= 2, '应在原消息前插入一段看法')
  const hint = out[0].text
  assert.ok(hint.includes('你一向认为'), '核心看法用「一向认为」：' + hint)
  assert.ok(hint.includes('不太会改'), '核心要带不可动摇的说法')
  assert.equal(out.at(-1).text, '他骂我', '原消息保留在最后')
})

test('prompt 钩子：没匹配到就不插入', async (t) => {
  const restore = mockEmbeddings(RULES)
  const env = makeApi({ settings: { ...FAST, recallFloor: 0.99 } })
  t.after(() => { env.cleanup(); restore() })
  await env.call('/add', { text: '答应的事要做到' })
  const content = [{ type: 'text', text: '在吗' }]
  const out = await env.runHook('prompt', content, { queryText: '在吗' })
  assert.deepEqual(out, content)
})

test('关闭后：不匹配、prompt 原样放行', async (t) => {
  const restore = mockEmbeddings(RULES)
  const env = makeApi({ settings: { ...FAST, enabled: false } })
  t.after(() => { env.cleanup(); restore() })
  await env.call('/add', { text: '答应的事要做到' })
  const m = await env.call('/match', {}, { q: '他答应我的事又忘了' })
  assert.deepEqual(m.items, [])
  const content = [{ type: 'text', text: 'x' }]
  const out = await env.runHook('prompt', content, { queryText: '他答应我的事又忘了' })
  assert.deepEqual(out, content)
})

test('/del 删除后不再出现在列表里', async (t) => {
  const env = makeApi({ settings: { ...FAST } })
  t.after(env.cleanup)
  const a = await env.call('/add', { text: '先记着这条' })
  const d = await env.call('/del', { id: a.item.id })
  assert.equal(d.ok, true)
  const list = await env.call('/list')
  assert.equal(list.items.length, 0)
})
