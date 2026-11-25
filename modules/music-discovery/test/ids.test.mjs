// ID / URL 边界：非法 id 不拼链接、外部域名不拼链接、没有链接也能分享（只是不带链接）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createNetease } from '../lib/netease.mjs'
import { MusicError } from '../lib/http.mjs'
import {
  makeCandidate,
  neteasePlaylistUrl,
  neteaseSongUrl,
  qqSongUrl,
  safeShareUrl,
} from '../lib/normalize.mjs'
import { candidateLine, cardSegment } from '../lib/format.mjs'
import { createHarness, fakeFetch, jsonResponse } from './helpers.mjs'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))

test('有效 ID 才拼链接；不合法就当没有，不猜', () => {
  assert.equal(neteaseSongUrl(186016), 'https://music.163.com/song?id=186016')
  assert.equal(neteaseSongUrl('186016'), 'https://music.163.com/song?id=186016')
  assert.equal(neteaseSongUrl('abc'), '')
  assert.equal(neteaseSongUrl('12/34'), '')
  assert.equal(neteaseSongUrl(''), '')
  assert.equal(neteasePlaylistUrl(3778678), 'https://music.163.com/playlist?id=3778678')

  assert.equal(qqSongUrl('0039MnYb0qxYhV'), 'https://i2.y.qq.com/a/song/0039MnYb0qxYhV')
  assert.equal(qqSongUrl('short'), '')
  assert.equal(qqSongUrl('has space here'), '')
  assert.equal(qqSongUrl(''), '')
})

test('外部域名的链接一律不接受', () => {
  assert.equal(safeShareUrl('https://music.163.com/song?id=1'), 'https://music.163.com/song?id=1')
  assert.equal(safeShareUrl('https://evil.example.com/song?id=1'), '')
  assert.equal(safeShareUrl('http://music.163.com/song?id=1'), '')
  assert.equal(safeShareUrl('javascript:alert(1)'), '')
  assert.equal(safeShareUrl(''), '')
})

test('候选：外部链接被丢掉后按平台规则重建，重建不了就空着', () => {
  const good = makeCandidate({
    platform: 'netease',
    id: 186016,
    title: '晴天',
    artists: ['周杰伦'],
    shareUrl: 'https://evil.example.com/x',
  })
  assert.equal(good.shareUrl, 'https://music.163.com/song?id=186016')

  const bad = makeCandidate({ platform: 'netease', id: 'not-an-id', title: '?', artists: [], shareUrl: 'https://evil.example.com/x' })
  assert.equal(bad.shareUrl, '')
  assert.match(candidateLine(1, bad), /平台没给网页链接/)
  assert.equal(cardSegment(bad), null)
})

test('歌单详情：非法 id 直接拒绝，不发请求', async () => {
  const fetch = fakeFetch([])
  const netease = createNetease({ fetchImpl: fetch })
  await assert.rejects(
    () => netease.playlistTracks({ id: 'abc; drop table' }),
    (error) => error instanceof MusicError && error.code === 'bad-url',
  )
  assert.equal(fetch.calls.length, 0)
})

// 【纠正原错误断言】这条测试以前写的是「没有链接的候选也能分享，只是正文不含 URL」，
// 并且断言 ok=true、host 收到 1 条。那等于把「只发了歌名、没有链接」当成分享成功，
// 正是验收 R5 指出的问题。现在改为：不可分享条目必须 ok=false 且 0 发送，
// 保留同一个用例（同一 fixture、同样步骤），只把错误的成功预期换成正确的失败预期。
test('没有可用链接/卡片的候选不得分享：ok=false 且 0 发送', async () => {
  const broken = {
    code: 200,
    result: {
      songs: [{ id: 'x', name: '奇怪条目', ar: [{ name: '某人' }], al: { name: '某' }, dt: 100000, originCoverType: 1 }],
    },
  }
  const fetch = fakeFetch([{ match: 'api/cloudsearch/pc', reply: jsonResponse(broken) }])
  const harness = createHarness({ fetch })
  harness.mount()
  const search = await harness.raw.search({ query: '奇怪条目' })
  assert.equal(search.ok, true, '搜索本身仍然成功，只是这条不能分享')
  assert.match(search.message, /不能分享/)

  const shared = await harness.raw.share({ index: 1 })
  assert.equal(shared.ok, false)
  assert.equal(shared.code, 'not-shareable')
  assert.equal(harness.sends.length, 0, '不可分享条目必须 0 发送')
})

test('非法 id（非数字）同样不能分享，0 发送', async () => {
  const broken = { code: 200, result: { songs: [{ id: 'invalid-id', name: '坏条目', ar: [{ name: '某人' }] }] } }
  const fetch = fakeFetch([{ match: 'api/cloudsearch/pc', reply: jsonResponse(broken) }])
  const harness = createHarness({ fetch })
  harness.mount()
  const search = await harness.raw.search({ query: '坏条目' })
  assert.equal(search.ok, true)
  assert.equal(search.candidates[0].shareUrl, '')

  const shared = await harness.raw.share({ index: 1 })
  assert.equal(shared.ok, false)
  assert.equal(shared.code, 'not-shareable')
  assert.equal(harness.sends.length, 0)
})

test('卸载不会碰插件配置（mock 里 api.config 一被调用就抛错）', async () => {
  const fetch = fakeFetch([{ match: 'api/cloudsearch/pc', reply: jsonResponse(fixture('netease-search.json')) }])
  const harness = createHarness({ fetch })
  harness.mount()
  await harness.call('music_search', { query: '晴天' })
  await harness.dispose()
  assert.equal(harness.state.logs.some((entry) => /配置/.test(entry.text)), false)
})
