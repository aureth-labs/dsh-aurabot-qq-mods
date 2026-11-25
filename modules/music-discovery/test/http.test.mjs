// 请求层：域名白名单、超时、有限重试、429、403、坏 JSON。
// 全部注入假 fetch，不打真网络。

import test from 'node:test'
import assert from 'node:assert/strict'
import { requestJson, MusicError, assertAllowedUrl } from '../lib/http.mjs'
import { fakeFetch, hangUntilAbort, jsonResponse } from './helpers.mjs'

test('域名白名单：只放行两个音乐平台域名，且必须 https', () => {
  assert.equal(assertAllowedUrl('https://music.163.com/api/x').hostname, 'music.163.com')
  assert.equal(assertAllowedUrl('https://a.y.qq.com/discover/search').hostname, 'a.y.qq.com')
  for (const bad of [
    'http://music.163.com/api/x',
    'https://evil.example.com/x',
    'https://music.163.com.evil.com/x',
    'ftp://music.163.com/x',
    'not a url',
  ]) {
    assert.throws(() => assertAllowedUrl(bad), (error) => error instanceof MusicError && error.code === 'bad-url', bad)
  }
})

test('requestJson：不允许的域名直接拒绝，不发请求', async () => {
  const fetch = fakeFetch([])
  await assert.rejects(
    () => requestJson('https://evil.example.com/steal', { fetchImpl: fetch }),
    (error) => error.code === 'bad-url',
  )
  assert.equal(fetch.calls.length, 0)
})

test('超时：抛 timeout，不把请求挂死', async () => {
  const fetch = fakeFetch([{ match: 'music.163.com', reply: hangUntilAbort() }])
  const started = Date.now()
  await assert.rejects(
    () => requestJson('https://music.163.com/api/x', { fetchImpl: fetch, timeoutMs: 40, retries: 0 }),
    (error) => error.code === 'timeout',
  )
  assert.ok(Date.now() - started < 1500)
})

test('网络错误：重试一次后仍失败就抛 network', async () => {
  let calls = 0
  const fetch = async () => {
    calls += 1
    throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  }
  await assert.rejects(
    () => requestJson('https://music.163.com/api/x', { fetchImpl: fetch, retries: 1, retryDelayMs: 5 }),
    (error) => error.code === 'network',
  )
  assert.equal(calls, 2)
})

test('429：按 retry-after 退避后重试一次成功', async () => {
  let calls = 0
  const fetch = async () => {
    calls += 1
    if (calls === 1) return jsonResponse({}, { status: 429, headers: { 'retry-after': '0' } })
    return jsonResponse({ ok: true })
  }
  const result = await requestJson('https://music.163.com/api/x', { fetchImpl: fetch, retries: 1, retryDelayMs: 5 })
  assert.equal(result.ok, true)
  assert.equal(calls, 2)
})

test('429 连续两次：抛 rate-limited', async () => {
  const fetch = fakeFetch([{ match: 'music.163.com', reply: jsonResponse({}, { status: 429 }) }])
  await assert.rejects(
    () => requestJson('https://music.163.com/api/x', { fetchImpl: fetch, retries: 1, retryDelayMs: 5 }),
    (error) => error.code === 'rate-limited' && error.status === 429,
  )
  assert.equal(fetch.calls.length, 2)
})

test('403：直接抛 auth-failed，不重试（凭据问题重试没意义）', async () => {
  const fetch = fakeFetch([{ match: 'a.y.qq.com', reply: jsonResponse({}, { status: 403 }) }])
  await assert.rejects(
    () => requestJson('https://a.y.qq.com/discover/search', { fetchImpl: fetch, retries: 2 }),
    (error) => error.code === 'auth-failed' && error.status === 403,
  )
  assert.equal(fetch.calls.length, 1)
})

test('5xx：重试后抛 server', async () => {
  const fetch = fakeFetch([{ match: 'music.163.com', reply: jsonResponse({}, { status: 502 }) }])
  await assert.rejects(
    () => requestJson('https://music.163.com/api/x', { fetchImpl: fetch, retries: 1, retryDelayMs: 5 }),
    (error) => error.code === 'server',
  )
  assert.equal(fetch.calls.length, 2)
})

test('坏 JSON：抛 parse，错误里不带响应原文', async () => {
  const fetch = fakeFetch([{ match: 'music.163.com', reply: jsonResponse('<html>captcha</html>') }])
  await assert.rejects(
    () => requestJson('https://music.163.com/api/x', { fetchImpl: fetch, retries: 0 }),
    (error) => error.code === 'parse' && error.message.includes('<html>') === false,
  )
})

test('外部取消：抛 aborted', async () => {
  const fetch = fakeFetch([{ match: 'music.163.com', reply: hangUntilAbort() }])
  const controller = new AbortController()
  const pending = requestJson('https://music.163.com/api/x', { fetchImpl: fetch, signal: controller.signal, retries: 0 })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(pending, (error) => error.code === 'aborted')
})
