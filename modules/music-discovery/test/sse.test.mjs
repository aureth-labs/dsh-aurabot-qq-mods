// SSE：分块/UTF-8、多行 data、边界、未知 JSON 帧、错误/超时/取消/截断。
// 关键：官方没有给 JSON 业务帧字段，未知帧不能被猜成内容，也不能报成功。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fakeFetch, jsonResponse, sseResponse, sseHangUntilAbort } from './helpers.mjs'
import { createInterpretationCollector, createSseDecoder } from '../lib/sse.mjs'
import { requestSse } from '../lib/http.mjs'

const KEY = 'qmk-fixture-0000-not-a-real-key'
const SSE_ROUTE = (reply) => [{ match: (url) => url.endsWith('/assistant/ai_interpretation'), reply }]

function setup(reply, settings = {}) {
  const fetch = fakeFetch(SSE_ROUTE(reply))
  const harness = createHarness({ fetch, settings: { platform: 'qq', qqKey: KEY, interpretEnabled: true, ...settings } })
  harness.mount()
  return { harness, fetch }
}

// ---------- 解码器 ----------

test('SSE 解码：CRLF、多行 data、注释、end 补尾', () => {
  const decoder = createSseDecoder()
  const text = 'data: 你好\n\n: ping\r\ndata: 第一行\r\ndata: 第二行\r\n\r\n'
  const events = [
    ...decoder.push(text.slice(0, 5)),
    ...decoder.push(text.slice(5)),
    ...decoder.end(),
  ]
  assert.equal(events.length, 2)
  assert.equal(events[0].data, '你好')
  assert.equal(events[1].data, '第一行\n第二行')
})

test('requestSse：UTF-8 字符跨 chunk 切分也能还原', async () => {
  const bytes = new TextEncoder().encode('data: 你好世界\n\n')
  // 第 7 个字节正好切在「你」的 UTF-8 三字节中间
  const fetch = fakeFetch([{ match: 'a.y.qq.com', reply: sseResponse([bytes.slice(0, 7), bytes.slice(7)]) }])
  const stream = await requestSse('https://a.y.qq.com/assistant/ai_interpretation', { fetchImpl: fetch, timeoutMs: 2000 })
  const decoder = createSseDecoder()
  const events = []
  for await (const chunk of stream.chunks) events.push(...decoder.push(chunk))
  events.push(...decoder.end())
  assert.equal(events.length, 1)
  assert.equal(events[0].data, '你好世界')
})

test('SSE 解码：event 名与 data 分字段，空行才提交', () => {
  const decoder = createSseDecoder()
  const events = [
    ...decoder.push('event: message\ndata: A\n\n'),
    ...decoder.push('data: B\n'),
    ...decoder.end(),
  ]
  assert.deepEqual(events, [
    { event: 'message', data: 'A' },
    { event: '', data: 'B' },
  ])
})

// ---------- 收集器 ----------

test('收集器：纯文本拼接、[DONE]、JSON 帧不猜内容', () => {
  const c = createInterpretationCollector({ maxChars: 100 })
  c.take({ data: '你是一个' })
  c.take({ data: '很爱听歌的人。' })
  c.take({ data: '[DONE]' })
  c.take({ data: '{"delta":{"content":"这句是猜的"}}' })
  const result = c.result()
  assert.equal(result.ok, true)
  assert.equal(result.text, '你是一个很爱听歌的人。')
  assert.equal(result.done, true)
  assert.equal(result.unknownJsonEvents, 1)
  assert.doesNotMatch(result.text, /猜的/)
})

test('收集器：只有未知 JSON 帧时不能报成功', () => {
  const c = createInterpretationCollector({})
  c.take({ data: '{"choices":[{"delta":{"content":"猜的"}}]}' })
  c.take({ data: '{"foo":"bar"}' })
  const result = c.result()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sse-unknown-frames')
  assert.equal(result.text, '')
})

test('收集器：error 事件与空流分别标记', () => {
  const err = createInterpretationCollector({})
  err.take({ event: 'error', data: 'upstream failed' })
  assert.equal(err.result().code, 'sse-error')
  const empty = createInterpretationCollector({})
  assert.equal(empty.result().code, 'sse-empty')
})

