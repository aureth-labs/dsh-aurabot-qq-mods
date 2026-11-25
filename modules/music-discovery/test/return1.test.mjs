// MUSIC-20261112-01 第 1 次退回（R1–R6）回归测试。
// 这里的每一条都对应 Codex 验收报告里的一个复现点，断言的是「修正后的正确行为」。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, fakeFetch, jsonResponse, OWNER_PRIVATE, GROUP } from './helpers.mjs'
import { requestJson } from '../lib/http.mjs'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
const SEARCH = fixture('netease-search.json')

function setup({ settings = {}, send, body = SEARCH } = {}) {
  const fetch = fakeFetch([{ match: 'api/cloudsearch/pc', reply: jsonResponse(body) }])
  const harness = createHarness({ fetch, settings, send })
  harness.mount()
  return { harness, fetch }
}

// ---------------- R1：回执按真实宿主契约判定 ----------------

test('R1 默认成功用例：mock 返回带 message_id 的确认回执，才算已发送', async () => {
  const { harness } = setup()
  await harness.raw.search({ query: '晴天' })
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'delivered')
  assert.equal(harness.sends.length, 1)
})

test('R1 sendText 返回 null：不能报已发，ok=false 且不补发', async () => {
  const { harness } = setup()
  await harness.raw.search({ query: '晴天' })
  harness.api.sendText = async () => null
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  // 第2次退回 B2：null 也可能是超时后的未确认，不能判成「确定没发」，
  // 所以从 not-sent 改为 send-unknown，并进入同曲短期防重发。
  assert.equal(result.code, 'send-unknown')
  assert.doesNotMatch(result.message, /已发到当前聊天/)
  assert.match(result.message, /没有拿到确认回执|不能断定没发/)
})

test('R1 sendSegments（卡片）返回 null：不报已发，也不当成「卡片不支持」去补链接', async () => {
  const { harness } = setup({ settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '晴天' })
  harness.api.sendSegments = async () => null
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  assert.doesNotMatch(result.message, /已发到当前聊天/)
  assert.equal(harness.sends.length, 0, 'null 之后不许补发链接')
})

test('R1 面板模拟（message_id 是 sim-*）：单独说清楚没有真发', async () => {
  const { harness } = setup({ send: { behavior: 'simulate' } })
  await harness.raw.search({ query: '晴天' })
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.status, 'simulated')
  assert.match(result.message, /面板模拟/)
  assert.match(result.message, /没有真发到 QQ/)
  assert.doesNotMatch(result.message, /^已发到当前聊天/)
})

test('R1 回执没有 message_id：当成不明，不报成功也不重发', async () => {
  const { harness } = setup()
  await harness.raw.search({ query: '晴天' })
  harness.api.sendText = async () => ({ ok: true })
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'send-unknown')
  assert.match(result.message, /没拿到确认回执/)
})

// ---------------- R2：只有明确「卡片不支持」才允许兜底 ----------------

test('R2 未知异常（delivery outcome unknown）不得补发链接', async () => {
  const { harness } = setup({ settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '晴天' })
  harness.api.sendSegments = async () => {
    throw new Error('delivery outcome unknown')
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'send-unknown')
  assert.equal(harness.sends.length, 0, '1 条都不能补发')
})

test('R2 明确「不支持卡片」才退链接，且只发 1 条', async () => {
  const { harness } = setup({ settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '晴天' })
  harness.api.sendSegments = async () => {
    throw new Error('unsupported segment')
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.form, 'link')
  assert.equal(harness.sends.length, 1)
  assert.equal(harness.sends[0].kind, 'text')
})

