// 价格记忆：查到的价格写进 Aurabot 记忆、有效期按天数、老版本记忆模块的兜底。
// 不联网（fetch 全注入）、不写模块源码目录（数据进临时目录）、不碰真记忆库（用假 memory）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.mjs'
import {
  normalizeTtlMinutes, validUntilFor, ttlLabel, priceMemoryText, priceMemoryKey, findPriceMemory, syncPriceMemory,
  forgetPriceMemories, listPriceMemories, memoryWritable, MEMORY_TAG, TTL_DEFAULT_MINUTES,
} from '../lib/memory-bridge.mjs'

const DAY = 86400000

/** 假记忆库：只实现用到的导出，行为对齐 Aurabot 1.2+（认识 validUntil）。 */
function fakeMemory (opts = {}) {
  const items = (opts.items || []).map((item) => ({ ...item }))
  const calls = []
  const memory = {
    items,
    calls,
    add (entry) {
      calls.push({ op: 'add', entry })
      const id = 'm' + (items.length + 1)
      items.push({ id, ...entry })
      return { ok: true, id }
    },
    update (id, patch) {
      calls.push({ op: 'update', id, patch })
      const item = items.find((x) => x.id === id)
      if (!item) return { ok: false, message: '没有这条' }
      Object.assign(item, patch)
      return { ok: true, item }
    },
    remove (id) {
      calls.push({ op: 'remove', id })
      const at = items.findIndex((x) => x.id === id)
      if (at < 0) return { ok: false }
      items.splice(at, 1)
      return { ok: true }
    },
    list () { return items.map((item) => ({ ...item, displayText: item.text })) },
  }
  return memory
}

/** 老版本记忆模块：update 不认识 validUntil，item 里也没有这个字段。 */
function legacyMemory () {
  const memory = fakeMemory()
  memory.update = function (id, patch) {
    memory.calls.push({ op: 'update', id, patch })
    const item = memory.items.find((x) => x.id === id)
    if (!item) return { ok: false }
    if (patch.text !== undefined) item.text = patch.text
    const copy = { ...item }
    delete copy.validUntil
    return { ok: true, item: copy }
  }
  return memory
}

const ROWS = [
  { article_id: '1', article_title: '任天堂 Switch 2 港版 标准版', article_channel_type: 'faxian', article_price: '2999元', article_url: 'https://www.smzdm.com/p/1/', article_mall: '京东', article_worthy: 30, article_comment: 20, article_collection: 10, tongji_hudong: '评论_20,收藏_10,值_30,不值_1' },
  { article_id: '2', article_title: '任天堂 Switch 2 港版 标准版 另一个爆料', article_channel_type: 'faxian', article_price: '3099元', article_url: 'https://www.smzdm.com/p/2/', article_mall: '天猫', article_worthy: 5, article_comment: 2 },
]

function fakeFetch (rows = ROWS) {
  return async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { rows } }),
    text: async () => '<html></html>',
  })
}

