// 分享：当前聊天缓存、跨聊天隔离、主人复核、卡片/链接兜底、不明回执不重发。
// mock 发送只捕获，不会真发 QQ。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, fakeFetch, jsonResponse, OWNER_PRIVATE, GROUP, OTHER_PRIVATE } from './helpers.mjs'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
const SEARCH = fixture('netease-search.json')

function setup(settings = {}, { owner = true } = {}) {
  const fetch = fakeFetch([{ match: 'api/cloudsearch/pc', reply: jsonResponse(SEARCH) }])
  const harness = createHarness({ fetch, settings, owner })
  harness.mount()
  return { harness, fetch }
}

test('分享第 3 首：用本聊天缓存，发到当前聊天，正文带真实链接', async () => {
  const { harness } = setup()
  await harness.call('music_search', { query: '晴天', limit: 5 })
  const result = await harness.raw.share({ index: 3 })
  assert.equal(result.ok, true)
  assert.equal(result.form, 'link')
  assert.equal(harness.sends.length, 1)
  assert.equal(harness.sends[0].chatId, OWNER_PRIVATE.chat.chatId)
  assert.equal(harness.sends[0].kind, 'text')
  assert.match(harness.sends[0].text, /https:\/\/music\.163\.com\/song\?id=/)
  assert.match(harness.sends[0].text, /♪/)
})

test('分享：缓存不串聊天——A 聊天搜的，B 聊天分享要重新核验或明确说没有', async () => {
  const { harness } = setup()
  await harness.call('music_search', { query: '晴天' })
  const result = await harness.call('music_share', { index: 1 }, OTHER_PRIVATE)
  assert.equal(result.ok, false)
  assert.match(result.message, /还没有刚搜过的歌|只对主人开放/)
  // 即使 ownerOnly 关掉，也不能拿到另一个聊天的候选
  harness.state.settings.ownerOnly = false
  const again = await harness.call('music_share', { index: 1 }, OTHER_PRIVATE)
  assert.equal(again.ok, false)
  assert.match(again.message, /还没有刚搜过的歌/)
  assert.equal(harness.sends.length, 0)
})

test('分享：关键词核验时不会替你挑第 1 条（列出候选等用户选）', async () => {
  const { harness, fetch } = setup({ ownerOnly: false })
  await harness.call('music_search', { query: '晴天', limit: 1 })
  const before = fetch.calls.length
  const result = await harness.raw.share({ keyword: '晴天 周杰伦', chat: GROUP.chat, sessionId: GROUP.sessionId })
  // 「晴天 周杰伦」不是任何一条的歌名，属歧义/未完全一致 → 必须停下来让用户选
  assert.equal(result.ok, false)
  assert.equal(result.code, 'needs-choice')
  assert.match(result.message, /说第几首/)
  assert.equal(fetch.calls.length, before + 1, '应该重新查一次平台')
  assert.equal(harness.sends.length, 0)

  // 用户明确点序号后才发
  const picked = await harness.call('music_share', { index: 1 }, GROUP)
  assert.equal(picked.ok, true)
  assert.equal(harness.sends.length, 1)
})

test('分享：非主人 / 混合群轮被拦住，且不发送', async () => {
  const { harness } = setup()
  await harness.call('music_search', { query: '晴天' })
  harness.state.owner = false
  const result = await harness.call('music_share', { index: 1 }, GROUP)
  assert.equal(result.ok, false)
  assert.match(result.message, /只对主人开放/)
  assert.equal(harness.sends.length, 0)
})

test('分享：执行时和发送前各复核一次主人身份', async () => {
  const { harness } = setup()
  await harness.call('music_search', { query: '晴天' })
  harness.state.ownerChecks = 0
  const result = await harness.call('music_share', { index: 1 })
  assert.equal(result.ok, true)
  assert.ok(harness.state.ownerChecks >= 2, `主人复核次数应≥2，实际 ${harness.state.ownerChecks}`)
  assert.equal(harness.sends.length, 1)
})

