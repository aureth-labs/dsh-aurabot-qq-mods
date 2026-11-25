// 热榜巡游模块测试：不打真网络（fetch 全注入），不写模块源码目录（数据进临时目录）。
// 覆盖：tophub HTML 解析、直连失败走 60s 兜底、缓存复用、失败冷却回落旧缓存、
// 巡游分享去重限量、tick 场次判定。跑法见仓库根 scripts/plugin-env.mjs：
//   AURABOT_PLUGIN_DIR=<插件目录> node --import ./scripts/plugin-env.mjs --test "modules/tophub/test/*.test.mjs"

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFetcher, parseTophub, BUILTIN_NODES } from '../lib/fetch.mjs'
import { createBrowse } from '../lib/browse.mjs'

const TOOPHUB_HTML = `<html><body><table>
<tr class="head"><th>热度</th></tr>
<tr><td class="item1">1</td><td class="al"><a href="https://s.weibo.com/weibo?q=%E7%83%AD%E6%90%9C%E4%B8%80" target="_blank">热搜一号</a></td><td class="item2">123456</td></tr>
<tr><td class="item1">2</td><td class="al"><a href="https://example.com/two" target="_blank">热搜二号</a></td><td class="item2">98765</td></tr>
</table></body></html>`

const sixtyOk = (titles) => ({ ok: true, json: async () => ({ code: 200, data: titles.map((t) => ({ title: t, hot_value: 1 })) }) })
const tophubOk = () => ({ ok: true, text: async () => TOOPHUB_HTML })

function tmpFetchDir() {
  return mkdtempSync(join(tmpdir(), 'tophub-test-'))
}

test('parseTophub 抽出标题/链接/热度，脏行忽略', () => {
  const items = parseTophub(TOOPHUB_HTML)
  assert.equal(items.length, 2)
  assert.equal(items[0].title, '热搜一号')
  assert.equal(items[0].url, 'https://s.weibo.com/weibo?q=%E7%83%AD%E6%90%9C%E4%B8%80')
  assert.equal(items[0].hot, '123456')
  assert.equal(parseTophub('<html>被 WAF 挡了的页面</html>').length, 0)
  assert.equal(parseTophub('').length, 0)
})

test('直连 tophub 成功就直接用；失败自动走 60s 兜底', async () => {
  const dir = tmpFetchDir()
  const hits = []
  let tophubAlive = true // 第一轮直连活着，之后挂（模拟 WAF）
  const f = createFetcher({
    cacheDir: dir, gapMs: 0,
    fetchImpl: async (url) => {
      hits.push(url)
      if (String(url).includes('tophub.today')) {
        if (!tophubAlive) throw new Error('HTTP 403')
        return tophubOk()
      }
      return sixtyOk(['兜底条目甲', '兜底条目乙'])
    },
  })
  // 直连能成功：自定义节点 id 一发即中
  const r1 = await f.hot('K7GdaMgdQy')
  assert.equal(r1.ok, true)
  assert.equal(r1.source, 'tophub')
  assert.equal(r1.items[0].title, '热搜一号')
  // 之后 WAF 把直连全拦了：内置「微博热搜」直连挂 → 自动接 60s
  tophubAlive = false
  const r2 = await f.hot('微博热搜')
  assert.equal(r2.ok, true)
  assert.equal(r2.source, '60s')
  assert.equal(r2.items.length, 2)
  assert.ok(hits.some((u) => u.includes('60s-api.viki.moe/v2/weibo')))
  rmSync(dir, { recursive: true, force: true })
})

test('双层全失败返回 ok:false 不抛异常；冷却期内回落旧缓存并标记 stale', async () => {
  const dir = tmpFetchDir()
  let fail = true
  const f = createFetcher({
    cacheDir: dir, gapMs: 0, coolMs: 60_000,
    fetchImpl: async () => { if (fail) throw new Error('HTTP 403'); return sixtyOk(['恢复后的条目']) },
  })
  const bad = await f.hot('抖音热点')
  assert.equal(bad.ok, false)
  assert.ok(bad.error.includes('403'))
  // 放开失败后手动塞一条缓存，模拟「之前成功过」
  fail = false
  rmSync(dir, { recursive: true, force: true })
  const dir2 = tmpFetchDir()
  const f2 = createFetcher({ cacheDir: dir2, gapMs: 0, coolMs: 60_000, fetchImpl: async () => sixtyOk(['旧缓存条目']) })
  assert.equal((await f2.hot('B站热门')).items[0].title, '旧缓存条目')
  // 30 分钟内再取走缓存，不再发请求
  const r = await f2.hot('B站热门')
  assert.equal(r.cached, true)
  assert.equal(r.source, '60s')
  rmSync(dir2, { recursive: true, force: true })
})

