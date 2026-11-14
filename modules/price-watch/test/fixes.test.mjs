// 回归测试：PR #71 审查「必须修复」7 条的运行期行为。
// 全程 fake api + fake fetch：不联网、不碰真 QQ、数据落在临时目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import priceWatch, { MAX_RECORDS } from '../index.mjs'
import { productKey } from '../lib/core.mjs'

const MODULE_DIR = fileURLToPath(new URL('..', import.meta.url))

function row (title, price, extra = {}) {
  return {
    article_id: extra.articleId || ('a-' + title),
    article_title: title,
    article_channel_type: 'faxian',
    article_price: price + '元',
    article_url: extra.url || ('https://www.smzdm.com/p/' + encodeURIComponent(title)),
    tongji_hudong: extra.tongji || '评论_5,收藏_3,值_10,不值_1',
    article_mall: extra.mall || '京东',
    publish_date_lt: 1700000000,
  }
}

/** 组一个 fake api，接口面按 src/core/modules.js 的 makeApi 子集来。 */
function makeHarness (opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'price-watch-fix-'))
  const rec = {
    dir,
    fetches: [],
    sent: [],
    toolFactory: null,
    routes: new Map(),
    every: [],
    disposers: [],
    everyStopped: false,
    sendTextResult: 'sendTextResult' in opts ? opts.sendTextResult : { message_id: 'm1' },
    rows: opts.rows || [],
    failTitles: opts.failTitles || [],
  }
  const settings = {
    active: true,
    intervalMinutes: 60,
    alertDropPercent: 5,
    alertDropAmount: 5,
    alertOnQuality: true,
    maxWatches: 20,
    queryPages: 2,
    queryTopN: 3,
    guestQuery: true,
    guestWatch: false,
    alertCooldownMinutes: 180,
    watchTtlDays: 90,
    groupWhitelist: true,
    whitelistGroups: '123456',
    alertMentionOwner: true,
    checkStartHour: 0,
    checkEndHour: 0,
    maxChecksPerRun: 5,
    ...(opts.settings || {}),
  }
  const ownerSessions = new Set(opts.ownerSessions || [])
  const hub = { ...(opts.hub || {}) }
  if (!opts.noOwnerFn && typeof hub.turnSendersAllOwner !== 'function') {
    hub.turnSendersAllOwner = (sid) => ownerSessions.has(sid)
  }
  const fetchImpl = async (url) => {
    rec.fetches.push(String(url))
    let keyword = ''
    try { keyword = new URL(String(url)).searchParams.get('keyword') || '' } catch (error) {}
    if (rec.failTitles.some((title) => keyword.includes(title))) throw new Error('network down')
    const rows = typeof rec.rows === 'function' ? rec.rows(keyword) : rec.rows
    return { ok: true, status: 200, json: async () => ({ data: { rows } }), text: async () => '' }
  }
  const api = {
    log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    dataDir: (name) => (name ? join(dir, name) : dir),
    settings: () => settings,
    saveSettings: (patch) => { Object.assign(settings, patch) },
    config: () => ({ ownerQQ: '10001', dryRun: false, ...(opts.config || {}) }),
    isOwner: (uid) => String(uid) === '10001',
    on: () => () => {},
    command: () => {},
    rule: () => {},
    tool: (factory) => { rec.toolFactory = factory },
    defineTool: (tool) => tool,
    every: (ms, fn, label) => {
      rec.every.push({ ms, fn, label })
      return () => { rec.everyStopped = true }
    },
    onDispose: (fn) => rec.disposers.push(fn),
    route: (path, handler) => rec.routes.set(path, handler),
    sendText: async (chatId, text) => {
      rec.sent.push({ chatId, text })
      return typeof rec.sendTextResult === 'function'
        ? rec.sendTextResult(chatId, text, rec.sent.length)
        : rec.sendTextResult
    },
    reply: async () => {},
    core: { hub, http: { body: async (req) => (req && req.__body) || {} } },
  }
  return { api, rec, dir, settings, fetch: fetchImpl, ownerSessions }
}

function writeState (h, state) {
  mkdirSync(h.dir, { recursive: true })
  writeFileSync(join(h.dir, 'state.json'), JSON.stringify(state, null, 2))
}

function readState (h) {
  return JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf8'))
}

function cleanup (h) {
  try { for (const fn of h.rec.disposers) fn() } catch (error) {}
  rmSync(h.dir, { recursive: true, force: true })
}

