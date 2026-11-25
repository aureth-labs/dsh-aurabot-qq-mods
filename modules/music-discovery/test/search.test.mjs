// 搜索与版本识别：原唱/翻唱混合、同名不同歌手、空结果、条数上限。
// 全部走 mock 网易云回包，不打真网络。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, fakeFetch, jsonResponse, OWNER_PRIVATE, GROUP } from './helpers.mjs'
import { classifyVersion, rankCandidates, bareTitle } from '../lib/normalize.mjs'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
const SEARCH = fixture('netease-search.json')

function harnessWith(body = SEARCH) {
  const fetch = fakeFetch([{ match: 'api/cloudsearch/pc', reply: jsonResponse(body) }])
  const harness = createHarness({ fetch })
  harness.mount()
  return { harness, fetch }
}

test('版本判定：歌名标注优先，其次平台标记，没信息就不冒充原唱', () => {
  assert.equal(classifyVersion({ title: '晴天', artists: ['周杰伦'], coverType: 1 }).code, 'original')
  assert.equal(classifyVersion({ title: '晴天 (原唱 周杰伦)', artists: ['RyaVocal'], coverType: 2 }).code, 'cover')
  assert.equal(classifyVersion({ title: '晴天 (Live)', artists: ['周杰伦'], coverType: 1 }).code, 'live')
  assert.equal(classifyVersion({ title: '晴天 (女声版)', artists: ['GYBeat'] }).code, 'derivative')
  assert.equal(classifyVersion({ title: '晴天 (伴奏)', artists: ['周杰伦'] }).code, 'instrumental')
  assert.equal(classifyVersion({ title: '晴天', artists: ['某人'], coverType: 0 }).code, 'unknown')
  // 「原唱: 别人」但演唱者不是那个人 → 翻唱
  assert.equal(classifyVersion({ title: '晴天 (原唱: 周杰伦)', artists: ['翻唱歌手'] }).code, 'cover')
  assert.equal(bareTitle('晴天 (Live)'), '晴天')
})

test('搜索：默认 3 条，候选字段齐全（platform/id/title/artists/version/shareUrl/source）', async () => {
  const { harness } = harnessWith()
  const result = await harness.raw.search({ query: '晴天' })
  assert.equal(result.ok, true)
  assert.equal(result.message.split('\n')[0].includes('3 条'), true)

  const first = result.candidates[0]
  assert.equal(first.platform, 'netease')
  assert.equal(first.id, '186016')
  assert.equal(first.title, '晴天')
  assert.deepEqual(first.artists, ['周杰伦'])
  assert.equal(first.version, 'original')
  assert.equal(first.shareUrl, 'https://music.163.com/song?id=186016')
  assert.equal(first.source.kind, 'search')
  assert.match(result.message, /https:\/\/music\.163\.com\/song\?id=186016/)
})

test('搜索：limit 上限 5，越小越少', async () => {
  const { harness } = harnessWith()
  const five = await harness.raw.search({ query: '晴天', limit: 5 })
  assert.equal(five.candidates.length, 5)
  const one = await harness.raw.search({ query: '晴天', limit: 1 })
  assert.equal(one.candidates.length, 1)
  const huge = await harness.raw.search({ query: '晴天', limit: 99 })
  assert.equal(huge.candidates.length, 5)

  // 面板默认条数也吃上限约束
  harness.state.settings.limit = 2
  const bySetting = await harness.raw.search({ query: '晴天' })
  assert.equal(bySetting.candidates.length, 2)
})

test('搜索：指定原唱时筛掉翻唱/现场，并说明筛掉了什么', async () => {
  const { harness } = harnessWith()
  const result = await harness.raw.search({ query: '晴天', version: 'original', limit: 5 })
  assert.equal(result.ok, true)
  const versions = result.candidates.map((item) => item.version)
  assert.equal(versions.every((version) => version === 'original'), true)
  assert.match(result.message, /已按「原唱」筛掉/)
  assert.match(result.message, /翻唱/)
})

