// 荐歌：场景 → 平台真实歌单/榜单；场景不命中或接口失败时如实说明，不编「平台推荐」。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, fakeFetch, jsonResponse, OWNER_PRIVATE, GROUP } from './helpers.mjs'
import { resolveScene } from '../lib/scenes.mjs'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
const PLAYLISTS = fixture('netease-playlists.json')
const DETAIL = fixture('netease-detail.json')

function idOf(init) {
  return new URLSearchParams(String(init?.body || '')).get('id') || ''
}

function neteaseFetch({ failDetail = false, failList = false } = {}) {
  return fakeFetch([
    {
      match: (url) => url.includes('api/playlist/list'),
      reply: () => {
        if (failList) return jsonResponse({ code: 500 }, { status: 500 })
        return jsonResponse(PLAYLISTS)
      },
    },
    {
      match: (url, init) => url.includes('api/v6/playlist/detail'),
      reply: (url, init) => {
        if (failDetail) return jsonResponse({ result: {} })
        const id = idOf(init)
        if (id === '111') return jsonResponse({ result: DETAIL.playlist })
        if (id === '222') return jsonResponse({ result: DETAIL.playlist222 })
        if (id === '3778678') return jsonResponse({ result: DETAIL.chart })
        return jsonResponse({ result: {} })
      },
    },
  ])
}

test('场景解析：场景/曲风命中分类，榜单单独走榜单', () => {
  assert.equal(resolveScene('学习的时候听').ok, true)
  assert.equal(resolveScene('学习的时候听').cat, '学习')
  assert.equal(resolveScene('跑步').cat, '运动')
  assert.equal(resolveScene('想听点古风').cat, '古风')
  assert.equal(resolveScene('热歌').kind, 'chart')
  assert.equal(resolveScene('热歌').chartId, '3778678')
  assert.equal(resolveScene('').chartName, '热歌榜')
  assert.equal(resolveScene('量子力学').ok, false)
})

test('荐歌：从真实歌单取候选，带歌单来源，默认 3 条', async () => {
  const fetch = neteaseFetch()
  const harness = createHarness({ fetch })
  harness.mount()
  const result = await harness.raw.recommend({ scene: '学习' })
  assert.equal(result.ok, true)
  assert.equal(result.candidates.length, 3)
  const sources = result.candidates.map((item) => item.source.name)
  assert.ok(sources.includes('自习室的安静钢琴'))
  assert.ok(sources.includes('写代码不被打断'))
  assert.match(result.message, /来源：/)
  assert.match(result.message, /自习室的安静钢琴/)
  // 只取每个歌单前两首，不把「第三首不该被取到」带出来
  assert.equal(result.candidates.some((item) => item.title.includes('第三首')), false)
})

test('荐歌：榜单场景直接从榜单取，不查分类歌单', async () => {
  const fetch = neteaseFetch()
  const harness = createHarness({ fetch })
  harness.mount()
  const result = await harness.raw.recommend({ scene: '热歌' })
  assert.equal(result.ok, true)
  assert.equal(result.candidates[0].source.kind, 'chart')
  assert.equal(result.candidates[0].source.name, '热歌榜')
  assert.equal(fetch.calls.some((call) => call.url.includes('api/playlist/list')), false)
})

test('荐歌：场景不认识时给可用场景，不返回任何曲目', async () => {
  const fetch = neteaseFetch()
  const harness = createHarness({ fetch })
  harness.mount()
  const result = await harness.call('music_recommend', { scene: '量子力学' })
  assert.equal(result.ok, false)
  assert.match(result.message, /没有.*对应的歌单分类/)
  assert.match(result.message, /学习/)
  assert.equal(fetch.calls.length, 0)
})

test('荐歌：分类下没歌单时如实说没拿到，不编「平台推荐」', async () => {
  const fetch = neteaseFetch({ failList: true })
  const harness = createHarness({ fetch })
  harness.mount()
  const result = await harness.call('music_recommend', { scene: '学习' })
  assert.equal(result.ok, false)
  assert.match(result.message, /没拿到|平台出错/)
  assert.doesNotMatch(result.message, /https:\/\/music\.163\.com\/song/)
})

test('荐歌：歌单详情空回包时不当成成功', async () => {
  const fetch = neteaseFetch({ failDetail: true })
  const harness = createHarness({ fetch })
  harness.mount()
  const result = await harness.call('music_recommend', { scene: '学习' })
  assert.equal(result.ok, false)
  assert.match(result.message, /没拿到这个场景的真实歌单|没拿到/)
})

test('荐歌：非主人（ownerOnly 默认开）被拦住，不发请求', async () => {
  const fetch = neteaseFetch()
  const harness = createHarness({ fetch })
  harness.mount()
  harness.state.owner = false
  const result = await harness.call('music_recommend', { scene: '学习' }, GROUP)
  assert.equal(result.ok, false)
  assert.match(result.message, /只对主人开放/)
  assert.equal(fetch.calls.length, 0)
})

test('荐歌：显式要 QQ 但没 Key → 未配置，不退化成别的平台还说是 QQ', async () => {
  const fetch = neteaseFetch()
  const harness = createHarness({ fetch })
  harness.mount()
  const result = await harness.call('music_recommend', { scene: '学习', platform: 'qq' })
  assert.equal(result.ok, false)
  assert.match(result.message, /还没配置 API Key/)
  assert.equal(fetch.calls.length, 0)
})

test('荐歌：首选 QQ 且没有 Key 时改用网易云，并说明原因', async () => {
  const fetch = neteaseFetch()
  const harness = createHarness({ fetch, settings: { platform: 'qq' } })
  harness.mount()
  const result = await harness.raw.recommend({ scene: '学习' })
  assert.equal(result.ok, true)
  assert.equal(result.platform, 'netease')
  assert.match(result.message, /没配置 QQ 音乐 Key/)
})

test('荐歌：QQ 每日推荐只在主人私聊用，群里会说明并改用网易云', async () => {
  const fetch = neteaseFetch()
  const harness = createHarness({ fetch, settings: { platform: 'qq', qqKey: 'qmk-fixture-0000-not-a-real-key' } })
  harness.mount()
  const result = await harness.raw.recommend({ scene: '学习', chat: GROUP.chat, sessionId: GROUP.sessionId })
  assert.equal(result.platform, 'netease')
  assert.match(result.message, /只在你和主人的私聊里用/)
  assert.equal(fetch.calls.some((call) => call.url.includes('a.y.qq.com')), false)
  assert.equal(OWNER_PRIVATE.chat.kind, 'private')
})