// 第1次退回 R2：截断是「部分内容」，不能算完整成功（原断言 ok:true 与 R2 冲突，已按验收单修正）
test('收集器：超过上限截断，保留已读文本但不算完整成功', () => {
  const c = createInterpretationCollector({ maxChars: 5 })
  c.take({ data: '1234567890' })
  const result = c.result()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sse-truncated')
  assert.equal(result.text, '12345')
  assert.equal(result.truncated, true)
})

// ---------- 请求层 ----------

test('requestSse：403 直接 auth-failed，不把响应体带进错误', async () => {
  const fetch = fakeFetch([{ match: 'a.y.qq.com', reply: jsonResponse({ secret: 'x' }, { status: 403 }) }])
  await assert.rejects(
    () => requestSse('https://a.y.qq.com/assistant/ai_interpretation', { fetchImpl: fetch, headers: { Authorization: 'Bearer fake' } }),
    (error) => error.code === 'auth-failed' && !error.message.includes('secret'),
  )
})

test('requestSse：超时抛 timeout', async () => {
  const fetch = fakeFetch([{ match: 'a.y.qq.com', reply: sseHangUntilAbort() }])
  const stream = await requestSse('https://a.y.qq.com/assistant/ai_interpretation', { fetchImpl: fetch, timeoutMs: 40 })
  await assert.rejects(
    async () => {
      for await (const chunk of stream.chunks) void chunk
    },
    (error) => error.code === 'timeout',
  )
})

test('requestSse：外部取消抛 aborted', async () => {
  const fetch = fakeFetch([{ match: 'a.y.qq.com', reply: sseHangUntilAbort() }])
  const controller = new AbortController()
  const stream = await requestSse('https://a.y.qq.com/assistant/ai_interpretation', {
    fetchImpl: fetch,
    signal: controller.signal,
    timeoutMs: 5000,
  })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(
    async () => {
      for await (const chunk of stream.chunks) void chunk
    },
    (error) => error.code === 'aborted',
  )
})

test('requestSse：跨 origin 跳转拒绝，Authorization 不外传', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization') || '' })
    return jsonResponse({}, { status: 302, headers: { location: 'https://music.163.com/api/x' } })
  }
  await assert.rejects(
    () => requestSse('https://a.y.qq.com/assistant/ai_interpretation', {
      fetchImpl: fetch,
      headers: { Authorization: 'Bearer fake-only' },
      timeoutMs: 2000,
    }),
    (error) => error.code === 'redirect-blocked',
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].auth, 'Bearer fake-only')
})

// ---------- 模块入口 ----------

test('AI 解读：纯文本 SSE 正常拼接，来源写清是 QQ 音乐流式', async () => {
  const { harness, fetch } = setup(() => sseResponse([
    'data: 你是一个\n\n',
    'data: 很爱听歌的人。\n\n',
    'data: [DONE]\n\n',
  ]))
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, true)
  assert.match(result.message, /QQ 音乐 AI 解读/)
  assert.match(result.message, /你是一个很爱听歌的人。/)
  const body = JSON.parse(fetch.calls[0].init.body)
  assert.deepEqual(body.params, { query: '分析我的听歌风格' })
  assert.equal(body.comm.skill_version, '0.0.3')
  await harness.dispose()
})

test('AI 解读：未知 JSON 帧不猜内容、不报成功', async () => {
  const { harness } = setup(() => sseResponse([
    'data: {"delta":{"content":"这段不该出现"}}\n\n',
  ]))
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sse-unknown-frames')
  assert.doesNotMatch(result.message, /这段不该出现/)
  // 第1次退回 R5：已知 output 结构后，文案改成「不符合已核 chunk_type=output 结构」
  assert.match(result.message, /chunk_type=output|没有当内容/)
  await harness.dispose()
})