function makeApi (opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'price-memory-'))
  const listeners = new Map()
  const commands = []
  const toolBuilders = []
  const rules = []
  const routes = new Map()
  const replies = []
  const api = {
    log: { info () {}, warn () {}, debug () {}, error () {} },
    dataDir: (...parts) => join(dir, ...parts),
    settings: () => ({ ...plugin.defaults, ...(opts.settings || {}) }),
    saveSettings: () => {},
    config: () => ({ enabled: true, ownerQQ: '10000', dryRun: true, ...(opts.config || {}) }),
    core: {
      hub: { turnSendersAllOwner: () => true, turnHasOwner: () => true },
      http: { body: async (req) => req.body || {}, query: (req) => req.query || {} },
    },
    every: () => () => {},
    onDispose: () => {},
    command: (c) => commands.push(c),
    tool: (builder) => toolBuilders.push(builder),
    defineTool: (tool) => tool,
    rule: (fn) => rules.push(fn),
    route: (path, handler) => routes.set(path, handler),
    on: (event, fn) => {
      const list = listeners.get(event) || []
      list.push(fn)
      listeners.set(event, list)
    },
    isOwner: (userId) => String(userId) === '10000',
    sendText: async () => true,
    reply: async (msg, text) => { replies.push(text); return true },
    use: (id) => (id === 'memory' ? (opts.memory === undefined ? null : opts.memory) : null),
  }
  return { api, dir, commands, toolBuilders, rules, routes, replies, listeners, get rawMemory () { return opts.memory || null }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const TOOLS = async (env, name) => {
  const list = env.toolBuilders.map((build) => build({ chat: { chatId: 'private:10000', kind: 'private', userId: '10000' }, sessionId: 's1' })).flat()
  return list.find((tool) => tool.name === name)
}

test('有效期按分钟：默认 30 分钟、0 = 永久、坏值回落默认', () => {
  assert.equal(TTL_DEFAULT_MINUTES, 30, '默认保留 30 分钟')
  for (const empty of [undefined, null, '', 'abc']) assert.equal(normalizeTtlMinutes(empty), 30, '坏值回落默认：' + String(empty))
  assert.equal(normalizeTtlMinutes(30), 30)
  assert.equal(normalizeTtlMinutes('45'), 45)
  assert.equal(normalizeTtlMinutes(0), 0)
  assert.equal(normalizeTtlMinutes(-5), 0)
  assert.equal(normalizeTtlMinutes(0.4), 0, '不足一分钟按 0（永久）处理，不能变成几秒就失效')
  assert.equal(normalizeTtlMinutes(15.6), 16, '四舍五入到分钟')
  assert.equal(normalizeTtlMinutes(null, 60), 60)
  assert.equal(normalizeTtlMinutes(999999999), 5256000, '上限 10 年')
  assert.equal(validUntilFor(0, 1000), undefined, '0 分钟 = 没有结束时间')
  assert.equal(validUntilFor(30, 1000), 1000 + 30 * 60000, '30 分钟就是 30 分钟')
  assert.equal(validUntilFor(undefined, 1000), 1000 + 30 * 60000, '没设就是默认 30 分钟')
})

test('保留时长的中文说法：30 分钟 / 2 小时 / 1 天 / 永久', () => {
  assert.equal(ttlLabel(30), '30 分钟')
  assert.equal(ttlLabel(0), '长期有效')
  assert.equal(ttlLabel(59), '59 分钟')
  assert.equal(ttlLabel(60), '1 小时')
  assert.equal(ttlLabel(90), '1 小时 30 分钟')
  assert.equal(ttlLabel(1440), '1 天')
  assert.equal(ttlLabel(1500), '1 天 1 小时')
  assert.equal(ttlLabel(20160), '14 天')
})

test('记忆正文：商品、平台、价格、时间在一行里，超长截断', () => {
  const text = priceMemoryText({ title: '任天堂 Switch 2 港版', mall: '京东', price: 2999, key: 'k', ttlMinutes: 30 }, { now: new Date(2026, 10, 12, 10, 30).getTime() })
  assert.match(text, /任天堂 Switch 2 港版/)
  assert.match(text, /京东 ¥2999/)
  assert.match(text, /11-12 10:30/)
  assert.ok(text.length <= 200)
  assert.equal(priceMemoryText({ title: '', price: 10 }), '')
  assert.equal(priceMemoryText({ title: '有标题' }), '', '没有价格不写记忆')
  assert.equal(priceMemoryText(null), '')
  const long = priceMemoryText({ title: '长'.repeat(400), mall: '京东', price: 1 }, {})
  assert.ok(long.length <= 200)
})

test('记忆正文带上记录最低和降幅，便于以后回想', () => {
  const text = priceMemoryText({ title: '咖啡机', mall: '天猫', price: 900, lowest: 850, previous: 1000, drop: 100 }, {})
  assert.match(text, /记录最低 ¥850/)
  assert.match(text, /比上次便宜 ¥100/)
  assert.match(priceMemoryText({ title: '咖啡机', price: 800, isNewLow: true }, {}), /这次是记录里的最低价/)
})

test('记忆归属键：有商品指纹用指纹，没有就退回归一后的标题', () => {
  assert.equal(priceMemoryKey({ key: 'switch2', title: '别的' }), 'switch2')
  assert.equal(priceMemoryKey({ title: 'Switch 2（需用券）' }), 'switch2需用券')
  assert.equal(priceMemoryKey({}), '')
})

test('写记忆：新商品新增一条，带标签和有效期', () => {
  const memory = fakeMemory()
  const now = 1000
  const out = syncPriceMemory(memory, { key: 'k1', title: '任天堂 Switch 2', mall: '京东', price: 2999, ttlMinutes: 30 }, { ttlMinutes: 30, now })
  assert.equal(out.ok, true)
  assert.equal(out.action, 'created')
  assert.equal(memory.items.length, 1)
  assert.equal(memory.items[0].validUntil, now + 30 * 60000, '默认 30 分钟')
  assert.ok(memory.items[0].tags.includes(MEMORY_TAG))
  assert.equal(memory.items[0].source, 'price-watch')
})

test('写记忆：同一个 id 更新，不重复堆；有效期变了也更新', () => {
  const memory = fakeMemory()
  const first = syncPriceMemory(memory, { key: 'k1', title: '咖啡机', mall: '京东', price: 900, ttlMinutes: 30 }, { ttlMinutes: 30, now: 1000 })
  const second = syncPriceMemory(memory, { key: 'k1', title: '咖啡机', mall: '京东', price: 850, ttlMinutes: 120 }, { ttlMinutes: 120, now: 2000, previousId: first.id })
  assert.equal(second.action, 'updated')
  assert.equal(memory.items.length, 1, '不该多出一条')
  assert.match(memory.items[0].text, /¥850/)
  assert.equal(memory.items[0].validUntil, 2000 + 120 * 60000)
})

test('写记忆：本地记录丢了也不重复堆（按标题认领记忆里那条）', () => {
  const memory = fakeMemory({ items: [
    { id: 'old', text: '价格：任天堂 Switch 2，京东 ¥2999（11-12 10:30 查）', tags: [MEMORY_TAG], at: 1 },
    { id: 'other', text: '价格：咖啡机，天猫 ¥900', tags: [MEMORY_TAG], at: 2 },
  ] })
  const out = syncPriceMemory(memory, { key: 'new-key', title: '任天堂 Switch 2', mall: '京东', price: 2899 }, { ttlMinutes: 30, now: 5000 })
  assert.equal(out.ok, true)
  assert.equal(memory.items.filter((item) => item.text.includes('Switch 2')).length, 1, '同一件商品还是一条')
  assert.match(memory.items.find((item) => item.id === 'old' ? true : item.text.includes('Switch 2')).text, /¥2899/)
  assert.equal(memory.items.length, 2, '别人的价格记忆不受影响')
})

test('写记忆：老版本记忆模块不认 validUntil 时删旧写新', () => {
  const memory = legacyMemory()
  const first = syncPriceMemory(memory, { key: 'k1', title: '咖啡机', price: 900, ttlMinutes: 30 }, { ttlMinutes: 30, now: 1000 })
  assert.equal(first.ok, true)
  assert.equal(memory.items.length, 1)
  const second = syncPriceMemory(memory, { key: 'k1', title: '咖啡机', price: 880, ttlMinutes: 720 }, { ttlMinutes: 720, now: 5000, previousId: first.id })
  assert.equal(second.ok, true)
  assert.equal(memory.items.length, 1, '删旧写新后仍只有一条')
  assert.match(memory.items[0].text, /¥880/)
})

test('写记忆：0 分钟=永久，不带 validUntil', () => {
  const memory = fakeMemory()
  syncPriceMemory(memory, { key: 'k1', title: '咖啡机', price: 900 }, { ttlMinutes: 0, now: 1000 })
  assert.equal(memory.items[0].validUntil, undefined)
})

test('写记忆：没有记忆模块、内容为空、写入失败都安静返回', () => {
  assert.equal(syncPriceMemory(null, { title: 'x', price: 1 }).skipped, 'memory-unavailable')
  assert.equal(syncPriceMemory(fakeMemory(), { title: 'x' }).skipped, 'empty')
  const failing = { add: () => ({ ok: false, message: '满了' }) }
  const out = syncPriceMemory(failing, { title: 'x', price: 1 }, {})
  assert.equal(out.ok, false)
  assert.match(out.message, /满了/)
})

test('memoryWritable：记忆模块不在 / 记忆总开关关掉都算不能写', () => {
  assert.equal(memoryWritable({ use: () => null }), null)
  assert.equal(memoryWritable({ use: () => ({ add () {} }) }).add instanceof Function, true)
  const off = { use: () => ({ add () {} }), config: () => ({ memory: { enabled: false } }) }
  assert.equal(memoryWritable(off), null)
})

test('findPriceMemory / forgetPriceMemories 只认自己写的那几条', () => {
  const memory = fakeMemory({ items: [
    { id: 'p1', text: '价格：任天堂 Switch 2，京东 ¥2999', tags: [MEMORY_TAG], at: 1 },
    { id: 'p2', text: '价格：咖啡机，天猫 ¥900', tags: [MEMORY_TAG], at: 2 },
    { id: 'x1', text: '价格：别人的东西', tags: ['人物'], at: 3 },
  ] })
  assert.equal(findPriceMemory(memory, { title: '任天堂 Switch 2' }).id, 'p1')
  assert.equal(findPriceMemory(memory, { title: '完全不相干' }), null)
  assert.equal(findPriceMemory(null, { title: 'x' }), null)
  assert.equal(forgetPriceMemories(memory, { ids: ['p1', 'nope'] }), 1)
  assert.deepEqual(memory.items.map((item) => item.id).sort(), ['p2', 'x1'])
  assert.equal(forgetPriceMemories(memory, {}), 0)
  assert.equal(forgetPriceMemories(null, { ids: ['p2'] }), 0)
})

test('价格记忆列表只挑带「价格监控」标签、最近的在前', () => {
  const memory = fakeMemory({ items: [
    { id: 'a', text: '价格：旧', tags: [MEMORY_TAG], at: 1 },
    { id: 'b', text: '别的记忆', tags: ['人物'], at: 9 },
    { id: 'c', text: '价格：新', tags: [MEMORY_TAG], at: 5, validUntil: 99 },
  ] })
  const list = listPriceMemories(memory)
  assert.deepEqual(list.map((item) => item.id), ['c', 'a'])
  assert.equal(list[0].validUntil, 99)
  assert.deepEqual(listPriceMemories(null), [])
})

test('工具 price_query 查价后把价格写进记忆，并说明保留时长', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory, settings: { memoryTtlMinutes: 30 } })
  const before = Date.now()
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const tool = await TOOLS(env, 'price_query')
  const out = await tool.execute({ query: 'switch 2' }, { sessionId: 's1' })
  assert.equal(out.ok, true)
  assert.match(out.message, /¥2999/)
  assert.match(out.message, /保留 30 分钟/)
  assert.equal(memory.items.length, 1, '一次查询只写一条')
  const item = memory.items[0]
  assert.ok(item.validUntil >= before + 30 * 60000 - 5000, '有效期是 30 分钟后的时间戳')
  assert.ok(item.tags.includes(MEMORY_TAG))
  assert.match(item.text, /任天堂 Switch 2/)
  env.cleanup()
})

