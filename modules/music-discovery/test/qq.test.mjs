// QQ 音乐 provider：缺 Key 分支、固定 fixture 解析、403/限流/坏回包、凭据不外泄。
// 这里的「解析通过」不代表真实鉴权通过——真实 Key 还没拿到，回执里也这么写。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, fakeFetch, jsonResponse, OWNER_PRIVATE } from './helpers.mjs'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
const QQ_SEARCH = fixture('qq-search.json')
const FAKE_KEY = 'qmk-fixture-0000-not-a-real-key'

function harnessWith(fetch, settings = {}) {
  const harness = createHarness({ fetch, settings })
  harness.mount()
  return harness
}

test('缺 Key：明确返回未配置，不发请求，也不声称成功', async () => {
  const fetch = fakeFetch([{ match: 'a.y.qq.com', reply: jsonResponse(QQ_SEARCH) }])
  const harness = harnessWith(fetch)
  const result = await harness.call('music_search', { query: '晴天', platform: 'qq' })
  assert.equal(result.ok, false)
  assert.match(result.message, /还没配置 API Key|还没配置 API Key/)
  assert.equal(fetch.calls.length, 0)
})

test('缺 Key：首选平台是 QQ 时改用网易云，并明确说明不是 QQ 的结果', async () => {
  const fetch = fakeFetch([
    { match: 'api/cloudsearch/pc', reply: jsonResponse(fixture('netease-search.json')) },
  ])
  const harness = harnessWith(fetch, { platform: 'qq' })
  const result = await harness.raw.search({ query: '晴天' })
  assert.equal(result.ok, true)
  assert.equal(result.platform, 'netease')
  assert.match(result.message, /没配置 QQ 音乐 Key，这次走的是网易云/)
  assert.match(result.message, /^网易云/)
  assert.equal(fetch.calls.some((call) => call.url.includes('a.y.qq.com')), false)
})

test('有 Key：按官方协议发请求（params + comm.skill_version + Bearer），并解析固定 fixture', async () => {
  const fetch = fakeFetch([{ match: 'a.y.qq.com/discover/search', reply: jsonResponse(QQ_SEARCH) }])
  const harness = harnessWith(fetch, { qqKey: FAKE_KEY, platform: 'qq' })
  const result = await harness.raw.search({ query: '晴天', platform: 'qq' })

  assert.equal(result.ok, true)
  assert.equal(fetch.calls.length, 1)
  const [call] = fetch.calls
  assert.match(call.url, /^https:\/\/a\.y\.qq\.com\/discover\/search$/)
  assert.equal(call.init.method, 'POST')
  assert.match(call.init.headers.Authorization, /^Bearer\s+\S+$/)
  const body = JSON.parse(call.init.body)
  assert.equal(body.params.keyword, '晴天')
  assert.equal(body.params.type, '0')
  assert.equal(body.comm.skill_version, '0.0.3')
  // Key 只在请求头里，不进查询串
  assert.equal(call.url.includes(encodeURIComponent(FAKE_KEY)), false)

  const first = result.candidates[0]
  assert.equal(first.platform, 'qq')
  assert.equal(first.mid, '0039MnYb0qxYhV')
  assert.equal(first.title, '晴天')
  assert.deepEqual(first.artists, ['周杰伦'])
  assert.equal(first.shareUrl, 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV')
})

test('有 Key：回包没给 H5 链接时按官方规则用已核验 songMid 拼；歌手名拆分', async () => {
  const fetch = fakeFetch([{ match: 'a.y.qq.com/discover/search', reply: jsonResponse(QQ_SEARCH) }])
  const harness = harnessWith(fetch, { qqKey: FAKE_KEY, platform: 'qq' })
  const result = await harness.raw.search({ query: '晴天', platform: 'qq', limit: 5 })
  const second = result.candidates.find((item) => item.mid === '004Z8Ihr0JIu5s')
  assert.ok(second)
  assert.equal(second.shareUrl, 'https://i2.y.qq.com/a/song/004Z8Ihr0JIu5s')
  assert.deepEqual(second.artists, ['周杰伦', '袁咏琳'])
})

test('有 Key：QQ 回包没有版本信息时标「版本未标注」，不冒充原唱', async () => {
  const fetch = fakeFetch([{ match: 'a.y.qq.com/discover/search', reply: jsonResponse(QQ_SEARCH) }])
  const harness = harnessWith(fetch, { qqKey: FAKE_KEY, platform: 'qq' })
  const result = await harness.raw.search({ query: '晴天', platform: 'qq' })
  assert.equal(result.candidates[0].version, 'unknown')
  assert.match(result.message, /版本未标注/)
})

test('403：Key 失效分支给出可执行提示，且消息/日志都不回显 Key', async () => {
  const fetch = fakeFetch([{ match: 'a.y.qq.com', reply: jsonResponse({ msg: 'forbidden' }, { status: 403 }) }])
  const harness = harnessWith(fetch, { qqKey: FAKE_KEY, platform: 'qq' })
  const result = await harness.call('music_search', { query: '晴天', platform: 'qq' })
  assert.equal(result.ok, false)
  assert.match(result.message, /被平台拒绝/)
  assert.equal(result.message.includes(FAKE_KEY), false)
  assert.equal(harness.state.logs.some((entry) => entry.text.includes(FAKE_KEY)), false)
})

test('网关错误码：ret/sub_ret 非 0 时报错而不是当成功', async () => {
  const fetch = fakeFetch([{ match: 'a.y.qq.com', reply: jsonResponse({ ret: 1001, msg: 'bad request' }) }])
  const harness = harnessWith(fetch, { qqKey: FAKE_KEY, platform: 'qq' })
  const result = await harness.call('music_search', { query: '晴天', platform: 'qq' })
  assert.equal(result.ok, false)
  assert.match(result.message, /网关错误|ret=1001/)
})

test('坏回包：JSON 解析失败不把响应原文回显到消息或日志', async () => {
  const fetch = fakeFetch([{ match: 'a.y.qq.com', reply: jsonResponse('<html>风控</html>') }])
  const harness = harnessWith(fetch, { qqKey: FAKE_KEY, platform: 'qq' })
  const result = await harness.call('music_search', { query: '晴天', platform: 'qq' })
  assert.equal(result.ok, false)
  assert.match(result.message, /看不懂/)
  assert.equal(result.message.includes('<html>'), false)
  assert.equal(harness.state.logs.some((entry) => entry.text.includes('<html>')), false)
})

test('429 限流：重试一次后仍失败就如实说限流', async () => {
  const fetch = fakeFetch([{ match: 'a.y.qq.com', reply: jsonResponse({}, { status: 429, headers: { 'retry-after': '0' } }) }])
  const harness = harnessWith(fetch, { qqKey: FAKE_KEY, platform: 'qq' })
  const result = await harness.call('music_search', { query: '晴天', platform: 'qq' })
  assert.equal(result.ok, false)
  assert.match(result.message, /限流/)
  assert.equal(fetch.calls.length, 2, '只重试一次')
  assert.equal(OWNER_PRIVATE.sessionId, 's-owner')
})
