// MUSIC-20261112-01 第 2 次退回（B1–B4）回归测试。
// 每条对应复验报告里的复现点；只用假回执/假凭据，不真发、不联网、不用真实 Key。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, fakeFetch, jsonResponse } from './helpers.mjs'
import { requestJson } from '../lib/http.mjs'
import { classifySendError, classifySendResult } from '../lib/send.mjs'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
const SEARCH = fixture('netease-search.json')

function setup({ settings = {}, body = SEARCH } = {}) {
  const fetch = fakeFetch([{ match: 'api/cloudsearch/pc', reply: jsonResponse(body) }])
  const harness = createHarness({ fetch, settings })
  harness.mount()
  return { harness, fetch }
}

// ---------------- B1：泛称「无法发送」不是卡片不支持 ----------------

test('B1 中文「无法发送：连接已断开，投递结果不明」不得补发链接', async () => {
  const { harness } = setup({ settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '晴天' })
  let attempts = 0
  harness.api.sendSegments = async () => {
    attempts += 1
    throw new Error('无法发送：连接已断开，投递结果不明')
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'send-unknown')
  assert.equal(attempts, 1, '只尝试过卡片这一次')
  assert.equal(harness.sends.length, 0, '一条都不能补发')
})

test('B1 泛称「无法发送」单独出现也不算卡片不支持', async () => {
  const { harness } = setup({ settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '晴天' })
  harness.api.sendSegments = async () => {
    throw new Error('无法发送')
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'send-unknown')
  assert.equal(harness.sends.length, 0)
})

test('B1 中文超时/断线不得补发', async () => {
  for (const text of ['发送超时，请稍后重试', '连接已断开', '投递结果不明']) {
    const { harness } = setup({ settings: { shareForm: 'card' } })
    await harness.raw.search({ query: '晴天' })
    harness.api.sendSegments = async () => {
      throw new Error(text)
    }
    const result = await harness.raw.share({ index: 1 })
    assert.equal(result.ok, false, text)
    assert.equal(result.code, 'send-unknown', text)
    assert.equal(harness.sends.length, 0, `${text} 不许补发`)
    await harness.dispose()
  }
})

test('B1 英文 timeout / socket hang up / delivery unknown 不得补发', async () => {
  for (const text of ['cannot send: request timeout', 'socket hang up', 'delivery outcome unknown']) {
    const { harness } = setup({ settings: { shareForm: 'card' } })
    await harness.raw.search({ query: '晴天' })
    harness.api.sendSegments = async () => {
      throw new Error(text)
    }
    const result = await harness.raw.share({ index: 1 })
    assert.equal(result.ok, false, text)
    assert.equal(harness.sends.length, 0, `${text} 不许补发`)
    await harness.dispose()
  }
})

test('B1 「不支持」和「超时」同时出现：按不明处理，不补发', async () => {
  const { harness } = setup({ settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '晴天' })
  harness.api.sendSegments = async () => {
    throw new Error('unsupported segment (send timeout, outcome unknown)')
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'send-unknown')
  assert.equal(harness.sends.length, 0)
})

test('B1 明确「不支持消息段」仍然正常退链接（正例）', async () => {
  const { harness } = setup({ settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '晴天' })
  harness.api.sendSegments = async () => {
    throw new Error('不支持这个消息段')
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.form, 'link')
  assert.equal(harness.sends.length, 1)
  assert.equal(harness.sends[0].kind, 'text')
})

test('B1 英文 unsupported message segment 仍是可兜底的正例', async () => {
  const { harness } = setup({ settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '晴天' })
  harness.api.sendSegments = async () => {
    throw new Error('unsupported message segment type')
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.form, 'link')
  assert.equal(harness.sends.length, 1)
})

test('B1 分类函数：白名单只认明确的消息段错误', () => {
  assert.equal(classifySendError(new Error('unsupported segment')).status, 'card-unsupported')
  assert.equal(classifySendError(new Error('不支持这个消息段')).status, 'card-unsupported')
  for (const text of ['无法发送', '无法发送：连接已断开，投递结果不明', 'timeout', 'network error', 'send failed']) {
    assert.equal(classifySendError(new Error(text)).status, 'unknown', text)
  }
})

// ---------------- B2：null / 缺凭证进入同聊天同曲防重发 ----------------

test('B2 null 回执：第一次不报成功，第二次 0 新增投递', async () => {
  const { harness } = setup()
  await harness.raw.search({ query: '晴天' })
  let attempts = 0
  harness.api.sendText = async () => {
    attempts += 1
    return null
  }
  const first = await harness.raw.share({ index: 1 })
  assert.equal(first.ok, false)
  assert.equal(first.code, 'send-unknown')
  assert.equal(attempts, 1)

  const second = await harness.raw.share({ index: 1 })
  assert.equal(second.ok, false)
  assert.match(second.message, /结果不明|别重发/)
  assert.equal(attempts, 1, '第二次必须 0 新增发送尝试')
})

