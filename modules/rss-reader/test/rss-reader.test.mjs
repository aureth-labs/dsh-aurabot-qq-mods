// 自主上网（rss-reader）测试：解析、去重、兴趣筛选、限额、失败退避、交付契约。
// 全部走注入的 fake fetch / fake api，不打真网络、不写模块源码目录。

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

let parseFeed, extractFeeds, stripHtml, decodeEntities, parseDate, fetchFeed, channelTitle
let createStateStore
let mod

before(async () => {
  ;({ parseFeed, extractFeeds, stripHtml, decodeEntities, parseDate, fetchFeed, channelTitle } = await import('../lib/feed.mjs'))
  ;({ createStateStore } = await import('../lib/state.mjs'))
  mod = (await import('../index.mjs')).default
})

let dataRoot = ''
beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'aurabot-rss-'))
})

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>某科技周刊</title>
  <item>
    <title><![CDATA[DeepSeek 发布新版本，开源模型再进一步]]></title>
    <description><![CDATA[<p>这次更新在大模型推理上有明显提升 &amp; 更多。</p>]]></description>
    <link>https://example.com/a</link>
    <guid>post-a</guid>
    <pubDate>Mon, 02 Nov 2026 10:00:00 +0800</pubDate>
  </item>
  <item>
    <title>��天的午饭吃什么</title>
    <description>普通的生活记录</description>
    <link>https://example.com/b</link>
    <guid>post-b</guid>
    <pubDate>Mon, 02 Nov 2026 09:00:00 +0800</pubDate>
  </item>
</channel></rss>`

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>某个博客</title>
  <entry>
    <title>手办分享：这只鲸鱼摆件好可爱</title>
    <summary>今天收到了新买的摆件，做工很细腻。</summary>
    <link href="https://blog.example.com/1"/>
    <id>urn:uuid:1</id>
    <updated>2026-11-02T12:00:00Z</updated>
  </entry>
</feed>`

// ---------- 解析层 ----------

test('解析 RSS：标题/摘要/链接/时间去标签与实体，最新在前', () => {
  const r = parseFeed(RSS_SAMPLE, { source: 'https://example.com/rss' })
  assert.equal(r.ok, true)
  assert.equal(r.title, '某科技周刊')
  assert.equal(r.items.length, 2)
  const [first, second] = r.items
  assert.match(first.title, /DeepSeek 发布新版本/)
  assert.match(first.summary, /大模型推理上有明显提升 & 更多/, 'CDATA + 标签 + 实体都要清干净')
  assert.equal(first.link, 'https://example.com/a')
  assert.ok(first.at > 0, 'pubDate 解析出时间')
  assert.ok(first.at >= second.at, '最新在前')
})

test('解析 Atom：link href 与 updated 都要认', () => {
  const r = parseFeed(ATOM_SAMPLE, { source: 'https://blog.example.com/atom' })
  assert.equal(r.ok, true)
  assert.equal(r.title, '某个博客')
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].link, 'https://blog.example.com/1')
  assert.ok(r.items[0].at > 0)
  assert.match(r.items[0].summary, /摆件/)
})

test('解析失败：空内容 / 网页 / 无条目都收敛成 ok:false，不抛', () => {
  assert.equal(parseFeed('', {}).ok, false)
  assert.equal(parseFeed('<html><body>不是 feed</body></html>', {}).ok, false)
  const noItems = parseFeed('<?xml?><rss><channel><title>空</title></channel></rss>', {})
  assert.equal(noItems.ok, true)
  assert.equal(noItems.items.length, 0, '合法 feed 但没条目：ok 且空数组')
})

test('清洗工具：实体解码、去标签、超长截断、时间解析', () => {
  assert.equal(decodeEntities('a &amp; b &#65; &#x4E2D;'), 'a & b A 中')
  assert.equal(stripHtml('<p>你好<br/>世界</p>', 100), '你好 世界')
  assert.equal(stripHtml('<div>x</div>'.repeat(100), 20).length, 21, '截断后带省略号')
  assert.ok(parseDate('Mon, 02 Nov 2026 10:00:00 +0800') > 0)
  assert.equal(parseDate('不是时间'), 0, '解析不了返回 0')
  assert.equal(channelTitle(ATOM_SAMPLE), '某个博客')
})

