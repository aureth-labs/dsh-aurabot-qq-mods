// 0.2.0 六类能力：搜索六类型、榜单、歌单、每日/猜你喜欢、报告。
// 全部用官方文档字段构造的脱敏 fixture；不是真实 QQ 回包。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, fakeFetch, jsonResponse, OWNER_PRIVATE, GROUP } from './helpers.mjs'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
const KEY = 'qmk-fixture-0000-not-a-real-key'
const QQ = { platform: 'qq', qqKey: KEY }

const DAILY = {
  ret: 0,
  songlist: [
    { songMid: '0039MnYb0qxYhV', songName: '晴天', singerName: '周杰伦', songH5Url: 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV' },
    { songMid: '000MkMni1yWrP4', songName: '稻香', singerName: '周杰伦' },
  ],
}
const RADIO = {
  ret: 0,
  songlist: [
    { songMid: '001BLpXF2DyJe2', songName: '江南', singerName: '林俊杰' },
  ],
}

function qqFetch(routes = []) {
  return fakeFetch([
    ...routes,
    { match: (url) => url.endsWith('/discover/search'), reply: jsonResponse(fixture('qq-search-types.json')) },
    { match: (url) => url.endsWith('/charts/detail'), reply: jsonResponse(fixture('qq-chart-detail.json')) },
    { match: (url) => url.endsWith('/charts'), reply: jsonResponse(fixture('qq-charts.json')) },
    { match: (url) => url.endsWith('/discover/ai-playlists'), reply: jsonResponse(fixture('qq-ai-playlists.json')) },
    { match: (url) => url.endsWith('/playlists/detail'), reply: jsonResponse(fixture('qq-playlist-detail.json')) },
    { match: (url) => url.endsWith('/discover/daily-mix'), reply: jsonResponse(DAILY) },
    { match: (url) => url.endsWith('/discover/radio'), reply: jsonResponse(RADIO) },
    { match: (url) => url.endsWith('/me/report'), reply: jsonResponse(fixture('qq-report-month.json')) },
  ])
}

function setup(settings = QQ) {
  const fetch = qqFetch()
  const harness = createHarness({ fetch, settings })
  harness.mount()
  return { harness, fetch }
}

function bodyOf(call) {
  return JSON.parse(call.init.body)
}

test('搜索六类型：album/playlist/mv/radio/singer 按官方字段解析并带 H5', async () => {
  const { harness, fetch } = setup()
  const types = [
    ['album', /叶惠美/, '0025NhlN2yWrP4', /album/],
    ['playlist', /夜跑电子节拍/, '9011001', /playlist/],
    ['mv', /晴天/, '0139MnYb0qxYhV', /mv/],
    ['radio', /深夜电台/, '0039MnYb0qxYhV', /album/],
    ['singer', /周杰伦/, '0025NhlN2yWrP4', /singer/],
  ]
  for (const [type, title, id, linkPart] of types) {
    const result = await harness.raw.search({ query: '周杰伦', type })
    assert.equal(result.ok, true, type)
    assert.match(result.message, title, type)
    assert.match(result.message, new RegExp(id), `${type} 要带可选的 ID`)
    assert.match(result.message, linkPart, `${type} 要带 H5 链接`)
    const call = fetch.calls[fetch.calls.length - 1]
    assert.equal(bodyOf(call).params.type, { album: '1', playlist: '2', mv: '3', radio: '4', singer: '5' }[type])
    assert.equal(bodyOf(call).comm.skill_version, '0.0.3')
  }
  await harness.dispose()
})

test('搜索非歌曲类型：平台不是 QQ 时明确拒绝，不偷偷换源', async () => {
  const { harness, fetch } = setup({ platform: 'netease' })
  const result = await harness.raw.search({ query: '周杰伦', type: 'album' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unsupported-platform')
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('搜索非歌曲类型：没 Key 时未配置，0 请求', async () => {
  const { harness, fetch } = setup({ platform: 'qq' })
  const result = await harness.raw.search({ query: '周杰伦', type: 'singer' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-configured')
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('搜索分页：page 进入官方 params；小数/负数拒绝；超大页码截到 20', async () => {
  const { harness, fetch } = setup()
  const bad = await harness.raw.search({ query: '周杰伦', type: 'album', page: 1.5 })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'bad-argument')
  assert.equal(fetch.calls.length, 0)

  await harness.raw.search({ query: '周杰伦', type: 'album', page: 2 })
  assert.equal(bodyOf(fetch.calls[0]).params.page, 2)

  const huge = await harness.raw.search({ query: '周杰伦', type: 'album', page: 999 })
  assert.equal(huge.ok, true)
  assert.match(huge.message, /第 20 页/)
  assert.match(huge.message, /分页上限/)
  assert.equal(bodyOf(fetch.calls[1]).params.page, 20)
  await harness.dispose()
})

test('非歌曲搜索结果不会被当成歌曲分享（缓存按类型区分）', async () => {
  const { harness } = setup()
  await harness.raw.search({ query: '周杰伦', type: 'album' })
  const share = await harness.raw.share({ index: 1 })
  assert.equal(share.ok, false)
  assert.equal(share.code, 'not-song-list')
  assert.equal(harness.sends.length, 0)
  await harness.dispose()
})

test('排行榜分组：按组展示 topId/收听/前三首，不把第四首带出来', async () => {
  const { harness } = setup()
  const result = await harness.raw.charts({ action: 'groups' })
  assert.equal(result.ok, true)
  assert.match(result.message, /巅峰榜/)
  assert.match(result.message, /地区榜/)
  assert.match(result.message, /topId：26/)
  assert.match(result.message, /晴天/)
  assert.doesNotMatch(result.message, /不该出现的前四之外/)
  assert.equal(result.groups.length, 2)
  await harness.dispose()
})

test('榜单详情：曲目进歌曲缓存，可按序号分享；hasMore 如实说', async () => {
  const { harness } = setup()
  const result = await harness.raw.charts({ action: 'detail', topId: 26 })
  assert.equal(result.ok, true)
  assert.match(result.message, /热歌榜/)
  assert.match(result.message, /更新 2026-11-13/)
  assert.match(result.message, /还有更多/)
  assert.deepEqual(result.data.tracks.map((item) => item.title), ['晴天', '稻香'])

  const share = await harness.raw.share({ index: 2 })
  assert.equal(share.ok, true)
  assert.equal(harness.sends.length, 1)
  assert.match(harness.sends[0].text, /稻香/)
  await harness.dispose()
})

test('榜单详情：topId 非法时拒绝，0 请求', async () => {
  const { harness, fetch } = setup()
  const result = await harness.raw.charts({ action: 'detail', topId: 'abc' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad-argument')
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('榜单详情分页：page 进入 params，超过上限截到 20 并说明', async () => {
  const { harness, fetch } = setup()
  await harness.raw.charts({ action: 'detail', topId: 26, page: 2 })
  assert.deepEqual(bodyOf(fetch.calls[0]).params, { topId: 26, page: 2 })
  const huge = await harness.raw.charts({ action: 'detail', topId: 26, page: 999 })
  assert.equal(huge.ok, true)
  assert.match(huge.message, /第 20 页/)
  assert.match(huge.message, /分页上限/)
  await harness.dispose()
})

test('AI 歌单：只给主人私聊；列表带 dissId，详情可看曲目', async () => {
  const { harness, fetch } = setup()
  const list = await harness.raw.playlist({ action: 'ai' })
  assert.equal(list.ok, true)
  assert.match(list.message, /AI 夜跑歌单/)
  assert.match(list.message, /dissId：9012001/)
  assert.equal(bodyOf(fetch.calls[0]).params.reqType, 'all')

  const detail = await harness.raw.playlist({ action: 'detail', dissId: 9012001 })
  assert.equal(detail.ok, true)
  assert.match(detail.message, /AI 夜跑歌单/)
  assert.match(detail.message, /晴天/)
  assert.match(detail.message, /还有更多/)
  assert.equal(bodyOf(fetch.calls[1]).params.dissId, 9012001)
  await harness.dispose()
})

test('AI 歌单：群聊拒绝，0 请求', async () => {
  const { harness, fetch } = setup()
  const result = await harness.exports.playlist({
    action: 'ai',
    chat: GROUP.chat,
    sessionId: GROUP.sessionId,
    chatId: GROUP.chat.chatId,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'private-only')
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('歌单详情：dissId 非法时拒绝，0 请求', async () => {
  const { harness, fetch } = setup()
  const result = await harness.raw.playlist({ action: 'detail', dissId: '9012001x' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad-argument')
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('每日推荐：走 /discover/daily-mix，标签是「每日30首」不是场景', async () => {
  const { harness, fetch } = setup()
  const result = await harness.raw.recommend({ kind: 'daily' })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'daily')
  assert.match(result.message, /每日30首/)
  assert.doesNotMatch(result.message, /学习|场景/)
  assert.ok(fetch.calls[0].url.endsWith('/discover/daily-mix'))
  await harness.dispose()
})

test('猜你喜欢：走 /discover/radio，与每日推荐分开', async () => {
  const { harness, fetch } = setup()
  const result = await harness.raw.recommend({ kind: 'guess' })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'guess')
  assert.match(result.message, /猜你喜欢/)
  assert.ok(fetch.calls[0].url.endsWith('/discover/radio'))
  await harness.dispose()
})

test('每日推荐：显式 platform=netease 时拒绝，不冒充', async () => {
  const { harness, fetch } = setup()
  const result = await harness.raw.recommend({ kind: 'daily', platform: 'netease' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad-argument')
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('每日推荐：没 Key 时未配置，0 请求', async () => {
  const { harness, fetch } = setup({ platform: 'qq' })
  const result = await harness.raw.recommend({ kind: 'daily' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-configured')
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

// ---------- 开关交叉与缺 Key 边界 ----------

test('歌单搜索（type=2）同时受「分类歌单」开关约束', async () => {
  const { harness, fetch } = setup({ ...QQ, playlistEnabled: false })
  const result = await harness.raw.search({ query: '夜跑', type: 'playlist' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'feature-disabled')
  assert.match(result.message, /分类歌单/)
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('显式 platform=netease 搜专辑：拒绝，不拿 QQ 冒充', async () => {
  const { harness, fetch } = setup()
  const result = await harness.raw.search({ query: '周杰伦', type: 'album', platform: 'netease' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unsupported-platform')
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('QQ 歌曲搜索支持 page；网易云分页明确拒绝且不发请求', async () => {
  const songsFetch = fakeFetch([{ match: (url) => url.endsWith('/discover/search'), reply: jsonResponse(fixture('qq-search.json')) }])
  const h = createHarness({ fetch: songsFetch, settings: QQ })
  h.mount()
  const qq = await h.raw.search({ query: '晴天', platform: 'qq', page: 2 })
  assert.equal(qq.ok, true)
  assert.equal(JSON.parse(songsFetch.calls[0].init.body).params.page, 2)
  await h.dispose()

  const netease = fakeFetch([{ match: 'api/cloudsearch/pc', reply: jsonResponse(fixture('netease-search.json')) }])
  const h2 = createHarness({ fetch: netease })
  h2.mount()
  const page = await h2.raw.search({ query: '晴天', page: 1 })
  assert.equal(page.ok, false)
  assert.equal(page.code, 'unsupported-page')
  assert.equal(netease.calls.length, 0)
  await h2.dispose()
})

test('缺 Key 时榜单/歌单详情/报告/解读/每日推荐都未配置且 0 请求', async () => {
  const { harness, fetch } = setup({ platform: 'qq', reportEnabled: true, interpretEnabled: true })
  const calls = [
    harness.raw.charts({ action: 'groups' }),
    harness.raw.playlist({ action: 'detail', dissId: 9012001 }),
    harness.raw.report({ period: 'day' }),
    harness.raw.interpret({ query: '分析我的听歌风格' }),
    harness.raw.recommend({ kind: 'daily' }),
  ]
  for (const pending of calls) {
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.code, 'not-configured')
  }
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

// 第1次退回 R4：场景推荐依赖 recommend+playlist，关掉分类歌单后必须拒绝且 0 联网
// （原断言「仍然 ok:true」与 R4 的依赖要求冲突，已按验收单修正）
test('关闭分类歌单后，场景推荐直接拒绝且不偷调 QQ 歌单接口', async () => {
  const detail = fixture('netease-detail.json')
  const fetch = fakeFetch([
    { match: (url) => url.includes('api/playlist/list'), reply: jsonResponse(fixture('netease-playlists.json')) },
    {
      match: (url) => url.includes('api/v6/playlist/detail'),
      reply: (url, init) => {
        const id = new URLSearchParams(String(init?.body || '')).get('id')
        return jsonResponse({ result: id === '111' ? detail.playlist : detail.playlist222 })
      },
    },
  ])
  const harness = createHarness({ fetch, settings: { ...QQ, playlistEnabled: false } })
  harness.mount()
  const result = await harness.raw.recommend({ kind: 'scene', scene: '学习' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'feature-disabled')
  assert.match(result.message, /分类歌单/)
  assert.equal(fetch.calls.length, 0, '依赖被关闭后一条请求都不该发')
  assert.equal(fetch.calls.some((call) => call.url.includes('a.y.qq.com')), false)
  await harness.dispose()
})

test('每日推荐/猜你喜欢的结果能按序号分享（缓存仍是歌曲组）', async () => {
  const { harness } = setup()
  await harness.raw.recommend({ kind: 'daily' })
  const share = await harness.raw.share({ index: 1 })
  assert.equal(share.ok, true)
  assert.equal(harness.sends.length, 1)
  assert.match(harness.sends[0].text, /晴天/)
  await harness.dispose()

  const h2 = setup().harness
  await h2.raw.recommend({ kind: 'guess' })
  const guess = await h2.raw.share({ index: 1 })
  assert.equal(guess.ok, true)
  assert.equal(h2.sends.length, 1)
  await h2.dispose()
})

test('QQ 翻页失败时不悄悄退回网易云第 1 页', async () => {
  const fetch = fakeFetch([
    { match: (url) => url.endsWith('/discover/search'), reply: jsonResponse({}, { status: 500 }) },
    { match: 'api/cloudsearch/pc', reply: jsonResponse(fixture('netease-search.json')) },
  ])
  const harness = createHarness({ fetch, settings: QQ })
  harness.mount()
  const result = await harness.raw.search({ query: '晴天', page: 2 })
  assert.equal(result.ok, false)
  assert.match(result.message, /分页请求不会改用/)
  assert.equal(fetch.calls.some((call) => call.url.includes('music.163.com')), false)
  await harness.dispose()
})