test('B2 undefined / false / 缺 message_id 同样进入防重发', async () => {
  const bodies = [() => undefined, () => false, () => ({ ok: true })]
  for (const reply of bodies) {
    const { harness } = setup()
    await harness.raw.search({ query: '晴天' })
    let attempts = 0
    harness.api.sendText = async () => {
      attempts += 1
      return reply()
    }
    const first = await harness.raw.share({ index: 1 })
    assert.equal(first.ok, false)
    assert.equal(first.code, 'send-unknown')
    const second = await harness.raw.share({ index: 1 })
    assert.equal(second.ok, false)
    assert.equal(attempts, 1, '第二次不能再调用发送出口')
    await harness.dispose()
  }
})

test('B2 卡片 null：不补链接，第二次也 0 新增', async () => {
  const { harness } = setup({ settings: { shareForm: 'card' } })
  await harness.raw.search({ query: '晴天' })
  let attempts = 0
  harness.api.sendSegments = async () => {
    attempts += 1
    return null
  }
  const first = await harness.raw.share({ index: 1 })
  assert.equal(first.ok, false)
  assert.equal(attempts, 1)
  const second = await harness.raw.share({ index: 1 })
  assert.equal(second.ok, false)
  assert.equal(attempts, 1)
  assert.equal(harness.sends.length, 0)
})

test('B2 调用前的权限拒绝是「确定没调用」，不进发送不明保护', async () => {
  const { harness } = setup()
  await harness.raw.search({ query: '晴天' })
  let attempts = 0
  harness.api.sendText = async () => {
    attempts += 1
    return { message_id: 'mock-ok' }
  }
  harness.state.owner = false
  const denied = await harness.raw.share({ index: 1 })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'forbidden')
  assert.equal(attempts, 0, '权限拒绝时根本没调用发送出口')

  harness.state.owner = true
  const ok = await harness.raw.share({ index: 1 })
  assert.equal(ok.ok, true)
  assert.equal(attempts, 1, '没被误记成发送不明')
})

test('B2 成功回执仍正常：不会被防重发挡住下一首', async () => {
  const { harness } = setup()
  await harness.raw.search({ query: '晴天', limit: 2 })
  const first = await harness.raw.share({ index: 1 })
  assert.equal(first.ok, true)
  assert.equal(first.status, 'delivered')
  const second = await harness.raw.share({ index: 2 })
  assert.equal(second.ok, true)
  assert.equal(harness.sends.length, 2)
})

test('B2 分类函数：null/undefined/false/缺 id 都是 unknown，sim-/真实 id 才确认', () => {
  for (const raw of [null, undefined, false, {}, { ok: true }]) {
    assert.equal(classifySendResult(raw).status, 'unknown', String(raw))
  }
  assert.equal(classifySendResult({ message_id: 'sim-1' }).status, 'simulated')
  assert.equal(classifySendResult({ message_id: '12345' }).status, 'delivered')
})

// ---------------- B3：待选择状态不被空参数绕过 ----------------

const WRONG_ARTIST = {
  code: 200,
  result: { songs: [{ id: 1412022124, name: '晴天', ar: [{ name: '空匪' }], originCoverType: 1 }] },
}

test('B3 artist-mismatch 之后，空参数分享必须继续等待选择', async () => {
  const { harness } = setup({ body: WRONG_ARTIST })
  const search = await harness.raw.search({ query: '晴天', artist: '周杰伦', version: 'original' })
  assert.equal(search.code, 'artist-mismatch')
  const share = await harness.raw.share({})
  assert.equal(share.ok, false)
  assert.equal(share.code, 'needs-choice')
  assert.equal(harness.sends.length, 0)

  const picked = await harness.raw.share({ index: 1 })
  assert.equal(picked.ok, true, '用户明确点序号后仍可分享替代候选')
  assert.equal(harness.sends.length, 1)
})

test('B3 needs-choice 之后，空参数分享仍要选择，不能发第 1 条', async () => {
  const { harness } = setup()
  const choice = await harness.raw.share({ keyword: '晴天' })
  assert.equal(choice.code, 'needs-choice')
  const share = await harness.raw.share({})
  assert.equal(share.ok, false)
  assert.equal(share.code, 'needs-choice')
  assert.equal(harness.sends.length, 0)

  const picked = await harness.raw.share({ index: 2 })
  assert.equal(picked.ok, true, '显式序号仍可选任意一条')
  assert.equal(harness.sends.length, 1)
})

test('B3 普通多候选：不传序号也不替你挑第 1 条', async () => {
  const body = {
    code: 200,
    result: {
      songs: [
        { id: 186016, name: '晴天', ar: [{ name: '周杰伦' }], originCoverType: 1 },
        { id: 185811, name: '稻香', ar: [{ name: '周杰伦' }], originCoverType: 1 },
      ],
    },
  }
  const { harness } = setup({ body })
  const search = await harness.raw.search({ query: '周杰伦' })
  assert.equal(search.ok, true)
  const share = await harness.raw.share({})
  assert.equal(share.ok, false)
  assert.equal(share.code, 'needs-choice')
  assert.equal(harness.sends.length, 0)
})