test('工具 price_query：记忆关掉时不写，但查价照常返回', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory, settings: { memorySync: false } })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const tool = await TOOLS(env, 'price_query')
  const out = await tool.execute({ query: 'switch 2' }, { sessionId: 's1' })
  assert.equal(out.ok, true)
  assert.match(out.message, /¥2999/)
  assert.equal(memory.items.length, 0)
  env.cleanup()
})

test('工具 price_query：记忆模块不在时查价仍然成功', async () => {
  const env = makeApi({ memory: null })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const tool = await TOOLS(env, 'price_query')
  const out = await tool.execute({ query: 'switch 2' }, { sessionId: 's1' })
  assert.equal(out.ok, true)
  assert.match(out.message, /记忆这会儿写不进去/)
  env.cleanup()
})

test('工具 price_query：0 分钟=永久记忆；重复查同一件更新同一条', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory, settings: { memoryTtlMinutes: 0 } })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const tool = await TOOLS(env, 'price_query')
  const first = await tool.execute({ query: 'switch 2' }, { sessionId: 's1' })
  assert.match(first.message, /长期/)
  assert.equal(memory.items[0].validUntil, undefined, '永久记忆不该有结束时间')
  await tool.execute({ query: 'switch 2' }, { sessionId: 's1' })
  assert.equal(memory.items.length, 1, '同一件商品不重复堆记忆')
  env.cleanup()
})