test('搜索：指定现场时只留现场版本', async () => {
  const { harness } = harnessWith()
  const result = await harness.raw.search({ query: '晴天', version: 'live' })
  assert.equal(result.ok, true)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].id, '1397000001')
  assert.equal(result.candidates[0].version, 'live')
})

test('搜索：平台只有翻唱时，说没找到原唱而不是拿翻唱充数', async () => {
  const onlyCovers = {
    code: 200,
    result: {
      songCount: 2,
      songs: [
        { id: 9001, name: '晴天 (原唱 周杰伦)', ar: [{ name: '翻唱歌手A' }], al: { name: '翻唱合辑' }, dt: 200000, originCoverType: 2 },
        { id: 9002, name: '晴天 (女声版)', ar: [{ name: '翻唱歌手B' }], al: { name: '翻唱合辑' }, dt: 200000, originCoverType: 2 },
      ],
    },
  }
  const { harness } = harnessWith(onlyCovers)
  const result = await harness.call('music_search', { query: '晴天', version: 'original' })
  assert.equal(result.ok, false)
  assert.match(result.message, /没找到「原唱」的版本/)
  assert.match(result.message, /翻唱 1/)
  assert.match(result.message, /改编版 1/)
})

test('搜索：同名不同歌手都保留，并各自标清歌手', async () => {
  const { harness } = harnessWith()
  const result = await harness.raw.search({ query: '晴天', limit: 5 })
  const byChen = result.candidates.find((item) => item.id === '1397000002')
  assert.ok(byChen, '同名不同歌手的候选应该保留')
  assert.deepEqual(byChen.artists, ['陈默'])
  assert.match(result.message, /陈默/)
})

test('搜索：用歌手名消歧', async () => {
  const { harness } = harnessWith()
  const result = await harness.raw.search({ query: '晴天', artist: '周杰伦' })
  assert.equal(result.candidates[0].id, '186016')
  assert.equal(result.candidates[0].artists[0], '周杰伦')
})

test('搜索：空结果如实说没搜到', async () => {
  const { harness } = harnessWith({ code: 200, result: { songCount: 0, songs: [] } })
  const result = await harness.call('music_search', { query: '不存在的歌名xyz' })
  assert.equal(result.ok, false)
  assert.match(result.message, /没搜到/)
  assert.doesNotMatch(result.message, /https:\/\//)
})

test('搜索：空关键词不请求平台', async () => {
  const { harness, fetch } = harnessWith()
  const result = await harness.call('music_search', { query: '   ' })
  assert.equal(result.ok, false)
  assert.equal(fetch.calls.length, 0)
})

test('搜索：群聊里（非主人）默认被 ownerOnly 拦住，不发请求', async () => {
  const { harness, fetch } = harnessWith()
  harness.state.owner = false
  const result = await harness.call('music_search', { query: '晴天' }, GROUP)
  assert.equal(result.ok, false)
  assert.match(result.message, /只对主人开放/)
  assert.equal(fetch.calls.length, 0)
})

test('搜索：关掉 ownerOnly 后群里别人也能搜', async () => {
  const { harness } = harnessWith()
  harness.state.settings.ownerOnly = false
  harness.state.owner = false
  const result = await harness.call('music_search', { query: '晴天' }, GROUP)
  assert.equal(result.ok, true)
})

test('rankCandidates：按歌名精确度排序，不把同名翻唱排到原唱前面', () => {
  const list = [
    { platform: 'netease', id: '2', title: '晴天 (原唱 周杰伦)', artists: ['RyaVocal'], version: 'cover', shareUrl: 'https://music.163.com/song?id=2' },
    { platform: 'netease', id: '1', title: '晴天', artists: ['周杰伦'], version: 'original', shareUrl: 'https://music.163.com/song?id=1' },
  ]
  const { items } = rankCandidates(list, { query: '晴天', artist: '周杰伦' })
  assert.equal(items[0].id, '1')
  assert.equal(OWNER_PRIVATE.chat.kind, 'private')
})