test('AI 解读：文本 + 未知 JSON 帧同时出现时，如实标注跳过的帧数', async () => {
  const { harness } = setup(() => sseResponse([
    'data: 先给你一段结论。\n\n',
    'data: {"unknown":true}\n\n',
    'data: [DONE]\n\n',
  ]))
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, true)
  assert.match(result.message, /先给你一段结论。/)
  // 第1次退回 R5：未知帧的措辞改为「不符合已核 chunk_type=output 结构」，计数仍需如实标注
  assert.match(result.message, /1 个帧不符合已核 chunk_type=output 结构/)
  await harness.dispose()
})

// 第1次退回 R2：截断必须明确「部分/未完成」且 ok=false（原断言 ok:true 与 R2 冲突，已按验收单修正）
test('AI 解读：内容超过上限时明确是部分内容，不冒充完整成功', async () => {
  const long = '长'.repeat(4200)
  const { harness } = setup(() => sseResponse([`data: ${long}\n\n`]))
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sse-truncated')
  assert.equal(result.truncated, true)
  assert.match(result.message, /部分内容/)
  assert.match(result.message, /截断/)
  assert.ok(result.text.length > 0, '已读到的部分仍保留')
  await harness.dispose()
})

test('AI 解读：平台返回 JSON（非 SSE）时不当成功', async () => {
  const { harness } = setup(() => sseResponse(['{"ret":0,"msg":"ok"}'], { contentType: 'application/json' }))
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, false)
  assert.match(result.message, /没有按 SSE|看不懂|平台出错/)
  await harness.dispose()
})

test('AI 解读：平台 JSON 错误码如实报错，不回显 Key', async () => {
  const { harness } = setup(() => sseResponse(['{"ret":100,"msg":"invalid token"}'], { contentType: 'application/json' }))
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, false)
  assert.doesNotMatch(result.message, /qmk-|fake-fixture/)
  await harness.dispose()
})

test('AI 解读：关闭开关会取消进行中的 SSE，0 发送', async () => {
  const { harness } = setup(sseHangUntilAbort())
  const pending = harness.raw.interpret({ query: '分析我的听歌风格' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.state.settings.interpretEnabled = false
  harness.emitConfig({}, {})
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'aborted')
  assert.equal(harness.sends.length, 0)
  await harness.dispose()
})

test('AI 解读：读流中主人身份被撤，取消且不返回文本', async () => {
  let i = 0
  const encoder = new TextEncoder()
  const reply = () => ({
    status: 200,
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: new ReadableStream({
      async pull(controller) {
        if (i >= 2) return controller.close()
        if (i === 0) harness.state.owner = false // 第一段读完就撤权
        controller.enqueue(encoder.encode(`data: 私密内容${i}\n\n`))
        i += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
      },
    }),
  })
  const harness = createHarness({
    fetch: fakeFetch(SSE_ROUTE(reply)),
    settings: { platform: 'qq', qqKey: KEY, interpretEnabled: true },
  })
  harness.mount()
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'aborted')
  assert.doesNotMatch(result.message, /私密内容/)
  await harness.dispose()
})

test('AI 解读：assetTypes 只接受 1/2，非法值 0 请求', async () => {
  const { harness, fetch } = setup(() => sseResponse(['data: ok\n\n']))
  const result = await harness.raw.interpret({ query: '分析我的听歌风格', assetTypes: [1, 3] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad-argument')
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('AI 解读：较长的追问（>60 字）不会被搜索用的 60 字上限截断', async () => {
  const long = '我想知道自己最近是不是总在深夜听周杰伦，以及这种听歌习惯说明了什么，请结合收藏歌曲和听歌记录一起分析。'.repeat(2)
  const { harness, fetch } = setup(() => sseResponse(['data: 好\n\n', 'data: [DONE]\n\n']))
  assert.ok(long.length > 60)
  const result = await harness.raw.interpret({ query: long, assetTypes: [1, 2] })
  assert.equal(result.ok, true)
  const body = JSON.parse(fetch.calls[0].init.body)
  assert.equal(body.params.query, long)
  assert.deepEqual(body.params.assetTypes, [1, 2])
  await harness.dispose()
})