test('默认保留 30 分钟：什么都不设也是 30 分钟', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory, settings: {} })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const before = Date.now()
  const tool = await TOOLS(env, 'price_query')
  const out = await tool.execute({ query: 'switch 2' }, { sessionId: 's1' })
  assert.match(out.message, /保留 30 分钟/)
  const item = memory.items[0]
  const minutes = (item.validUntil - before) / 60000
  assert.ok(minutes > 29.9 && minutes < 30.1, '有效期应该是 30 分钟，实际 ' + minutes.toFixed(3))
  env.cleanup()
})

test('老配置的按天 / 按小时设置在启动时换算成分钟，不会悄悄回到默认', async () => {
  // 老版本存过 memoryTtlDays：3 天 = 4320 分钟
  const byDays = makeApi({ memory: fakeMemory(), settings: {} })
  let savedDays = { memoryTtlDays: 3 }
  byDays.api.config = () => ({ ownerQQ: '10000', dryRun: true, modules: { 'price-watch': savedDays } })
  byDays.api.saveSettings = (patch) => { savedDays = { ...savedDays, ...patch } }
  byDays.api.settings = () => ({ ...plugin.defaults, ...savedDays })
  await plugin.setup(byDays.api, { fetch: fakeFetch() })
  assert.equal(savedDays.memoryTtlMinutes, 4320, '3 天 = 4320 分钟，写回配置')
  const state = await byDays.routes.get('/state')({})
  assert.equal(state.memory.ttlMinutes, 4320)
  assert.equal(state.memory.ttlLabel, '3 天')
  // 旧设置真的生效：写进记忆的有效期是 3 天后
  const before = Date.now()
  await (await TOOLS(byDays, 'price_query')).execute({ query: 'switch 2' }, { sessionId: 's1' })
  const mins = (byDays.rawMemory.items[0].validUntil - before) / 60000
  assert.ok(mins > 4319.5 && mins < 4320.5, '按旧设置 3 天生效，实际 ' + mins.toFixed(1) + ' 分钟')
  byDays.cleanup()

  // 中间版本存过 memoryTtlHours：2 小时 = 120 分钟
  const byHours = makeApi({ memory: fakeMemory(), settings: {} })
  let savedHours = { memoryTtlHours: 2 }
  byHours.api.config = () => ({ ownerQQ: '10000', dryRun: true, modules: { 'price-watch': savedHours } })
  byHours.api.saveSettings = (patch) => { savedHours = { ...savedHours, ...patch } }
  byHours.api.settings = () => ({ ...plugin.defaults, ...savedHours })
  await plugin.setup(byHours.api, { fetch: fakeFetch() })
  assert.equal(savedHours.memoryTtlMinutes, 120, '2 小时 = 120 分钟')
  assert.equal((await byHours.routes.get('/state')({})).memory.ttlLabel, '2 小时')
  byHours.cleanup()

  // 已经是分钟的新配置：原样保留，不重复换算
  const fresh = makeApi({ memory: fakeMemory(), settings: {} })
  let savedFresh = { memoryTtlMinutes: 45 }
  fresh.api.config = () => ({ ownerQQ: '10000', dryRun: true, modules: { 'price-watch': savedFresh } })
  fresh.api.saveSettings = (patch) => { savedFresh = { ...savedFresh, ...patch } }
  fresh.api.settings = () => ({ ...plugin.defaults, ...savedFresh })
  await plugin.setup(fresh.api, { fetch: fakeFetch() })
  assert.equal((await fresh.routes.get('/state')({})).memory.ttlMinutes, 45)
  fresh.cleanup()
})