function watchFixture (overrides = {}) {
  const title = overrides.title || '任天堂 Switch 2 标准版'
  return {
    id: 'w1',
    query: title,
    title,
    key: productKey(title, 6),
    articleId: 'a1',
    mall: '京东',
    url: 'https://www.smzdm.com/p/1',
    price: 3200,
    priceText: '3200元',
    lowest: 3200,
    lowestAt: 1,
    quality: '',
    qualityLabel: '',
    points: 0,
    comments: 1,
    collection: 0,
    worthy: 1,
    unworthy: 0,
    chatId: 'private:10001',
    creatorId: '10001',
    createdAt: Date.now() - 60_000,
    lastCheck: 0,
    alerts: 0,
    lastAlert: 0,
    seenQuality: [],
    history: [{ at: 1, price: 3200 }],
    failCount: 0,
    ...overrides,
  }
}

test('写工具：在 execute 里按当前会话判「本轮所有发言者都是主人」，不用工厂期快照', async () => {
  const h = makeHarness({
    rows: [row('任天堂 Switch 2 标准版', 3200)],
    ownerSessions: ['sid-owner'],
    hub: {
      turnHasOwner: () => { throw new Error('不该再用 turnHasOwner') },
    },
  })
  priceWatch.setup(h.api, { fetch: h.fetch })
  const factory = h.rec.toolFactory
  assert.equal(typeof factory, 'function')

  // 旧代码在工厂期取 owner：挂载时恰好是主人轮次 → 群友轮次也能借权。
  const staleOwnerTools = factory({ chat: { kind: 'group', chatId: 'group:123456', userId: '555' }, sessionId: 'sid-owner' })
  const addAsGuest = staleOwnerTools.find((tool) => tool.name === 'price_watch_add')
  const denied = await addAsGuest.execute({ query: 'switch 2' }, { agent: { session: { id: 'sid-guest' } } })
  assert.equal(denied.ok, false)
  assert.match(denied.message, /主人/)
  assert.equal(h.rec.fetches.length, 0, '群友借权时不能发请求、不能写 state')

  // 挂载时不是主人轮次，但 execute 时主人在群里开口 → 必须能用（旧代码会永久拒绝）。
  const staleGuestTools = factory({ chat: { kind: 'group', chatId: 'group:123456', userId: '10001' }, sessionId: 'sid-guest' })
  const addAsOwner = staleGuestTools.find((tool) => tool.name === 'price_watch_add')
  const allowed = await addAsOwner.execute({ query: 'switch 2' }, { agent: { session: { id: 'sid-owner' } } })
  assert.equal(allowed.ok, true, allowed.message)
  assert.ok(h.rec.fetches.length > 0, '主人的群聊里能真正加监控')

  // 立即检查也是写操作（会发提醒/改状态），同样只认主人。
  const checkAsGuest = staleOwnerTools.find((tool) => tool.name === 'price_watch_check')
  const checkDenied = await checkAsGuest.execute({}, { agent: { session: { id: 'sid-guest' } } })
  assert.equal(checkDenied.ok, false)
  assert.match(checkDenied.message, /主人/)

  cleanup(h)
})

test('写工具：宿主没有 turnSendersAllOwner 时 fail-closed', async () => {
  const h = makeHarness({ noOwnerFn: true, rows: [row('任天堂 Switch 2 标准版', 3200)] })
  priceWatch.setup(h.api, { fetch: h.fetch })
  const tools = h.rec.toolFactory({ chat: { kind: 'private', chatId: 'private:10001', userId: '10001' }, sessionId: 'sid' })
  const add = tools.find((tool) => tool.name === 'price_watch_add')
  const out = await add.execute({ query: 'switch 2' }, { agent: { session: { id: 'sid' } } })
  assert.equal(out.ok, false)
  assert.equal(h.rec.fetches.length, 0)
  cleanup(h)
})