test('B3 只有一条候选时，「刚才那首」仍可直接分享（正例）', async () => {
  const one = { code: 200, result: { songs: [{ id: 186016, name: '晴天', ar: [{ name: '周杰伦' }], originCoverType: 1 }] } }
  const { harness } = setup({ body: one })
  await harness.raw.search({ query: '晴天' })
  const share = await harness.raw.share({})
  assert.equal(share.ok, true)
  assert.equal(harness.sends.length, 1)
})

test('B3 非法序号（0 / 负数 / 非数字）不发送，也不退回第 1 条', async () => {
  const { harness } = setup()
  await harness.raw.search({ query: '晴天' })
  for (const index of [0, -1, 'abc']) {
    const share = await harness.raw.share({ index })
    assert.equal(share.ok, false, String(index))
    assert.equal(share.code, 'needs-choice', `${index} 应继续等待选择`)
    assert.equal(harness.sends.length, 0, String(index))
  }
})

test('B3 待选择状态下给越界序号：如实说没有第几首，不发送', async () => {
  const { harness } = setup({ body: WRONG_ARTIST })
  await harness.raw.search({ query: '晴天', artist: '周杰伦', version: 'original' })
  const share = await harness.raw.share({ index: 9 })
  assert.equal(share.ok, false)
  assert.match(share.message, /没有第 9/)
  assert.equal(harness.sends.length, 0)
})

// ---------------- B4：跨 origin 重定向不转交凭据 ----------------

const FAKE_KEY = 'Bearer fake-fixture-only-not-a-real-key'

function authOf(init) {
  return new Headers(init?.headers).get('authorization') || ''
}

test('B4 QQ → 网易云跨平台 302：拒绝跟随，第二个请求根本不发', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: authOf(init) })
    if (String(url).startsWith('https://a.y.qq.com/')) {
      return jsonResponse({}, { status: 302, headers: { location: 'https://music.163.com/api/redirect-target' } })
    }
    return jsonResponse({ ok: true })
  }
  await assert.rejects(
    () => requestJson('https://a.y.qq.com/discover/search', {
      method: 'POST',
      headers: { Authorization: FAKE_KEY },
      body: '{}',
      fetchImpl,
      retries: 0,
    }),
    (error) => {
      assert.equal(error.code, 'redirect-blocked')
      assert.equal(error.message.includes('fake-fixture-only'), false, '错误里不能带凭据')
      return true
    },
  )
  assert.equal(calls.length, 1, '只发了原来那一次')
  assert.equal(calls[0].auth, FAKE_KEY)
  assert.equal(calls.some((call) => call.url.includes('music.163.com')), false, '没有把 Bearer 交给网易云')
})

test('B4 同 origin 相对跳转仍然跟随，并保留 Authorization（正例）', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: authOf(init) })
    if (String(url).endsWith('/discover/search')) {
      return jsonResponse({}, { status: 302, headers: { location: '/discover/search-v2' } })
    }
    return jsonResponse({ ok: true })
  }
  const result = await requestJson('https://a.y.qq.com/discover/search', {
    method: 'POST',
    headers: { Authorization: FAKE_KEY },
    body: '{}',
    fetchImpl,
    retries: 0,
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, 'https://a.y.qq.com/discover/search-v2')
  assert.equal(calls[1].auth, FAKE_KEY)
})

test('B4 正常 QQ 请求本来就带 Authorization（正例，假凭据）', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: authOf(init) })
    return jsonResponse({ ret: 0, songs: [] })
  }
  await requestJson('https://a.y.qq.com/discover/search', {
    method: 'POST',
    headers: { Authorization: FAKE_KEY },
    body: '{}',
    fetchImpl,
    retries: 0,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].auth, FAKE_KEY)
})

test('B4 跳到外域仍然直接拒绝（保留原行为）', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: authOf(init) })
    return jsonResponse({}, { status: 307, headers: { location: 'https://evil.example.com/steal' } })
  }
  await assert.rejects(
    () => requestJson('https://music.163.com/api/x', { fetchImpl, headers: { Authorization: FAKE_KEY }, retries: 0 }),
    (error) => error.code === 'redirect-blocked',
  )
  assert.equal(calls.length, 1)
  assert.equal(calls.some((call) => call.url.includes('evil.example.com')), false)
})

test('B4 同平台跨端口（origin 不同）也不跟随', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url })
    return jsonResponse({}, { status: 302, headers: { location: 'https://a.y.qq.com:8443/discover/search' } })
  }
  await assert.rejects(
    () => requestJson('https://a.y.qq.com/discover/search', {
      fetchImpl,
      headers: { Authorization: FAKE_KEY },
      retries: 0,
    }),
    (error) => error.code === 'redirect-blocked',
  )
  assert.equal(calls.length, 1)
})