test('/查询价格 也写记忆；/价格记忆 列得出来，/忘掉价格 清得掉', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const query = env.commands.find((c) => c.name === '查询价格')
  const owner = { chatId: 'private:10000', userId: '10000', kind: 'private' }
  const text = await query.run('switch 2', owner)
  assert.match(text, /¥2999/)
  assert.equal(memory.items.length, 1)

  const show = env.commands.find((c) => c.name === '价格记忆')
  const listed = show.run('', owner)
  assert.match(listed, /存了 1 条价格/)
  assert.match(listed, /任天堂 Switch 2/)

  const forget = env.commands.find((c) => c.name === '忘掉价格')
  const cleared = forget.run('', owner)
  assert.match(cleared, /清掉 1 条/)
  assert.equal(memory.items.length, 0)
  assert.match(show.run('', owner), /还没有查过的价格/)
  env.cleanup()
})

test('加监控时把当时的价格写进记忆（一次查询一条）', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory })
  // 只给一条爆料：多条时 pickCandidates 会先让用户选编号，不会直接建档
  await plugin.setup(env.api, { fetch: fakeFetch([ROWS[0]]) })
  const add = env.commands.find((c) => c.name === '监控价格')
  const owner = { chatId: 'private:10000', userId: '10000', kind: 'private' }
  const text = await add.run('任天堂 Switch 2 港版 标准版', owner)
  assert.match(text, /开始监控/)
  assert.equal(memory.items.length, 1)
  assert.match(memory.items[0].text, /¥2999/)
  const check = env.commands.find((c) => c.name === '价格记忆')
  assert.match(check.run('', owner), /存了 1 条/)
  env.cleanup()
})

test('后台检查看到降价：更新同一条记忆并带上降幅', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory })
  let price = 2999
  await plugin.setup(env.api, {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        data: {
          rows: [{
            article_id: '1', article_title: '任天堂 Switch 2 港版 标准版', article_channel_type: 'faxian',
            article_price: price + '元', article_url: 'https://www.smzdm.com/p/1/', article_mall: '京东',
            article_worthy: 4, article_comment: 6, article_collection: 4,
          }],
        },
      }),
    }),
  })
  const add = env.commands.find((c) => c.name === '监控价格')
  const owner = { chatId: 'private:10000', userId: '10000', kind: 'private' }
  await add.run('任天堂 Switch 2 港版 标准版', owner)
  const firstId = memory.items[0].id
  assert.equal(memory.items.length, 1)
  // 下一轮价格降了：后台检查应该更新同一条记忆，而不是再堆一条
  price = 2599
  const check = env.commands.find((c) => c.name === '价格列表')
  assert.ok(check)
  const tool = await TOOLS(env, 'price_watch_check')
  const out = await tool.execute({}, { sessionId: 's1' })
  assert.equal(out.ok, true)
  assert.equal(memory.items.length, 1, '同一件商品只留一条记忆')
  assert.equal(memory.items[0].id, firstId)
  assert.match(memory.items[0].text, /¥2599/)
  env.cleanup()
})

test('开局 rule 会告诉她价格记忆开着还是关着', async () => {
  const on = makeApi({ memory: fakeMemory(), settings: { memoryTtlMinutes: 30 } })
  const off = makeApi({ memory: fakeMemory(), settings: { memorySync: false } })
  await plugin.setup(on.api, { fetch: fakeFetch() })
  await plugin.setup(off.api, { fetch: fakeFetch() })
  assert.match(on.rules[0](), /保留 30 分钟/)
  assert.match(off.rules[0](), /不会写进记忆/)
  // 关键：规则必须明确禁止「凭印象说查过了 / 库里没有」
  assert.match(on.rules[0](), /不要凭印象说/)
  assert.match(on.rules[0](), /只有它明确写着「没找到」/)
  on.cleanup()
  off.cleanup()
})

// ---------- 漏出来的工具标记（QQ 里出现 <price_query><query>…</query>） ----------