test('search 只对没缓存的榜限量真拉，命中按标题过滤', async () => {
  const dir = tmpFetchDir()
  const fetched = []
  const f = createFetcher({
    cacheDir: dir, gapMs: 0,
    fetchImpl: async (url) => {
      fetched.push(url)
      if (String(url).includes('tophub.today')) throw new Error('HTTP 403') // 直连常态失败，走 60s
      return sixtyOk(['今天机器人上热搜了', '别的新闻'])
    },
  })
  const r = await f.search('机器人', { names: ['微博热搜', '抖音热点'], liveNodes: 1, limit: 5 })
  assert.equal(r.ok, true)
  assert.equal(r.hits.length, 1)
  assert.equal(r.hits[0].node, '微博热搜')
  // liveNodes=1：只有第一个榜真拉（tophub 挂一次 + 60s 接上 = 2 次），第二个榜没缓存就不碰
  assert.equal(fetched.filter((u) => u.includes('60s-api')).length, 1)
  assert.equal(fetched.length, 2)
  const none = await f.search('绝对搜不到的词xyz', { names: ['微博热搜'], liveNodes: 0 })
  assert.equal(none.hits.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

// ---------- browse ----------

function fakeApi(cfg, dataDir, extra = {}) {
  return {
    dataDir: (...p) => join(dataDir, ...p),
    log: { info() {}, warn() {}, error() {} },
    settings: () => ({ ...cfg }),
    ...extra,
  }
}

function fakeBrowse(cfg, overrides = {}) {
  const dir = tmpFetchDir()
  const sent = [], remembered = [], thinks = [], submitted = []
  const fetcher = createFetcher({
    cacheDir: join(dir, 'cache'), gapMs: 0,
    fetchImpl: async () => sixtyOk(overrides.items || ['热点甲', '热点乙', '热点丙']),
  })
  // proactive 假面：不传就完全没有（模拟旧主仓）；传了按用例决定返回什么
  const proactive = overrides.proactive
    ? { submit: async (args) => { submitted.push(args); return overrides.proactive(args) } }
    : undefined
  const browse = createBrowse({
    api: fakeApi(cfg, dir, proactive ? { proactive } : {}),
    fetcher,
    memory: { add: (x) => remembered.push(x), recall: () => [] },
    ownerQQ: '10001',
    think: async (prompt) => { thinks.push(prompt); return overrides.thinkOut },
    // 默认当作网关确认发出（旧 sendText 成功返回结果对象）；用例可改成返回 null 模拟被拦
    sendText: async (chatId, text) => { sent.push({ chatId, text }); return 'sendResult' in overrides ? overrides.sendResult : { message_id: 1 } },
    now: () => overrides.now || new Date('2026-11-02T09:31:00'),
  })
  return { browse, sent, remembered, thinks, submitted, dir }
}

const GOOD_THINK = '[{"node":"微博热搜","feeling":"有点意思","share":"机器人话题很火","remember":"AI 又上热搜了"}]'

test('tour：读榜 → 感想 → 限量分享到主人私聊 + 写记忆', async () => {
  const { browse, sent, remembered, thinks } = fakeBrowse(
    { enabled: true, nodes: ['微博热搜', '抖音热点'], nodesPerTour: 2, itemsPerNode: 15, shareLimit: 2 },
    { thinkOut: GOOD_THINK },
  )
  const r = await browse.tour()
  assert.equal(r.ok, true)
  assert.equal(r.shared, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, 'private:10001')
  assert.ok(sent[0].text.includes('机器人话题很火'))
  // remember 一条 + 每轮必写的巡游经历一条
  assert.equal(remembered.length, 2)
  assert.ok(remembered.some((x) => x.tags.includes('热榜') && x.text.includes('巡游')), '每轮经历必须进记忆')
  assert.ok(thinks[0].includes('热点甲'))
  // 历史落盘：面板「记录」区能翻到
  assert.equal(browse.history().length, 1)
  assert.equal(browse.history()[0].shared[0].text, '机器人话题很火')
})

test('tour：同一条感想不重复分享（seen 去重）', async () => {
  const { browse, sent } = fakeBrowse(
    { enabled: true, nodes: ['微博热搜'], nodesPerTour: 1, itemsPerNode: 15, shareLimit: 5 },
    { thinkOut: GOOD_THINK },
  )
  await browse.tour()
  const r2 = await browse.tour()
  assert.equal(r2.shared, 0)
  assert.equal(sent.length, 1)
})

// ---------- 出站治理：发送成功才记 seen（设计稿 §1.4 迁移项）----------

test('tour：网关拦下（sendText 返回 null）时不算分享、也不记 seen，下一场还能再发', async () => {
  const blocked = fakeBrowse(
    { enabled: true, nodes: ['微博热搜'], nodesPerTour: 1, itemsPerNode: 15, shareLimit: 2 },
    { thinkOut: GOOD_THINK, sendResult: null }, // 被拦 / 失败：老调用口返回 null
  )
  const r1 = await blocked.browse.tour()
  assert.equal(r1.ok, true)
  assert.equal(r1.shared, 0, '没发出去就不能算分享成功')
  assert.equal(blocked.browse.status().seenCount, 0, '被拦的条目绝不能记进 seen')
  assert.equal(blocked.browse.history()[0].shared.length, 0, '巡游历史里也不能写成分享成功')
  // 下一轮同一句话照样会再试一次（因为没记账，不是被去重挡掉）
  const r2 = await blocked.browse.tour()
  assert.equal(blocked.sent.length, 2, '两次都真的尝试发了')
  assert.equal(r2.shared, 0)
  rmSync(blocked.dir, { recursive: true, force: true })
})

test('tour：sendText 抛错也按「没发出去」处理，不记 seen', async () => {
  const dir = tmpFetchDir()
  const browse = createBrowse({
    api: fakeApi({ enabled: true, nodes: ['微博热搜'], nodesPerTour: 1, itemsPerNode: 15, shareLimit: 2 }, dir),
    fetcher: createFetcher({ cacheDir: join(dir, 'cache'), gapMs: 0, fetchImpl: async () => sixtyOk(['热点甲']) }),
    memory: { add() {}, recall: () => [] },
    ownerQQ: '10001',
    think: async () => GOOD_THINK,
    sendText: async () => { throw new Error('网关炸了') },
    now: () => new Date('2026-11-02T09:31:00'),
  })
  const r = await browse.tour()
  assert.equal(r.shared, 0)
  assert.equal(browse.status().seenCount, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('tour：有 api.proactive 时优先走 proactive.submit，不再直调 sendText', async () => {
  const got = fakeBrowse(
    { enabled: true, nodes: ['微博热搜'], nodesPerTour: 1, itemsPerNode: 15, shareLimit: 2 },
    { thinkOut: GOOD_THINK, proactive: () => ({ deliveryId: 'dlv-1', state: 'sent' }) },
  )
  const r = await got.browse.tour()
  assert.equal(r.shared, 1)
  assert.equal(got.submitted.length, 1, '走的是治理面')
  assert.equal(got.submitted[0].channel, 'qq')
  assert.equal(got.submitted[0].to, 'private:10001')
  assert.ok(got.submitted[0].itemId.startsWith('tophub:'), 'itemId 用巡游条目的稳定指纹')
  assert.ok(got.submitted[0].text.includes('机器人话题很火'))
  assert.equal(got.sent.length, 0, '走了 proactive 就不再重复直发')
  rmSync(got.dir, { recursive: true, force: true })
})

test('tour：proactive 回 unsupported / 没投递单号时退回老 sendText 路径', async () => {
  const fallback = fakeBrowse(
    { enabled: true, nodes: ['微博热搜'], nodesPerTour: 1, itemsPerNode: 15, shareLimit: 2 },
    { thinkOut: GOOD_THINK, proactive: () => ({ deliveryId: null, state: 'unsupported' }) },
  )
  const r = await fallback.browse.tour()
  assert.equal(r.shared, 1)
  assert.equal(fallback.submitted.length, 1, '先问过治理面')
  assert.equal(fallback.sent.length, 1, '档位不支持就退回旧通道，功能不能缺')
  assert.equal(fallback.browse.status().seenCount, 1)
  rmSync(fallback.dir, { recursive: true, force: true })
})

test('tour：proactive 提交抛错时降级到 sendText，巡游不中断', async () => {
  const broken = fakeBrowse(
    { enabled: true, nodes: ['微博热搜'], nodesPerTour: 1, itemsPerNode: 15, shareLimit: 2 },
    { thinkOut: GOOD_THINK, proactive: () => { throw new Error('策略源炸了') } },
  )
  const r = await broken.browse.tour()
  assert.equal(r.ok, true)
  assert.equal(r.shared, 1)
  assert.equal(broken.sent.length, 1)
  rmSync(broken.dir, { recursive: true, force: true })
})

test('tour：shareLimit=0 只看不分享；模型输出不是 JSON 也写记忆落记录', async () => {
  const a = fakeBrowse({ enabled: true, nodes: ['微博热搜'], nodesPerTour: 1, shareLimit: 0 }, { thinkOut: GOOD_THINK })
  const ra = await a.browse.tour()
  assert.equal(ra.shared, 0)
  assert.equal(a.sent.length, 0)
  // 没分享 ≠ 没收获：经历照样进记忆、进记录
  assert.ok(a.remembered.some((x) => x.text.includes('巡游')))
  assert.equal(a.browse.history().length, 1)
  const b = fakeBrowse({ enabled: true, nodes: ['微博热搜'], nodesPerTour: 1, shareLimit: 2 }, { thinkOut: '今天没啥想说的' })
  const rb = await b.browse.tour()
  assert.equal(rb.ok, false)
  assert.ok(rb.message.includes('记录'))
  // 就算模型不给感想，逛过的经历也必须留下
  assert.ok(b.remembered.some((x) => x.text.includes('巡游')))
  assert.equal(b.browse.history().length, 1)
})

test('tick：到点逛一场，同一天同一场次不重复逛；没到点不逛', async () => {
  const cfg = { enabled: true, tourTimes: '09:30', nodes: ['微博热搜'], nodesPerTour: 1, itemsPerNode: 15, shareLimit: 2 }
  const { browse, sent, dir } = fakeBrowse(cfg, { thinkOut: GOOD_THINK })
  // 09:00 还没到点
  const early = fakeBrowse(cfg, { now: new Date('2026-11-02T09:00:00'), thinkOut: GOOD_THINK })
  await early.browse.tick()
  assert.equal(early.sent.length, 0)
  // 09:31 到点，逛一场
  await browse.tick()
  assert.equal(sent.length, 1)
  // 再 tick：今天这场已经逛过
  await browse.tick()
  assert.equal(sent.length, 1)
  // 第二天同一时刻，新的一天重新逛
  const day2 = fakeBrowse(cfg, { now: new Date('2026-11-03T09:31:00'), thinkOut: GOOD_THINK })
  await day2.browse.tick()
  assert.equal(day2.sent.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('tour：模型挂掉（think 抛错）仍把逛到的榜写进记录和记忆', async () => {
  const dir = tmpFetchDir()
  const remembered = []
  const browse = createBrowse({
    api: { dataDir: (...p) => join(dir, ...p), log: { info() {}, warn() {}, error() {} }, settings: () => ({ enabled: true, nodes: ['微博热搜'], nodesPerTour: 1, itemsPerNode: 15, shareLimit: 2 }) },
    fetcher: createFetcher({ cacheDir: join(dir, 'cache'), gapMs: 0, fetchImpl: async () => sixtyOk(['热点甲', '热点乙']) }),
    memory: { add: (x) => remembered.push(x), recall: () => [] },
    ownerQQ: '10001',
    think: async () => { throw new Error('这一轮没正常结束：error') },
    sendText: async () => {},
  })
  const r = await browse.tour()
  assert.equal(r.ok, false)
  assert.ok(r.message.includes('模型这轮没回话'))
  // 关键：榜真拉到了，记录和记忆都不能丢
  assert.equal(browse.history().length, 1)
  assert.equal(browse.history()[0].boards[0], '微博热搜')
  assert.ok(remembered.some((x) => x.text.includes('巡游')))
  rmSync(dir, { recursive: true, force: true })
})

test('60s 日报结构（data.news 字符串数组）也认，条目归一出 title', async () => {
  const dir = tmpFetchDir()
  const f = createFetcher({
    cacheDir: dir, gapMs: 0,
    fetchImpl: async (url) => {
      if (String(url).includes('tophub.today')) throw new Error('HTTP 403')
      return { ok: true, json: async () => ({ code: 200, data: { date: '2026-11-02', news: ['今天的第一条新闻', '第二条新闻'] } }) }
    },
  })
  const r = await f.hot('60秒读懂世界')
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 2)
  assert.equal(r.items[0].title, '今天的第一条新闻')
  assert.equal(r.items[0].url, '')
  rmSync(dir, { recursive: true, force: true })
})

test('目录与模块自检：内置榜都有名字和兜底端点', () => {
  assert.ok(BUILTIN_NODES.length >= 5)
  for (const n of BUILTIN_NODES) {
    assert.ok(n.name, '榜要有名字')
    assert.ok(n.sixty || n.tophub, `${n.name} 至少得有一条取数路`)
  }
})