test('R2 断线/超时类异常同样不补发', async () => {
  const { harness } = setup({ settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '晴天' })
  harness.api.sendSegments = async () => {
    throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  assert.equal(harness.sends.length, 0)
})

// ---------------- R3：每一次真实发送前都复核 ----------------

test('R3 卡片失败转链接前会再复核身份：中途被撤权就不补发', async () => {
  const { harness } = setup({ settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '晴天' })
  harness.api.sendSegments = async () => {
    harness.state.owner = false // 卡片这一次失败的同时，当前轮主人判定变了
    throw new Error('unsupported segment')
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'forbidden')
  assert.equal(harness.sends.length, 0, '兜底那条也不能发')
})

test('R3 兜底发送前发现模块已卸载：不发', async () => {
  const { harness } = setup({ settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '晴天' })
  harness.api.sendSegments = async () => {
    await harness.dispose() // 模拟发送过程中模块被停掉
    throw new Error('unsupported segment')
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'disposed')
  assert.equal(harness.sends.length, 0)
})

test('R3 每次发送尝试都重新读设置（关掉 ownerOnly 后仍按当前轮判定）', async () => {
  const { harness } = setup({ settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '晴天' })
  harness.api.sendSegments = async () => {
    harness.state.settings.ownerOnly = true // 第一次发送后主人改回了「只给主人用」
    harness.state.owner = false
    throw new Error('unsupported segment')
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  assert.equal(harness.sends.length, 0)
})

// ---------------- R4：不满足歌手/版本、或有歧义时不自动挑第 1 条 ----------------

const WRONG_ARTIST = {
  code: 200,
  result: { songs: [{ id: 1412022124, name: '晴天', ar: [{ name: '空匪' }], originCoverType: 1 }] },
}

test('R4 指定周杰伦但平台只回空匪：搜索如实未命中，并列出替代候选', async () => {
  const { harness } = setup({ body: WRONG_ARTIST })
  const result = await harness.raw.search({ query: '晴天', artist: '周杰伦', version: 'original' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'artist-mismatch')
  assert.match(result.message, /没找到「周杰伦」/)
  assert.match(result.message, /空匪/)
  assert.match(result.message, /第几首/)
  assert.equal(result.candidates.length, 1, '替代候选仍然保留，供用户明确选择')
})

test('R4 关键词分享（晴天 周杰伦）绝不自作主张发空匪那条', async () => {
  const { harness } = setup({ body: WRONG_ARTIST })
  await harness.raw.search({ query: '晴天', artist: '周杰伦', version: 'original' })
  const result = await harness.raw.share({ keyword: '晴天 周杰伦' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'needs-choice')
  assert.equal(harness.sends.length, 0)
  assert.match(result.message, /空匪/)
})

test('R4 用户明确点序号后，才分享那条替代候选', async () => {
  const { harness } = setup({ body: WRONG_ARTIST })
  await harness.raw.search({ query: '晴天', artist: '周杰伦', version: 'original' })
  const share = await harness.raw.share({ index: 1 })
  assert.equal(share.ok, true)
  assert.equal(harness.sends.length, 1)
  assert.match(harness.sends[0].text, /空匪/)
})

test('R4 歧义（同名多歌手）会在搜索里点明；关键词分享要求选择', async () => {
  const { harness } = setup()
  const result = await harness.raw.search({ query: '晴天', limit: 5 })
  assert.equal(result.ok, true)
  assert.match(result.message, /同名歌有多个歌手/)

  const share = await harness.raw.share({ keyword: '晴天' })
  assert.equal(share.ok, false)
  assert.equal(share.code, 'needs-choice')
  assert.equal(harness.sends.length, 0)
})

test('R4 关键词唯一精确同名时允许直接分享（不牺牲正常点歌）', async () => {
  const one = { code: 200, result: { songs: [{ id: 186016, name: '晴天', ar: [{ name: '周杰伦' }], al: { name: '叶惠美' }, dt: 269000, originCoverType: 1 }] } }
  const { harness } = setup({ body: one })
  const share = await harness.raw.share({ keyword: '晴天' })
  assert.equal(share.ok, true)
  assert.equal(harness.sends.length, 1)
  assert.match(harness.sends[0].text, /music\.163\.com\/song\?id=186016/)
})

// ---------------- R5：不可分享条目必须 0 发送 ----------------

test('R5 没有链接也做不了卡片的条目：拒绝分享，0 发送', async () => {
  const broken = { code: 200, result: { songs: [{ id: 'invalid-id', name: '坏条目', ar: [{ name: '某人' }] }] } }
  const { harness } = setup({ body: broken })
  await harness.raw.search({ query: '坏条目' })
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-shareable')
  assert.equal(harness.sends.length, 0)
  assert.doesNotMatch(result.message, /已发到当前聊天/)
})

test('R5 卡片模式也不行：没有数字 ID 的网易云条目不会被硬做卡片', async () => {
  const broken = { code: 200, result: { songs: [{ id: 'abc', name: '坏条目', ar: [{ name: '某人' }] }] } }
  const { harness } = setup({ body: broken, settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '坏条目' })
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  assert.equal(harness.sends.length, 0)
  assert.match(result.message, /做不了原生卡片|没有可用的分享形式/)
})

// ---------------- R6：重定向逐跳复核 ----------------

test('R6 跳到非平台域名：直接拒绝，且不会向外域发第二个请求', async () => {
  const fetch = fakeFetch([
    { match: 'music.163.com', reply: jsonResponse({}, { status: 302, headers: { location: 'https://evil.example.com/steal' } }) },
  ])
  await assert.rejects(
    () => requestJson('https://music.163.com/api/x', { fetchImpl: fetch, retries: 0 }),
    (error) => error.code === 'redirect-blocked',
  )
  assert.equal(fetch.calls.length, 1, '外域地址一次都没请求')
  assert.equal(fetch.calls.some((call) => call.url.includes('evil.example.com')), false)
})

test('R6 相对跳转也会解析后复核（/api/x → 同域可跟）', async () => {
  const fetch = fakeFetch([
    {
      match: (url) => url.endsWith('/api/x'),
      reply: jsonResponse({}, { status: 302, headers: { location: '/api/y' } }),
    },
    { match: (url) => url.endsWith('/api/y'), reply: jsonResponse({ ok: true }) },
  ])
  const result = await requestJson('https://music.163.com/api/x', { fetchImpl: fetch, retries: 0 })
  assert.equal(result.ok, true)
  assert.equal(fetch.calls.length, 2)
  assert.match(fetch.calls[1].url, /^https:\/\/music\.163\.com\/api\/y$/)
})

test('R6 跳转次数过多：停止并报错，不再跟', async () => {
  const fetch = fakeFetch([
    { match: (url) => url.endsWith('/api/loop'), reply: jsonResponse({}, { status: 307, headers: { location: '/api/loop' } }) },
  ])
  await assert.rejects(
    () => requestJson('https://music.163.com/api/loop', { fetchImpl: fetch, retries: 0 }),
    (error) => error.code === 'redirect-blocked',
  )
  assert.ok(fetch.calls.length <= 3, `最多跟 2 跳，实际 ${fetch.calls.length} 次`)
})

test('R6 跳转没给 location：拒绝', async () => {
  const fetch = fakeFetch([{ match: 'music.163.com', reply: jsonResponse({}, { status: 301 }) }])
  await assert.rejects(
    () => requestJson('https://music.163.com/api/x', { fetchImpl: fetch, retries: 0 }),
    (error) => error.code === 'redirect-blocked',
  )
  assert.equal(fetch.calls.length, 1)
  assert.equal(OWNER_PRIVATE.chat.kind, 'private')
  assert.equal(GROUP.chat.kind, 'group')
})

// ---------------- R4 补充：真实数据里踩到的两个坑 ----------------

test('R4 歌名里只是「带关键词」的翻唱，不算完全同名，不能自动发', async () => {
  // 实测：关键词「晴天 周杰伦」会命中这条《晴天周杰伦(从前从前有个人爱你很久)》
  const body = {
    code: 200,
    result: { songs: [{ id: 2064191772, name: '晴天周杰伦(从前从前有个人爱你很久)', ar: [{ name: '沈幼楚' }], originCoverType: 2 }] },
  }
  const { harness } = setup({ body })
  const result = await harness.raw.share({ keyword: '晴天 周杰伦' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'needs-choice')
  assert.equal(harness.sends.length, 0)
})

test('R4 歌名完全一致但平台标了翻唱：也不自动发', async () => {
  const body = {
    code: 200,
    result: { songs: [{ id: 3391116218, name: '晴天', ar: [{ name: '梦里啥都有' }], originCoverType: 2 }] },
  }
  const { harness } = setup({ body })
  const result = await harness.raw.share({ keyword: '晴天' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'needs-choice')
  assert.equal(harness.sends.length, 0)
})

test('R4 只有歌手对上、歌名不对（搜晴天回了布拉格广场）仍算未命中', async () => {
  const body = {
    code: 200,
    result: {
      songs: [
        { id: 1412022124, name: '晴天', ar: [{ name: '空匪' }], originCoverType: 1 },
        { id: 210049, name: '布拉格广场', ar: [{ name: '蔡依林' }, { name: '周杰伦' }], originCoverType: 1 },
      ],
    },
  }
  const { harness } = setup({ body })
  const result = await harness.raw.search({ query: '晴天', artist: '周杰伦', version: 'any' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'artist-mismatch')
  assert.match(result.message, /没找到「周杰伦」/)
})