test('price_query 在 guestQuery 关闭时只给主人用', async () => {
  const h = makeHarness({ settings: { guestQuery: false, whitelistGroups: '123456' } })
  priceWatch.setup(h.api, { fetch: h.fetch })
  const tools = h.rec.toolFactory({ chat: { kind: 'group', chatId: 'group:123456', userId: '20002' }, sessionId: 's1' })
  const query = tools.find((tool) => tool.name === 'price_query')
  const guest = await query.execute({ query: 'switch 2' }, { sessionId: 's1' })
  assert.equal(guest.ok, false)
  assert.equal(h.rec.fetches.length, 0, 'guestQuery 关闭时群友不能触发上游请求')
  h.ownerSessions.add('s1')
  const owner = await query.execute({ query: 'switch 2' }, { sessionId: 's1' })
  assert.notEqual(owner.message, '查价只有主人能用（guestQuery 已关闭）。')
  assert.ok(h.rec.fetches.length > 0, '主人仍然能查')
  cleanup(h)
})

test('提醒落账：api.sendText 失败不占冷却 / 计数，成功后才记一次', async () => {
  const title = '任天堂 Switch 2 标准版'
  const key = productKey(title, 6)
  const h = makeHarness({
    rows: [row(title, 2900)],
    sendTextResult: null,
    settings: { intervalMinutes: 10 },
  })
  writeState(h, {
    watches: [watchFixture({ key, title, query: title })],
    records: { [key]: { lowest: 3200, lowestAt: 1, lastSeen: 1, title, url: 'https://www.smzdm.com/p/1', observations: 1 } },
    alerts: 0,
  })
  const mod = priceWatch.setup(h.api, { fetch: h.fetch })
  assert.equal(mod.state().watches.length, 1, 'fixture 应该被加载')

  const first = await mod.check()
  assert.equal(first.alerts, 0)
  assert.equal(h.rec.sent.length, 1, '失败也会尝试发一次')
  let saved = readState(h)
  assert.equal(saved.watches[0].alerts, 0, '发送失败不加次数')
  assert.equal(saved.watches[0].lastAlert, 0, '发送失败不占冷却')
  assert.equal(saved.alerts, 0, '面板统计不虚高')

  // 下一次真的发出去：价格继续下探，仍满足降价 + 新低
  h.rec.rows = [row(title, 2800)]
  h.rec.sendTextResult = { message_id: 'ok-1' }
  const second = await mod.check()
  assert.equal(second.alerts, 1)
  saved = readState(h)
  assert.equal(saved.watches[0].alerts, 1)
  assert.ok(saved.watches[0].lastAlert > 0, '成功后才占冷却')
  assert.equal(saved.alerts, 1)

  // 冷却期内再降：不再发，也不加计数
  h.rec.rows = [row(title, 2700)]
  const third = await mod.check()
  assert.equal(third.alerts, 0)
  assert.equal(h.rec.sent.length, 2, '冷却中不再尝试发送')
  saved = readState(h)
  assert.equal(saved.watches[0].alerts, 1)
  cleanup(h)
})

test('提醒发送失败不吞掉本次降价：下一次同价仍能补发', async () => {
  const title = '任天堂 Switch 2 标准版'
  const key = productKey(title, 6)
  const h = makeHarness({ rows: [row(title, 2900)], sendTextResult: null, settings: { intervalMinutes: 10 } })
  writeState(h, {
    watches: [watchFixture({ key, title, query: title })],
    records: { [key]: { lowest: 3200, lowestAt: 1, lastSeen: 1, title, url: 'https://www.smzdm.com/p/1', observations: 1 } },
  })
  const mod = priceWatch.setup(h.api, { fetch: h.fetch })
  const first = await mod.check()
  assert.equal(first.alerts, 0)
  assert.equal(h.rec.sent.length, 1)
  assert.equal(readState(h).watches[0].price, 3200, '发送失败要回滚展示价格，下一次才能补发')

  h.rec.sendTextResult = { message_id: 'ok-retry' }
  const second = await mod.check()
  assert.equal(second.alerts, 1, '同一价格也要补发')
  assert.equal(h.rec.sent.length, 2)
  cleanup(h)
})

