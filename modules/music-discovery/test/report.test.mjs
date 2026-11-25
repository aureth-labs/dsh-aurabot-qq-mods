// 听歌报告：日/周/月单位、空版块跳过、不展示内部 ID、startTime 规则。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, fakeFetch, jsonResponse, OWNER_PRIVATE } from './helpers.mjs'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
const KEY = 'qmk-fixture-0000-not-a-real-key'

function reportFetch({ empty = false } = {}) {
  return fakeFetch([{
    match: (url) => url.endsWith('/me/report'),
    reply: (url, init) => {
      if (empty) return jsonResponse({ ret: 0 })
      const tk = JSON.parse(init.body).params.timeKey
      const file = { d: 'qq-report-day.json', w: 'qq-report-week.json', m: 'qq-report-month.json' }[tk]
      return jsonResponse(fixture(file))
    },
  }])
}

function setup({ empty = false } = {}) {
  const fetch = reportFetch({ empty })
  const harness = createHarness({ fetch, settings: { platform: 'qq', qqKey: KEY, reportEnabled: true } })
  harness.mount()
  return { harness, fetch }
}

test('日报：秒换算时分、活跃时段、Top 3，空条目跳过', async () => {
  const { harness, fetch } = setup()
  const result = await harness.raw.report({ period: 'day' })
  assert.equal(result.ok, true)
  assert.match(result.message, /今日听歌报告/)
  assert.match(result.message, /1 小时 5 分钟/)
  assert.match(result.message, /活跃时段：20 点/)
  assert.match(result.message, /周杰伦/)
  assert.match(result.message, /晴天/)
  assert.match(result.message, /5 次/)
  const params = JSON.parse(fetch.calls[0].init.body).params
  assert.deepEqual(params, { timeKey: 'd' })
  await harness.dispose()
})

test('周报：listenTime 是日均，不是周总量；floatNumber 转百分比', async () => {
  const { harness } = setup()
  const result = await harness.raw.report({ period: 'week' })
  assert.equal(result.ok, true)
  assert.match(result.message, /本周日均听歌时长：35 分钟/)
  assert.doesNotMatch(result.message, /本周听歌时长：35 分钟/)
  assert.match(result.message, /上升 12.5%/)
  assert.match(result.message, /12 次/)
  await harness.dispose()
})

test('月报：各版块按官方字段展示，空版块跳过，不出现内部 ID 字段名', async () => {
  const { harness } = setup()
  const result = await harness.raw.report({ period: 'month' })
  assert.equal(result.ok, true)
  assert.match(result.message, /本月听歌报告/)
  assert.match(result.message, /Top 艺人/)
  assert.match(result.message, /最爱时段：21 点/)
  assert.match(result.message, /连续听歌 5 天/)
  assert.match(result.message, /华语流行/)
  assert.match(result.message, /小众 30% \/ 热门 70%/)
  assert.match(result.message, /尝鲜歌曲：8 首（比上月 下降 20%）/)
  assert.match(result.message, /听歌城市：2 个（新乡、郑州）/)
  assert.match(result.message, /循环之最 晴天（12 次）/)
  assert.match(result.message, /深夜单曲 稻香（2 点）/)
  assert.match(result.message, /本月听歌次数：320 次/)
  assert.doesNotMatch(result.message, /songMid|singerMid|cityId|dissId|topId/)
  await harness.dispose()
})

test('空版块/空回包：如实说没有数据，不编报告', async () => {
  const { harness } = setup({ empty: true })
  const result = await harness.raw.report({ period: 'month' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'empty')
  assert.doesNotMatch(result.message, /Top 歌手|听歌时长/)
  await harness.dispose()
})

test('startTime：日报/周报按秒透传，月报忽略', async () => {
  const { harness, fetch } = setup()
  await harness.raw.report({ period: 'day', startTime: 1762963200 })
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body).params, { timeKey: 'd', startTime: 1762963200 })
  await harness.raw.report({ period: 'month', startTime: 1762963200 })
  assert.deepEqual(JSON.parse(fetch.calls[1].init.body).params, { timeKey: 'm' })
  await harness.dispose()
})

test('startTime 非法（小数/0/字符串）拒绝，0 请求', async () => {
  const { harness, fetch } = setup()
  for (const value of [1.5, 0, 'abc']) {
    const result = await harness.raw.report({ period: 'day', startTime: value })
    assert.equal(result.ok, false, String(value))
    assert.equal(result.code, 'bad-argument', String(value))
  }
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('报告只给主人私聊：群聊直接拒绝，0 请求', async () => {
  const { harness, fetch } = setup()
  const result = await harness.exports.report({
    period: 'day',
    chat: { chatId: 'group:2002', kind: 'group', groupId: '2002' },
    sessionId: 's-group',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'private-only')
  assert.equal(fetch.calls.length, 0)
  assert.equal(OWNER_PRIVATE.chat.kind, 'private')
  await harness.dispose()
})

test('日报只有听歌时长/活跃时段时也算有内容，不误判空报告', async () => {
  const fetch = fakeFetch([{
    match: (url) => url.endsWith('/me/report'),
    reply: () => jsonResponse({ ret: 0, dayData: { listenTime: 600, activeHour: 9 } }),
  }])
  const harness = createHarness({ fetch, settings: { platform: 'qq', qqKey: KEY, reportEnabled: true } })
  harness.mount()
  const result = await harness.raw.report({ period: 'day' })
  assert.equal(result.ok, true)
  assert.match(result.message, /10 分钟/)
  assert.match(result.message, /活跃时段：9 点/)
  await harness.dispose()
})