test('订阅源清单：一行一个、只认 http(s)、去重、跳过注释', () => {
  const feeds = extractFeeds(`
# 这是注释
https://a.example.com/rss
  https://b.example.com/atom  

ftp://nope.example.com/rss
https://a.example.com/rss
`)
  assert.deepEqual(feeds, ['https://a.example.com/rss', 'https://b.example.com/atom'])
})

// ---------- 抓取层 ----------

test('抓取：只支持 http(s)；超时/非 2xx 收敛成 ok:false', async () => {
  assert.equal((await fetchFeed('ftp://x', { fetchImpl: async () => ({}) })).ok, false)
  const bad = await fetchFeed('https://x.example.com', { fetchImpl: async () => ({ ok: false, status: 503 }) })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /503/)
  const boom = await fetchFeed('https://x.example.com', { fetchImpl: async () => { throw new Error('断网') } })
  assert.equal(boom.ok, false)
  assert.match(boom.error, /断网/)
  const good = await fetchFeed('https://x.example.com', {
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(RSS_SAMPLE).buffer }),
  })
  assert.equal(good.ok, true)
  assert.match(good.xml, /某科技周刊/)
})

// ---------- 状态层 ----------

test('状态：已读去重、跨天重置、失败退避、兴趣打分', () => {
  const file = join(dataRoot, 'rss-state.json')
  const store = createStateStore(file)
  store.markSeen(['a|1', 'a|2'])
  assert.equal(store.seenSet().size, 2)
  store.markSeen(['a|2', 'a|3'])
  assert.equal(store.seenSet().size, 3, '重复标记不增加')
  store.save()

  const reload = createStateStore(file)
  assert.equal(reload.seenSet().size, 3, '落盘后能读回')

  // 每日额度
  assert.equal(reload.remainingToday(0), Infinity, 'dailyMax=0 视为不限')
  assert.equal(reload.remainingToday(2), 2)
  reload.countFed(2)
  assert.equal(reload.remainingToday(2), 0)
  assert.equal(reload.remainingToday(2, Date.now() + 86400000), 2, '跨天重置')

  // 失败退避
  const store2 = createStateStore(join(dataRoot, 'rss-state2.json'))
  store2.recordFailure('https://x', 0)
  const b1 = store2.backoffFor('https://x')
  assert.ok(b1.minutes >= 2, '第一次失败退避 ≥2 分钟')
  store2.recordFailure('https://x', 0)
  assert.ok(store2.backoffFor('https://x').minutes >= b1.minutes, '连续失败退避变长')
  store2.recordSuccess('https://x')
  assert.equal(store2.backoffFor('https://x').minutes, 0, '成功后清零')

  // 兴趣打分：命中关键词 + 新鲜度
  const now = Date.now()
  const hot = store2.scoreEntry({ title: 'DeepSeek 发布新模型', summary: '开源插件', at: now - 3600_000 }, now)
  const cold = store2.scoreEntry({ title: '午饭吃什么', summary: '日常', at: now - 3 * 86400_000 }, now)
  assert.ok(hot.score > cold.score, '技术+新鲜度得分更高')
  assert.ok(hot.hits.length > 0)
})

// ---------- 模块入口 ----------

function makeApi({ settings = {}, fetch: fetchImpl, proactive = null } = {}) {
  const routes = {}
  const everyFns = []
  const logs = []
  const defaults = { ...mod.defaults, ...settings }
  const api = {
    settings: () => defaults,
    config: () => ({ ownerQQ: '10001', ownerName: '主人' }),
    dataDir: (p) => join(dataRoot, p || ''),
    log: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    route: (p, fn) => { routes[p] = fn },
    every: (ms, fn, label) => { everyFns.push({ ms, fn, label }); return () => {} },
    lazy: () => null,
    __rssTestHooks: { fetch: fetchImpl, now: () => Date.now() },
  }
  Object.defineProperty(api, 'proactive', {
    get: () => proactive || { available: false },
  })
  return { api, routes, everyFns, logs, defaults }
}