test('好价提醒：发送失败不记 seenQuality，下次成功才记并只报一次', async () => {
  const title = '德龙 全自动咖啡机'
  const key = productKey(title, 6)
  const superRow = row(title, 3000, { tongji: '评论_30,收藏_10,值_20,不值_1', articleId: 'a-super' })
  const h = makeHarness({
    rows: [superRow],
    sendTextResult: null,
    settings: { intervalMinutes: 10 },
  })
  writeState(h, {
    watches: [watchFixture({ title, query: title, price: 3000, lowest: 3000, comments: 0, worthy: 0, collection: 0 })],
    records: { [key]: { lowest: 3000, lowestAt: 1, lastSeen: 1, title, url: 'https://www.smzdm.com/p/1', observations: 1 } },
  })
  const mod = priceWatch.setup(h.api, { fetch: h.fetch })

  const first = await mod.check()
  assert.equal(first.alerts, 0)
  assert.deepEqual(readState(h).watches[0].seenQuality, [], '发送失败不记等级，下次还能补发')

  h.rec.sendTextResult = { message_id: 'ok' }
  const second = await mod.check()
  assert.equal(second.alerts, 1)
  assert.ok(readState(h).watches[0].seenQuality.includes('super'), '发送成功才记好价等级')

  const third = await mod.check()
  assert.equal(third.alerts, 0, '同等级已经报过，不再重复')
  cleanup(h)
})

test('检查失败：写 lastCheck、指数退避后不再每轮重打，后面的监控轮得到', async () => {
  const titles = ['Alpha 商品甲', 'Beta 商品乙', 'Gamma 商品丙']
  const now = Date.now()
  const h = makeHarness({
    rows: [row(titles[2], 3000, { articleId: 'g1' })],
    failTitles: [titles[0], titles[1]],
    settings: { intervalMinutes: 10, maxChecksPerRun: 2 },
  })
  writeState(h, {
    watches: [
      watchFixture({ id: 'w-a', title: titles[0], query: titles[0], lastCheck: now - 30 * 60000 }),
      watchFixture({ id: 'w-b', title: titles[1], query: titles[1], lastCheck: now - 20 * 60000 }),
      watchFixture({ id: 'w-c', title: titles[2], query: titles[2], lastCheck: now - 15 * 60000 }),
    ],
    records: {},
  })
  const mod = priceWatch.setup(h.api, { fetch: h.fetch })

  await mod.tick()
  assert.equal(h.rec.fetches.length, 2, '每轮最多查 2 个')
  let saved = readState(h)
  let byId = Object.fromEntries(saved.watches.map((watch) => [watch.id, watch]))
  assert.ok(byId['w-a'].lastCheck >= now, '失败也写 lastCheck')
  assert.equal(byId['w-a'].failCount, 1)
  assert.equal(byId['w-b'].failCount, 1)
  assert.equal(byId['w-c'].lastCheck, now - 15 * 60000, '这轮轮不到的监控保持原样')

  await mod.tick()
  assert.equal(h.rec.fetches.length, 3, '失败的两条退避 20 分钟，不再每轮重打；第三条轮到了')
  saved = readState(h)
  byId = Object.fromEntries(saved.watches.map((watch) => [watch.id, watch]))
  assert.equal(byId['w-a'].failCount, 1)
  assert.equal(byId['w-c'].failCount, 0, '成功一次就清零失败计数')
  assert.ok(byId['w-c'].lastCheck > now - 15 * 60000)

  await mod.tick()
  assert.equal(h.rec.fetches.length, 3, '都还没到期，不再发请求')
  cleanup(h)
})

test('价格记录：有上限 / LRU，/state 只下发当前监控用到的 key', async () => {
  const h = makeHarness({ rows: [row('罗技 MX Master 3S 鼠标', 499, { articleId: 'm1' })] })
  const records = {}
  for (let i = 0; i < MAX_RECORDS; i++) {
    records['r' + i] = { lowest: 100 + i, lowestAt: i + 1, lastSeen: i + 1, title: '旧商品 ' + i, url: '', observations: 1 }
  }
  const k1 = productKey('任天堂 Switch 2 标准版', 6)
  const k2 = productKey('德龙 全自动咖啡机', 6)
  records[k1] = { lowest: 3000, lowestAt: 100, lastSeen: 10_000_000, title: 'switch', url: 'u', observations: 2 }
  records[k2] = { lowest: 2000, lowestAt: 100, lastSeen: 10_000_001, title: 'coffee', url: 'u', observations: 2 }
  delete records.r0
  delete records.r1
  writeState(h, {
    watches: [
      watchFixture({ id: 'w1', key: k1 }),
      watchFixture({ id: 'w2', key: k2, title: '德龙 全自动咖啡机', query: '德龙 全自动咖啡机' }),
    ],
    records,
  })
  priceWatch.setup(h.api, { fetch: h.fetch })

  const viewed = await h.rec.routes.get('/state')({ method: 'GET', headers: {} })
  assert.equal(viewed.ok, true)
  assert.deepEqual(Object.keys(viewed.records).sort(), [k1, k2].sort(), '只下发当前监控商品的记录')

  const searched = await h.rec.routes.get('/search')({ method: 'POST', headers: {}, __body: { query: '罗技 MX Master 3S 鼠标' } })
  assert.equal(searched.ok, true, searched.message)
  const saved = readState(h)
  assert.equal(Object.keys(saved.records).length, MAX_RECORDS, '新记录把总数裁回上限')
  assert.equal(saved.records.r2, undefined, '最久没被碰过的记录先淘汰')
  assert.ok(saved.records[k1] && saved.records[k2], '当前监控商品的记录不会被淘汰')
  cleanup(h)
})