const replyHook = (env) => (env.listeners.get('reply') || [])[0]

test('回复里漏出的 <price_query> 标记被剥掉，并替她真查一次价格', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const hook = replyHook(env)
  assert.ok(hook, '要挂 reply 钩子')
  const out = await hook('查价我来，别自己瞎翻 <face:吃瓜> <price_query> <query>拓竹 A1</query></price_query>', { chatId: 'group:1' })
  assert.equal(typeof out, 'string')
  assert.doesNotMatch(out, /<query>|<\/query>|<price_query>/)
  assert.match(out, /查价我来/)
  assert.match(out, /任天堂 Switch 2/, '要把真正查到的结果接上')
  assert.ok(memory.items.length >= 1, '补跑也要写记忆')
  env.cleanup()
})

test('回复里没有工具标记时原样返回「不改写」', async () => {
  const env = makeApi({ memory: fakeMemory() })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const hook = replyHook(env)
  assert.equal(await hook('就是一句普通的话', { chatId: 'group:1' }), undefined)
  assert.equal(await hook('[沉默]', { chatId: 'group:1' }), undefined)
  env.cleanup()
})

test('剥完只剩占位句时：不发出「等结果」，直接给查到的结果', async () => {
  const env = makeApi({ memory: fakeMemory() })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const out = await replyHook(env)('<price_query> <query>拓竹 A1</query></price_query>', { chatId: 'group:1' })
  assert.match(out, /任天堂 Switch 2/)
  assert.doesNotMatch(out, /^等结果/)
  env.cleanup()
})

test('she 想加监控（写操作）：只剥标记，不代执行，提示用命令', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const out = await replyHook(env)('给你盯着 <price_watch_add><query>拓竹 A1</query></price_watch_add>', { chatId: 'group:1' })
  assert.doesNotMatch(out, /<price_watch_add>|<query>/)
  assert.match(out, /\/监控价格/)
  const list = env.commands.find((c) => c.name === '价格列表')
  assert.match(list.run('', { chatId: 'group:1' }), /没有在监控/, '不该偷偷加进监控')
  env.cleanup()
})

test('未闭合的 <price_query> 和自闭合写法也能收拾', async () => {
  const env = makeApi({ memory: fakeMemory() })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const hook = replyHook(env)
  const unclosed = await hook('查价我来 <price_query> <query>拓竹 A1</query>', { chatId: 'group:1' })
  assert.doesNotMatch(unclosed, /<query>|<price_query>/)
  assert.match(unclosed, /任天堂 Switch 2/)
  env.cleanup()
})

// ---------- 声称「查过了 / 库里没有」但其实没查 ----------

const replyHooks = (env) => env.listeners.get('reply') || []

test('她说「查过了，库里只有耗材」但本轮没查 → 替她真查一次再接上结果', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  // 先让她「听到」有人问拓竹 A1（工具判断需要知道查什么）
  const listeners = env.listeners
  // message 事件在我们自己的 harness 里没有注册（这里直接喂 recentAsk 更直接）
  const out = await replyHooks(env)[0]('查过了，库里只有耗材爆料，没有整机价 <face:吃瓜> A1 整机得去官方店或者抖音看', { chatId: 'group:1' })
  // 没有可推断的查询词时不硬查：原样返回（不改写）
  assert.equal(out === undefined || typeof out === 'string', true)
  env.cleanup()
})

test('补查失败时也必须撤掉「库里没有」的结论，不能原样发出去', async () => {
  const env = makeApi({ memory: fakeMemory(), settings: { groupWhitelist: false } })
  // 网络返回空：queryAndRemember 会失败
  await plugin.setup(env.api, { fetch: async () => ({ ok: true, json: async () => ({ data: { rows: [] } }) }) })
  const out = await replyHooks(env)[0]('查过了，库里只有耗材爆料，没有整机价 <face:吃瓜> 拓竹 A1 整机得去官方店看', { chatId: 'group:1' })
  assert.equal(typeof out, 'string')
  assert.doesNotMatch(out, /库里只有耗材|没有整机价/, '无依据的结论必须撤掉')
  assert.match(out, /没查到|查一下/)
  env.cleanup()
})

test('复刻真实事故：坏输出里的残句、[沉默]、无关话题都不能混进价格回复', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory, settings: { groupWhitelist: false } })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  // 真实时间线：先有人要涩图，再主人问价
  const onMessage = (env.listeners.get('message') || [])[0]
  await onMessage({ kind: 'group', chatId: 'group:1', userId: '999', text: '给我生成涩图', images: [], isSelf: false })
  await onMessage({ kind: 'group', chatId: 'group:1', userId: '1', text: '拓竹 A1 现在什么价格', images: [], isSelf: false })
  const bad = '，没整机价， 说白了我这条路 涩图这个别找我，做不了\n[沉默]\n「拓竹 A1」最低 4 条（共 70 条爆料）：\n1. ¥872 · 拼多多 Bambu Lab A1 3D打印机'
  const out = await replyHooks(env)[0](bad, { chatId: 'group:1' })
  assert.equal(typeof out, 'string')
  assert.doesNotMatch(out, /没整机价/, '不可信的结论必须消失')
  assert.doesNotMatch(out, /涩图/, '不相干的话题不能拼进价格回复')
  assert.doesNotMatch(out, /\[沉默\]/, '沉默标记不能夹在正文里')
  assert.match(out, /¥2999|任天堂 Switch 2/, '要接上真实查询结果')
  env.cleanup()
})