test('模块：拉取→去重→筛选→交付，走 proactive 决策面而不是自己发', async () => {
  const submitted = []
  const { api } = makeApi({
    settings: {
      enabled: true,
      feeds: 'https://feed.example.com/rss',
      minScore: 3,
      perFeed: 5,
      fetchMinutes: 120,
      carrier: 'policy',
    },
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(RSS_SAMPLE).buffer }),
    proactive: { available: true, submit: async (input) => { submitted.push(input); return { state: 'sent', deliveryId: 'dlv1' } } },
  })
  const exports = mod.setup(api)
  const r = await exports.run({ fresh: true })
  assert.equal(r.ok, true)
  assert.equal(r.report.ok, 1, '一个源拉成功')
  assert.equal(r.report.newItems, 2, '两个新条目')
  assert.ok(r.delivered.length >= 1, '至少挑出一条')
  assert.equal(submitted.length >= 1, true, '交给主动发言决策面')
  assert.equal(submitted[0].channel, 'qq')
  assert.match(submitted[0].itemId, /^https:\/\/feed\.example\.com\/rss\|/, 'itemId 带源前缀，跨源不撞')
  assert.match(submitted[0].text, /外部|看到/, '文本标明是看到的外部内容')
  // 脏标题（午饭）分数低，不该被挑中
  assert.equal(r.delivered.some((d) => /午饭/.test(d.title)), false, '低分条目不投喂')
})

test('模块：已读去重——同一批条目第二轮不再交付', async () => {
  const submitted = []
  const { api } = makeApi({
    settings: { enabled: true, feeds: 'https://feed.example.com/rss', minScore: 0, perFeed: 5, carrier: 'policy' },
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(RSS_SAMPLE).buffer }),
    proactive: { available: true, submit: async (i) => { submitted.push(i); return { state: 'sent' } } },
  })
  const exports = mod.setup(api)
  const first = await exports.run({ fresh: true })
  const countAfterFirst = submitted.length
  assert.ok(countAfterFirst > 0)
  const second = await exports.run({ fresh: true })
  assert.equal(second.report.newItems, 0, '第二轮没有新条目')
  assert.equal(submitted.length, countAfterFirst, '不重复交付')
})

test('模块：每日额度扣减；额度用完不再挑', async () => {
  const submitted = []
  let round = 0
  const { api } = makeApi({
    settings: { enabled: true, feeds: 'https://f.example.com/rss', minScore: 0, perFeed: 5, dailyMax: 1, carrier: 'policy' },
    // 每轮都返回一个"新"条目（guid 不同），验证额度才是瓶颈
    fetch: async () => {
      round += 1
      const xml = `<rss><channel><title>T</title><item><title>AI 新插件第 ${round} 期</title><link>https://e/${round}</link><guid>g${round}</guid><pubDate>Mon, 02 Nov 2026 10:00:00 +0800</pubDate></item></channel></rss>`
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(xml).buffer }
    },
    proactive: { available: true, submit: async (i) => { submitted.push(i); return { state: 'sent' } } },
  })
  const exports = mod.setup(api)
  await exports.run({ fresh: true })
  assert.equal(submitted.length, 1, '每日上限 1：第一轮交付 1 条')
  await exports.run({ fresh: true })
  assert.equal(submitted.length, 1, '额度用完：第二轮不再交付')
})