test('分享：网易云卡片走原生 music/163 段', async () => {
  const { harness } = setup({ shareForm: 'card' })
  await harness.call('music_search', { query: '晴天' })
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.form, 'card')
  assert.equal(harness.sends[0].kind, 'segments')
  assert.deepEqual(harness.sends[0].segments[0], { type: 'music', data: { type: '163', id: '186016' } })
})

test('分享：QQ 只有 songMid 时不猜数字 ID，明确退成链接', async () => {
  const qqFetch = fakeFetch([{ match: 'a.y.qq.com/discover/search', reply: jsonResponse(fixture('qq-search.json')) }])
  const harness = createHarness({ fetch: qqFetch, settings: { qqKey: 'qmk-fixture-0000-not-a-real-key', platform: 'qq', shareForm: 'card' } })
  harness.mount()
  await harness.call('music_search', { query: '晴天', platform: 'qq' })
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.form, 'link')
  assert.match(result.message, /只有 songMid/)
  assert.equal(harness.sends[0].kind, 'text')
  assert.match(harness.sends[0].text, /https:\/\/y\.qq\.com\/n\/ryqq\/songDetail\//)
})

test('分享：卡片明确失败时退成链接（只补发一次）', async () => {
  const { harness } = setup({ shareForm: 'card' })
  await harness.call('music_search', { query: '晴天' })
  harness.api.sendSegments = async () => {
    throw new Error('unsupported segment')
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.form, 'link')
  assert.equal(harness.sends.length, 1)
  assert.equal(harness.sends[0].kind, 'text')
  assert.match(result.message, /卡片平台不支持|卡片没发出去/)
  assert.match(result.message, /改用链接/)
})

test('分享：回执不明（超时）不重发，第二次也拒绝', async () => {
  const { harness } = setup({ shareForm: 'card' })
  await harness.call('music_search', { query: '晴天' })
  harness.api.sendSegments = async () => {
    throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
  }
  const first = await harness.raw.share({ index: 1 })
  assert.equal(first.ok, false)
  assert.equal(first.code, 'send-unknown')
  assert.match(first.message, /别重发|先别重发/)
  assert.equal(harness.sends.length, 0)

  const second = await harness.raw.share({ index: 1 })
  assert.equal(second.ok, false)
  assert.match(second.message, /结果不明|别重发/)
  assert.equal(harness.sends.length, 0)
})

test('分享：链接也失败时如实报错，不假装成功', async () => {
  const { harness } = setup()
  await harness.call('music_search', { query: '晴天' })
  harness.api.sendText = async () => {
    throw new Error('bot offline')
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  // 非白名单异常一律按「不明」处理：既不说已发，也不补发
  assert.match(result.message, /没拿到确认回执|没发出去/)
  assert.equal(harness.sends.length, 0)
})

test('分享：序号越界 / 没搜过都有明确提示', async () => {
  const { harness } = setup()
  const empty = await harness.call('music_share', { index: 1 })
  assert.equal(empty.ok, false)
  assert.match(empty.message, /还没有刚搜过的歌/)

  await harness.call('music_search', { query: '晴天', limit: 2 })
  const outOfRange = await harness.call('music_share', { index: 9 })
  assert.equal(outOfRange.ok, false)
  assert.match(outOfRange.message, /第 9 首|没有第 9/)
  assert.equal(harness.sends.length, 0)
})

test('分享：TTL 过期后不再拿旧候选（时间用假时钟推进）', async () => {
  let clock = 1_000_000
  const fetch = fakeFetch([{ match: 'api/cloudsearch/pc', reply: jsonResponse(SEARCH) }])
  const harness = createHarness({ fetch, now: () => clock })
  harness.mount()
  await harness.call('music_search', { query: '晴天' })
  clock += 11 * 60 * 1000
  const result = await harness.call('music_share', { index: 1 })
  assert.equal(result.ok, false)
  assert.match(result.message, /还没有刚搜过的歌/)
})