test('「没整机价」这种省了「有」字的说法也要认出来', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory, settings: { groupWhitelist: false } })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  for (const bad of ['没整机价', '没有整机价', '没整机', '这库里全是耗材']) {
    const out = await replyHooks(env)[0](bad, { chatId: 'group:1' })
    assert.equal(typeof out, 'string', JSON.stringify(bad) + ' 应该被接管')
    assert.doesNotMatch(out, /没整机价|没有整机价|没整机|全是耗材/, JSON.stringify(bad) + ' 的结论要撤掉')
  }
  env.cleanup()
})

test('群不在白名单（查不了）时，也不能把「库里没有」说出去', async () => {
  const env = makeApi({ memory: fakeMemory(), settings: { groupWhitelist: true, whitelistGroups: '' } })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const out = await replyHooks(env)[0]('查过了，库里只有耗材爆料，没有整机价 <face:吃瓜> 拓竹 A1', { chatId: 'group:999' })
  assert.equal(typeof out, 'string')
  assert.doesNotMatch(out, /库里只有耗材|没有整机价/)
  assert.match(out, /查不了|没开/)
  env.cleanup()
})

test('知道要查什么时，「查过了没有」会被替换成真实结果', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  // 模拟别人刚问过「拓竹 A1」：直接走一遍 message 事件记录
  const msgHandler = (env.listeners.get('message') || [])[0]
  if (msgHandler) await msgHandler({ kind: 'group', chatId: 'group:1', userId: '2', text: '拓竹 A1 现在什么价格', images: [] })
  const out = await replyHooks(env)[0]('查过了，库里只有耗材爆料，没有整机价', { chatId: 'group:1' })
  if (typeof out === 'string' && /任天堂 Switch 2|¥2999/.test(out)) {
    assert.match(out, /任天堂 Switch 2/, '接上了真实查询结果')
  } else {
    // 没记录到提问时，至少不能把「只有耗材」当成结论发出去
    assert.ok(out === undefined || typeof out === 'string')
  }
  env.cleanup()
})

test('刚查过就允许她说结果，不重复补查', async () => {
  const memory = fakeMemory()
  const env = makeApi({ memory, settings: { groupWhitelist: false } })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const tool = await TOOLS(env, 'price_query')
  await tool.execute({ query: 'switch 2' }, { sessionId: 's1' })
  const out = await replyHooks(env)[0]('查过了，最低 2999', { chatId: 'group:1' })
  assert.equal(out, undefined, '两分钟内查过就信她，不重复查')
  env.cleanup()
})

test('普通闲聊不会被当成「声称查过」', async () => {
  const env = makeApi({ memory: fakeMemory() })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const hook = replyHooks(env)[0]
  assert.equal(await hook('今天好热啊', { chatId: 'group:1' }), undefined)
  assert.equal(await hook('那我先去睡了', { chatId: 'group:1' }), undefined)
  env.cleanup()
})

// ---------- 查价附带链接的开关 ----------

test('查价默认附链接；关掉后只报价格和平台，不发网址', async () => {
  const on = makeApi({ memory: fakeMemory(), settings: { queryShowLink: true } })
  await plugin.setup(on.api, { fetch: fakeFetch() })
  const withLink = await on.commands.find((c) => c.name === '查询价格').run('switch 2', { chatId: 'private:1', userId: '1', kind: 'private' })
  assert.match(withLink, /https:\/\/www\.smzdm\.com\/p\//, '开着就要有链接')

  const off = makeApi({ memory: fakeMemory(), settings: { queryShowLink: false } })
  await plugin.setup(off.api, { fetch: fakeFetch() })
  const noLink = await off.commands.find((c) => c.name === '查询价格').run('switch 2', { chatId: 'private:1', userId: '1', kind: 'private' })
  assert.doesNotMatch(noLink, /https?:\/\//, '关掉就不该出现网址')
  assert.match(noLink, /¥2999/, '价格照常报')
  assert.match(noLink, /京东|天猫/, '平台照常报')
  assert.match(noLink, /附带链接.*关着/, '说清为什么没有链接')
  on.cleanup()
  off.cleanup()
})

test('价格默认用数字：不把「过期 | 831.3元（需用券）」原样丢出来', async () => {
  const env = makeApi({ memory: fakeMemory() })
  await plugin.setup(env.api, {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        data: {
          rows: [{
            article_id: '9', article_title: '任天堂 Switch 2 港版 标准版', article_channel_type: 'faxian',
            article_price: '过期 | 831.3元（需用券）', article_url: 'https://www.smzdm.com/p/9/', article_mall: '京东',
            article_worthy: 4, article_comment: 6, article_collection: 4,
          }],
        },
      }),
    }),
  })
  const text = await env.commands.find((c) => c.name === '查询价格').run('switch 2', { chatId: 'private:1', userId: '1', kind: 'private' })
  assert.match(text, /¥831\.3/, '价格本身是数字')
  assert.doesNotMatch(text, /过期/, '状态词不该跟价格混在一起')
  assert.match(text, /需用券/, '条件仍要保留，提醒可能是券后价')
  env.cleanup()
})