test('模块：决策面不可用时退化为素材池，不自己发消息', async () => {
  const { api } = makeApi({
    settings: { enabled: true, feeds: 'https://feed.example.com/rss', minScore: 0, perFeed: 5, carrier: 'policy' },
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(RSS_SAMPLE).buffer }),
    proactive: { available: false }, // 宿主没装出站策略
  })
  const exports = mod.setup(api)
  const r = await exports.run({ fresh: true })
  assert.equal(r.ok, true)
  assert.ok(r.delivered.length >= 1)
  assert.equal(r.delivered.every((d) => d.via === 'pool'), true, '全部退化为素材池')
  const mats = exports.materials()
  assert.ok(mats.length >= 1, '素材口能取到内容')
  assert.match(mats[0].id, /^rss:/)
  assert.ok(mats[0].text.length <= 240, '素材文本有长度上限')
})

test('模块：carrier=pool 时不碰 proactive，只进素材池', async () => {
  let submitCalled = false
  const { api } = makeApi({
    settings: { enabled: true, feeds: 'https://feed.example.com/rss', minScore: 0, perFeed: 5, carrier: 'pool' },
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(RSS_SAMPLE).buffer }),
    proactive: { available: true, submit: async () => { submitCalled = true; return { state: 'sent' } } },
  })
  const exports = mod.setup(api)
  await exports.run({ fresh: true })
  assert.equal(submitCalled, false, 'pool 模式绝不调决策面')
  assert.ok(exports.materials().length >= 1)
})

test('模块：总开关关着不跑；没配订阅源返回 no-feeds；并发调用被挡住', async () => {
  const { api: off } = makeApi({ settings: { enabled: false } })
  const offExports = mod.setup(off)
  assert.equal((await offExports.run()).reason, 'disabled')

  const { api: noFeeds } = makeApi({ settings: { enabled: true, feeds: '' } })
  assert.equal((await mod.setup(noFeeds).run()).reason, 'no-feeds')

  // 并发：慢源 + 同时两次 run，第二次应 busy
  let release
  const gate = new Promise((r) => { release = r })
  const { api: slow } = makeApi({
    settings: { enabled: true, feeds: 'https://slow.example.com/rss', minScore: 0, carrier: 'pool' },
    fetch: async () => { await gate; return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(RSS_SAMPLE).buffer } },
  })
  const slowExports = mod.setup(slow)
  const first = slowExports.run({ fresh: true })
  const second = await slowExports.run({ fresh: true })
  assert.equal(second.reason, 'busy', '并发第二次被拒')
  release()
  await first
})

test('模块：单源失败不影响其他源，并记退避', async () => {
  const { api } = makeApi({
    settings: { enabled: true, feeds: 'https://bad.example.com/rss\nhttps://good.example.com/rss', minScore: 0, perFeed: 5, carrier: 'pool' },
    fetch: async (url) => {
      if (String(url).includes('bad')) return { ok: false, status: 500 }
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(RSS_SAMPLE).buffer }
    },
  })
  const exports = mod.setup(api)
  const r = await exports.run({ fresh: true })
  assert.equal(r.report.ok, 1, '好的源成功')
  assert.equal(r.report.failed.length, 1, '坏的源记失败')
  const st = exports.status()
  assert.equal(st.failing.includes('https://bad.example.com/rss'), true, '失败源进退避名单')
})

test('模块：路由可用（state / run / latest / feeds test）', async () => {
  const { api, routes } = makeApi({
    settings: { enabled: true, feeds: 'https://feed.example.com/rss', minScore: 0, perFeed: 5, carrier: 'pool' },
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(RSS_SAMPLE).buffer }),
  })
  mod.setup(api)
  assert.equal(typeof routes['/state'], 'function')
  const st = await routes['/state']()
  assert.equal(st.ok, true)
  assert.equal(st.config.feeds.length, 1)
  const run = await routes['/run']()
  assert.equal(run.ok, true)
  const latest = await routes['/latest']()
  assert.ok(Array.isArray(latest.items))
  const t = await routes['/feeds/test']({ url: 'http://x/feed?url=https://feed.example.com/rss' })
  // 上面这种 query 形态在真实 http 里是 ?url=...；这里直接给带参数的 URL
  assert.equal(typeof t.ok, 'boolean')
})