test('价格记录防原型链：__proto__ 商品不会污染 Object.prototype', async () => {
  const h = makeHarness({ rows: [row('__proto__', 199)] })
  try {
    priceWatch.setup(h.api, { fetch: h.fetch })
    const beforeObservations = Object.prototype.observations
    const beforeLastSeen = Object.prototype.lastSeen
    const out = await h.rec.routes.get('/search')({ method: 'POST', headers: {}, __body: { query: '__proto__' } })
    assert.equal(out.ok, true, out.message)
    assert.equal(Object.prototype.observations, beforeObservations, 'Object.prototype.observations 不能被写')
    assert.equal(Object.prototype.lastSeen, beforeLastSeen, 'Object.prototype.lastSeen 不能被写')
    const saved = readState(h)
    assert.ok(Object.prototype.hasOwnProperty.call(saved.records, '__proto__'), '__proto__ 只作为普通自有键保存')
  } finally {
    cleanup(h)
  }
})

test('定时检查走 api.every(60s) 并在停用时清理，不用裸 setInterval', async () => {
  const h = makeHarness()
  priceWatch.setup(h.api, { fetch: h.fetch })
  assert.equal(h.rec.every.length, 1)
  assert.equal(h.rec.every[0].ms, 60_000)
  assert.equal(h.rec.every[0].label, '价格监控检查')
  assert.ok(h.rec.disposers.length >= 1, '注册了 onDispose')
  for (const fn of h.rec.disposers) fn()
  assert.equal(h.rec.everyStopped, true, '停用后定时器要清掉')
  const source = readFileSync(join(MODULE_DIR, 'index.mjs'), 'utf8')
  assert.ok(!/\bsetInterval\s*\(/.test(source), '模块入口不要再用裸 setInterval')
  cleanup(h)
})

test('模块定义：版本 1.1.0 四处一致', () => {
  assert.equal(priceWatch.version, '1.1.0')
  const manifest = JSON.parse(readFileSync(join(MODULE_DIR, 'module.json'), 'utf8'))
  const pkg = JSON.parse(readFileSync(join(MODULE_DIR, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(MODULE_DIR, 'package-lock.json'), 'utf8'))
  assert.equal(manifest.version, '1.1.0')
  assert.equal(pkg.version, '1.1.0')
  assert.equal(lock.version, '1.1.0')
  assert.equal(lock.packages[''].version, '1.1.0')
})

test('面板接口：跨站拒绝，写接口只收 POST', async () => {
  const h = makeHarness({ rows: [row('任天堂 Switch 2 标准版', 3200)] })
  priceWatch.setup(h.api, { fetch: h.fetch })
  const state = h.rec.routes.get('/state')
  assert.equal((await state({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })).ok, false)
  assert.equal((await state({ method: 'GET', headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } })).ok, false)
  assert.equal((await state({ method: 'GET', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } })).ok, true)
  assert.equal((await state({ method: 'GET', headers: {} })).ok, true)
  const rebind = await state({ method: 'GET', headers: { origin: 'http://evil.example', host: 'evil.example' } })
  assert.equal(rebind.ok, false, 'DNS rebinding 的 Host 必须被拒')
  assert.match(rebind.message, /rebinding|Host/)

  for (const path of ['/search', '/add', '/remove', '/check']) {
    const out = await h.rec.routes.get(path)({ method: 'GET', headers: {}, __body: {} })
    assert.equal(out.ok, false, path + ' 必须拒绝 GET')
    assert.match(out.message, /POST/, path)
  }
  const cross = await h.rec.routes.get('/add')({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, __body: { query: 'switch 2' } })
  assert.equal(cross.ok, false)
  assert.equal(h.rec.fetches.length, 0, '被拒的请求不应访问上游')
  cleanup(h)
})