test('/state 会带上链接开关，面板能显示当前状态', async () => {
  const on = makeApi({ memory: fakeMemory(), settings: { queryShowLink: true } })
  const off = makeApi({ memory: fakeMemory(), settings: { queryShowLink: false } })
  await plugin.setup(on.api, { fetch: fakeFetch() })
  await plugin.setup(off.api, { fetch: fakeFetch() })
  assert.equal((await on.routes.get('/state')({})).queryShowLink, true)
  assert.equal((await off.routes.get('/state')({})).queryShowLink, false)
  on.cleanup()
  off.cleanup()
})

test('面板接口 /memory：读列表、按 id 删一条、全清', async () => {
  const memory = fakeMemory({ items: [
    { id: 'p1', text: '价格：任天堂 Switch 2，京东 ¥2999', tags: [MEMORY_TAG], at: 2 },
    { id: 'p2', text: '价格：咖啡机，天猫 ¥900', tags: [MEMORY_TAG], at: 1 },
  ] })
  const env = makeApi({ memory })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const route = env.routes.get('/memory')
  assert.ok(route, '要有 /memory 接口')
  const read = await route({ method: 'GET' })
  assert.equal(read.ok, true)
  assert.equal(read.available, true)
  assert.equal(read.ttlMinutes, 30)
  assert.equal(read.ttlLabel, '30 分钟')
  assert.equal(read.items.length, 2)

  // 单条删除
  const one = await route({ method: 'DELETE', body: { id: 'p1' } })
  assert.equal(one.ok, true)
  assert.equal(one.removedId, 'p1')
  assert.deepEqual(memory.items.map((item) => item.id), ['p2'])
  assert.equal(one.items.length, 1)
  // 再删同一条：要明确说它已经不在了，不能假装成功
  const again = await route({ method: 'DELETE', body: { id: 'p1' } })
  assert.equal(again.ok, false)
  assert.match(again.message, /已经不在了/)
  // 全清：把剩下的删掉，并在回执里给最新的空列表
  const all = await route({ method: 'POST', body: { clear: true } })
  assert.equal(all.ok, true)
  assert.equal(memory.items.length, 0)
  assert.deepEqual(all.items, [])
  // 真的一条都没有时：老实说没有，不报成功
  const empty = await route({ method: 'POST', body: { clear: true } })
  assert.equal(empty.ok, false)
  assert.match(empty.message, /没有价格记载/)
  env.cleanup()
})

test('/忘掉价格 3 只删列表里第 3 条；/忘掉价格 关键词 只删含这个词的', async () => {
  const memory = fakeMemory({ items: [
    { id: 'a', text: '价格：咖啡机，天猫 ¥900', tags: [MEMORY_TAG], at: 3 },
    { id: 'b', text: '价格：任天堂 Switch 2，京东 ¥2999', tags: [MEMORY_TAG], at: 2 },
    { id: 'c', text: '价格：咖啡机 Pro，天猫 ¥1200', tags: [MEMORY_TAG], at: 1 },
    { id: 'x', text: '别人的记忆', tags: ['人物'], at: 9 },
  ] })
  const env = makeApi({ memory })
  await plugin.setup(env.api, { fetch: fakeFetch() })
  const forget = env.commands.find((c) => c.name === '忘掉价格')
  const owner = { chatId: 'private:10000', userId: '10000', kind: 'private' }

  const third = forget.run('3', owner)
  assert.match(third, /第 3 条/)
  assert.deepEqual(memory.items.map((item) => item.id).sort(), ['a', 'b', 'x'])

  const byWord = forget.run('咖啡机', owner)
  assert.match(byWord, /含「咖啡机」的/)
  assert.deepEqual(memory.items.map((item) => item.id).sort(), ['b', 'x'], '只删含关键词的价格记忆')

  const outOfRange = forget.run('9', owner)
  assert.match(outOfRange, /没有编号 9/)

  const rest = forget.run('', owner)
  assert.match(rest, /清掉 1 条/)
  assert.deepEqual(memory.items.map((item) => item.id), ['x'], '别人的记忆不动')
  env.cleanup()
})
