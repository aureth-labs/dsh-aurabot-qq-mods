// MUSIC-20261113-02 第 1 次退回（R1–R5）的正确行为回归。
//
// 这些用例断言「修正后应该怎样」，不是复用 Codex 的缺陷复现探针。
// 先在修正前基线（market-check/repo 的 0.2.0 源码副本）上运行，应全部失败；
// 再在修正源上运行，应全部通过。详见回执的「先证明能检错」一节。
//
// R1 命令异步后现查身份 / R2 SSE 文本后错误与截断 / R3 私人缓存防泄露 /
// R4 分项关闭后旧缓存与每次发送 / R5 已核 output 帧解析。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createHarness,
  fakeFetch,
  jsonResponse,
  sseResponse,
  hangUntilAbort,
  OWNER_PRIVATE,
  GROUP,
} from './helpers.mjs'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
const KEY = 'qmk-fixture-0000-not-a-real-key'
const QQ = { platform: 'qq', qqKey: KEY }
const SSE_ROUTE = (reply) => [{ match: (url) => url.endsWith('/assistant/ai_interpretation'), reply }]

function setup({ settings = {}, routes = [] } = {}) {
  const fetch = fakeFetch(routes)
  const harness = createHarness({ fetch, settings })
  harness.mount()
  return { harness, fetch }
}

// 验收单给出的已核结构示例（合成文本，不是真实解读正文）
const VERIFIED_FRAMES = [
  `data: ${JSON.stringify({ chunk_idx: 1, chunk_type: 'output', chunk_content: '这是合成测试文本，', references: null })}\n\n`,
  `data: ${JSON.stringify({ chunk_idx: 2, chunk_type: 'output', chunk_content: '没有包含账号内容。', references: null })}\n\n`,
  'event: done\ndata: [DONE]\n\n',
]

// ---------------- R1：命令在异步返回前现查当前身份 ----------------

test('R1 命令 /报告：开始时是主人、返回前被撤权 → 不返回私人数据', async () => {
  let harness
  const fetch = fakeFetch([{
    match: (url) => url.endsWith('/me/report'),
    reply: () => {
      harness.state.owner = false // 请求已经在飞，返回前身份变了
      return jsonResponse(fixture('qq-report-day.json'))
    },
  }])
  harness = createHarness({ fetch, settings: { ...QQ, reportEnabled: true } })
  harness.mount()
  let ownerCalls = 0
  const originalIsOwner = harness.api.isOwner
  harness.api.isOwner = (id) => {
    ownerCalls += 1
    return originalIsOwner(id)
  }

  const message = await harness.command('报告', '日')
  assert.match(message, /主人私聊|私人数据|身份/)
  assert.doesNotMatch(message, /周杰伦|听歌时长|Top 歌手/)
  assert.equal(harness.state.ownerChecks, 0, '命令身份必须用 api.isOwner(msg.userId) 现查，不走 hub 的会话身份')
  assert.ok(ownerCalls >= 2, `开始与返回前都要现查（实际 ${ownerCalls} 次）`)
  await harness.dispose()
})

test('R1 命令 /荐歌 每日：返回前撤权 → 不返回私人曲目', async () => {
  let harness
  const data = {
    ret: 0,
    sub_ret: 0,
    songlist: [{ songMid: '0039MnYb0qxYhV', songName: '仅主人可见的推荐曲', singerName: '测试歌手', songH5Url: 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV' }],
  }
  const fetch = fakeFetch([{
    match: (url) => url.endsWith('/discover/daily-mix'),
    reply: () => {
      harness.state.owner = false
      return jsonResponse(data)
    },
  }])
  harness = createHarness({ fetch, settings: { ...QQ, ownerOnly: false } })
  harness.mount()
  const message = await harness.command('荐歌', '每日')
  assert.match(message, /主人私聊|私人数据/)
  assert.doesNotMatch(message, /仅主人可见/)
  assert.equal(harness.exports.cacheSize(), 0, '被拒绝的私人结果不能留下缓存')
  await harness.dispose()
})

test('R1 命令 /歌单 AI 与 /解读：返回前/读流中撤权都不返回私人内容', async () => {
  let harness
  const fetch = fakeFetch([
    {
      match: (url) => url.endsWith('/discover/ai-playlists'),
      reply: () => {
        harness.state.owner = false
        return jsonResponse(fixture('qq-ai-playlists.json'))
      },
    },
    {
      match: (url) => url.endsWith('/assistant/ai_interpretation'),
      reply: () => sseResponse(['data: 私密解读片段\n\n', 'data: [DONE]\n\n']),
    },
  ])
  harness = createHarness({ fetch, settings: { ...QQ, interpretEnabled: true, ownerOnly: false } })
  harness.mount()

  const playlist = await harness.command('歌单', 'AI')
  assert.match(playlist, /主人私聊|私人数据/)
  assert.equal(harness.exports.cacheSize(), 0)
  await harness.dispose()

  // 解读：读流前撤权 → 取消，不返回文本
  let h2
  const sseFetch = fakeFetch(SSE_ROUTE(() => {
    h2.state.owner = false
    return sseResponse(['data: 私密解读片段\n\n', 'data: [DONE]\n\n'])
  }))
  h2 = createHarness({ fetch: sseFetch, settings: { ...QQ, interpretEnabled: true, ownerOnly: false } })
  h2.mount()
  const interpret = await h2.command('解读', '分析我的听歌风格')
  assert.match(interpret, /取消|身份|主人私聊/)
  assert.doesNotMatch(interpret, /私密解读片段/)
  await h2.dispose()
})

test('R1 工具路径仍按当前 session 复核（与命令分开处理）', async () => {
  let harness
  const fetch = fakeFetch([{
    match: (url) => url.endsWith('/me/report'),
    reply: () => {
      harness.state.owner = false
      return jsonResponse(fixture('qq-report-day.json'))
    },
  }])
  harness = createHarness({ fetch, settings: { ...QQ, reportEnabled: true } })
  harness.mount()
  // 工具出口只回 { ok, message }（宿主契约），断言走 raw 入口拿 code
  const viaTool = await harness.call('music_report', { period: 'day' })
  assert.equal(viaTool.ok, false)
  assert.match(viaTool.message, /主人私聊|私人数据/)
  assert.doesNotMatch(viaTool.message, /周杰伦|听歌时长/)
  await harness.dispose()

  let rawHarness
  const rawFetch = fakeFetch([{
    match: (url) => url.endsWith('/me/report'),
    reply: () => {
      rawHarness.state.owner = false
      return jsonResponse(fixture('qq-report-day.json'))
    },
  }])
  rawHarness = createHarness({ fetch: rawFetch, settings: { ...QQ, reportEnabled: true } })
  rawHarness.mount()
  const raw = await rawHarness.raw.report({ period: 'day' })
  assert.equal(raw.ok, false)
  assert.equal(raw.code, 'private-only')
  assert.ok(rawHarness.state.ownerChecks >= 2, '工具路径每轮都要问 hub')
  await rawHarness.dispose()
})

// ---------------- R2：SSE 文本后 error / 部分 / 截断 ----------------

test('R2 文本 → error → [DONE]：必须失败并说明错误，不能只报成功', async () => {
  const { harness } = setup({
    settings: { ...QQ, interpretEnabled: true },
    routes: SSE_ROUTE(() => sseResponse([
      'data: 私人分析片段\n\n',
      'event: error\ndata: 上游失败\n\n',
      'data: [DONE]\n\n',
    ])),
  })
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sse-error')
  assert.match(result.message, /error|失败|报错/)
  assert.match(result.message, /不完整|部分/)
  assert.match(result.message, /私人分析片段/, '报错前收到的部分仍如实展示并标注')
  await harness.dispose()
})

test('R2 有文本但 EOF 没有结束标记：只能算部分，不能报完整成功', async () => {
  const { harness } = setup({
    settings: { ...QQ, interpretEnabled: true },
    routes: SSE_ROUTE(() => sseResponse(['data: 只写了一半\n\n'])),
  })
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sse-partial')
  assert.match(result.message, /部分|没有收到.*结束标记/)
  assert.match(result.message, /只写了一半/)
  await harness.dispose()
})

test('R2 已核结构正常结束：仍是成功，且不误报部分', async () => {
  const { harness } = setup({
    settings: { ...QQ, interpretEnabled: true },
    routes: SSE_ROUTE(() => sseResponse(VERIFIED_FRAMES)),
  })
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, true)
  assert.equal(result.code, undefined)
  assert.match(result.message, /这是合成测试文本，没有包含账号内容。/)
  await harness.dispose()
})

test('R2 error 出现在文本之前也失败，且不回显上游错误正文', async () => {
  const { harness } = setup({
    settings: { ...QQ, interpretEnabled: true },
    routes: SSE_ROUTE(() => sseResponse(['event: error\ndata: 内部堆栈信息不该外泄\n\n', 'data: [DONE]\n\n'])),
  })
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sse-error')
  assert.doesNotMatch(result.message, /内部堆栈|qmk-/)
  await harness.dispose()
})

// ---------------- R3：私人缓存不得在拒绝后残留 ----------------

test('R3 每日推荐被拒后，同聊天分享不能发出私人曲目', async () => {
  let harness
  const data = {
    ret: 0,
    sub_ret: 0,
    songlist: [{ songMid: '0039MnYb0qxYhV', songName: '仅主人可见的推荐曲', singerName: '测试歌手', songH5Url: 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV' }],
  }
  const fetch = fakeFetch([{
    match: (url) => url.endsWith('/discover/daily-mix'),
    reply: () => {
      harness.state.owner = false
      return jsonResponse(data)
    },
  }])
  harness = createHarness({ fetch, settings: { ...QQ, ownerOnly: false } })
  harness.mount()

  const recommend = await harness.raw.recommend({ kind: 'daily' })
  assert.equal(recommend.ok, false)
  assert.equal(recommend.code, 'private-only')
  assert.equal(harness.exports.cacheSize(), 0, '拒绝的结果不能写缓存')

  const shared = await harness.call('music_share', { index: 1 })
  assert.equal(shared.ok, false)
  assert.equal(harness.sends.length, 0, '0 发送')
  assert.doesNotMatch(shared.message, /仅主人可见/)
  await harness.dispose()
})

test('R3 私人缓存只在当前主人私聊可分享：主人撤权后分享被拒', async () => {
  const { harness } = setup({
    settings: { ...QQ, ownerOnly: false },
    routes: [{
      match: (url) => url.endsWith('/discover/daily-mix'),
      reply: jsonResponse({
        ret: 0,
        sub_ret: 0,
        songlist: [{ songMid: '0039MnYb0qxYhV', songName: '仅主人可见的推荐曲', singerName: '测试歌手', songH5Url: 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV' }],
      }),
    }],
  })
  const recommend = await harness.call('music_recommend', { kind: 'daily' })
  assert.equal(recommend.ok, true)
  assert.equal(harness.exports.cacheSize(), 1)

  harness.state.owner = false
  const shared = await harness.raw.share({ index: 1 })
  assert.equal(shared.ok, false)
  assert.equal(shared.code, 'private-only')
  assert.equal(harness.sends.length, 0)
  assert.doesNotMatch(shared.message, /仅主人可见/)
  await harness.dispose()
})

test('R3 AI 歌单被拒后同样不留可分享缓存', async () => {
  let harness
  const fetch = fakeFetch([{
    match: (url) => url.endsWith('/discover/ai-playlists'),
    reply: () => {
      harness.state.owner = false
      return jsonResponse(fixture('qq-ai-playlists.json'))
    },
  }])
  harness = createHarness({ fetch, settings: { ...QQ, ownerOnly: false } })
  harness.mount()
  const result = await harness.call('music_playlist', { action: 'ai' })
  assert.equal(result.ok, false)
  assert.equal(harness.exports.cacheSize(), 0)
  const shared = await harness.call('music_share', { index: 1 })
  assert.equal(shared.ok, false)
  assert.equal(harness.sends.length, 0)
  await harness.dispose()
})

// ---------------- R4：分项关闭后旧缓存/每次发送都拦 ----------------

test('R4 搜索后关闭 searchEnabled：旧候选不能再分享（0 发送）', async () => {
  const { harness } = setup({
    routes: [{ match: 'api/cloudsearch/pc', reply: jsonResponse(fixture('netease-search.json')) }],
  })
  const search = await harness.raw.search({ query: '晴天' })
  assert.equal(search.ok, true)
  harness.state.settings.searchEnabled = false
  harness.emitConfig({}, {})

  const shared = await harness.raw.share({ index: 1 })
  assert.equal(shared.ok, false)
  assert.equal(shared.code, 'feature-disabled')
  assert.match(shared.message, /歌曲搜索/)
  assert.equal(harness.sends.length, 0)
  await harness.dispose()
})

test('R4 旧挂载的工具实例也拦：搜索后关开关，share 仍 0 发送', async () => {
  const { harness } = setup({
    routes: [{ match: 'api/cloudsearch/pc', reply: jsonResponse(fixture('netease-search.json')) }],
  })
  const shareTool = harness.tool('music_share')
  await harness.raw.search({ query: '晴天' })
  harness.state.settings.searchEnabled = false
  harness.emitConfig({}, {})
  const result = await shareTool.execute({ index: 1 }, { sessionId: OWNER_PRIVATE.sessionId })
  assert.equal(result.ok, false)
  assert.match(result.message, /关闭/)
  assert.equal(harness.sends.length, 0)
  await harness.dispose()
})

test('R4 榜单详情后关闭 chartsEnabled：旧榜单曲目不能分享', async () => {
  const { harness } = setup({
    settings: QQ,
    routes: [{ match: (url) => url.endsWith('/charts/detail'), reply: jsonResponse(fixture('qq-chart-detail.json')) }],
  })
  const detail = await harness.raw.charts({ action: 'detail', topId: 26 })
  assert.equal(detail.ok, true)
  harness.state.settings.chartsEnabled = false
  harness.emitConfig({}, {})
  const shared = await harness.raw.share({ index: 1 })
  assert.equal(shared.ok, false)
  assert.equal(shared.code, 'feature-disabled')
  assert.match(shared.message, /排行榜单/)
  assert.equal(harness.sends.length, 0)
  await harness.dispose()
})

test('R4 歌单详情后关闭 playlistEnabled：旧歌单曲目不能分享', async () => {
  const { harness } = setup({
    settings: QQ,
    routes: [{ match: (url) => url.endsWith('/playlists/detail'), reply: jsonResponse(fixture('qq-playlist-detail.json')) }],
  })
  const detail = await harness.raw.playlist({ action: 'detail', dissId: 9012001 })
  assert.equal(detail.ok, true)
  harness.state.settings.playlistEnabled = false
  harness.emitConfig({}, {})
  const shared = await harness.raw.share({ index: 1 })
  assert.equal(shared.ok, false)
  assert.equal(shared.code, 'feature-disabled')
  assert.equal(harness.sends.length, 0)
  await harness.dispose()
})

test('R4 场景推荐依赖分类歌单：关掉后旧场景候选也不能分享', async () => {
  const detail = fixture('netease-detail.json')
  const { harness } = setup({
    routes: [
      { match: (url) => url.includes('api/playlist/list'), reply: jsonResponse(fixture('netease-playlists.json')) },
      {
        match: (url) => url.includes('api/v6/playlist/detail'),
        reply: (url, init) => {
          const id = new URLSearchParams(String(init?.body || '')).get('id')
          return jsonResponse({ result: id === '111' ? detail.playlist : detail.playlist222 })
        },
      },
    ],
  })
  const recommend = await harness.raw.recommend({ kind: 'scene', scene: '学习' })
  assert.equal(recommend.ok, true)
  harness.state.settings.playlistEnabled = false
  harness.emitConfig({}, {})
  const shared = await harness.raw.share({ index: 1 })
  assert.equal(shared.ok, false)
  assert.equal(shared.code, 'feature-disabled')
  assert.match(shared.message, /分类歌单/)
  assert.equal(harness.sends.length, 0)
  await harness.dispose()
})

test('R4 依赖关闭会取消在途的场景推荐（recommend+playlist）', async () => {
  const fetch = fakeFetch([{ match: (url) => url.includes('api/playlist/list'), reply: hangUntilAbort() }])
  const harness = createHarness({ fetch })
  harness.mount()
  const pending = harness.exports.recommend({ scene: '学习', chatId: OWNER_PRIVATE.chat.chatId })
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.state.settings.playlistEnabled = false // 只关依赖，不关主能力
  harness.emitConfig({}, {})
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'aborted')
  assert.equal(fetch.calls.length, 1, '取消后不许再发新请求')
  assert.equal(harness.exports.cacheSize(), 0)
  await harness.dispose()
})

test('R4 歌单搜索在途关闭分类歌单：取消且不提交结果', async () => {
  const fetch = fakeFetch([{ match: (url) => url.endsWith('/discover/search'), reply: hangUntilAbort() }])
  const harness = createHarness({ fetch, settings: QQ })
  harness.mount()
  const pending = harness.raw.search({ query: '夜跑', type: 'playlist' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.state.settings.playlistEnabled = false
  harness.emitConfig({}, {})
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'aborted')
  assert.equal(harness.exports.cacheSize(), 0)
  await harness.dispose()
})

test('R4 请求已完成但依赖刚被关：结果不提交、不缓存', async () => {
  let harness
  const fetch = fakeFetch([
    {
      match: (url) => url.includes('api/playlist/list'),
      reply: () => {
        // 只改设置、不触发 config：模拟「请求已完成才发现依赖被关」，验证提交前的 recheck
        harness.state.settings.playlistEnabled = false
        return jsonResponse(fixture('netease-playlists.json'))
      },
    },
    {
      match: (url) => url.includes('api/v6/playlist/detail'),
      reply: () => jsonResponse({ result: fixture('netease-detail.json').playlist }),
    },
  ])
  harness = createHarness({ fetch })
  harness.mount()
  const result = await harness.raw.recommend({ kind: 'scene', scene: '学习' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'feature-disabled')
  assert.equal(harness.exports.cacheSize(), 0, '关掉的依赖不许提交缓存')
  await harness.dispose()
})

test('R4 卡片兜底那一次也现查开关：兜底前关掉搜索则 0 发送', async () => {
  const { harness } = setup({
    settings: { shareForm: 'card' },
    routes: [{ match: 'api/cloudsearch/pc', reply: jsonResponse(fixture('netease-search.json')) }],
  })
  await harness.raw.search({ query: '晴天' })
  harness.api.sendSegments = async () => {
    harness.state.settings.searchEnabled = false
    harness.emitConfig({}, {})
    throw new Error('unsupported segment')
  }
  const result = await harness.raw.share({ index: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'feature-disabled')
  assert.equal(harness.sends.length, 0, '卡片没发成，兜底链接也不许发')
  await harness.dispose()
})

// ---------------- R5：已核 output 帧结构 ----------------

test('R5 已核结构：chunk_type=output + chunk_content 文本能正常显示', async () => {
  const { harness, fetch } = setup({
    settings: { ...QQ, interpretEnabled: true },
    routes: SSE_ROUTE(() => sseResponse(VERIFIED_FRAMES)),
  })
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '这是合成测试文本，没有包含账号内容。')
  assert.equal(result.unknownJsonEvents, 0)
  assert.match(result.message, /共 2 段文本/)
  assert.equal(fetch.calls.length, 1)
  await harness.dispose()
})

test('R5 15 个 output 帧按顺序拼接，正常结束', async () => {
  const frames = []
  for (let i = 1; i <= 15; i += 1) {
    frames.push(`data: ${JSON.stringify({ chunk_idx: i, chunk_type: 'output', chunk_content: `第${i}段，`, references: null })}\n\n`)
  }
  frames.push('event: done\ndata: [DONE]\n\n')
  const { harness } = setup({
    settings: { ...QQ, interpretEnabled: true },
    routes: SSE_ROUTE(() => sseResponse(frames)),
  })
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, true)
  assert.equal(result.text, Array.from({ length: 15 }, (_, i) => `第${i + 1}段，`).join(''))
  assert.match(result.message, /共 15 段文本/)
  await harness.dispose()
})

test('R5 JSON 帧跨 chunk 且 UTF-8 被切断也能解析', async () => {
  const lines = VERIFIED_FRAMES.join('')
  const bytes = new TextEncoder().encode(lines)
  // 在第一个中文字符的 UTF-8 中间切开（"这是合成" 的 "这" 是 3 字节）
  const cut = bytes.indexOf(new TextEncoder().encode('这')[0]) + 1
  const { harness } = setup({
    settings: { ...QQ, interpretEnabled: true },
    routes: SSE_ROUTE(() => sseResponse([bytes.slice(0, cut), bytes.slice(cut)])),
  })
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '这是合成测试文本，没有包含账号内容。')
  await harness.dispose()
})

test('R5 未知 chunk_type 不当内容，只记类型名并明确说明', async () => {
  const { harness } = setup({
    settings: { ...QQ, interpretEnabled: true },
    routes: SSE_ROUTE(() => sseResponse([
      `data: ${JSON.stringify({ chunk_idx: 1, chunk_type: 'reference_list', chunk_content: '不该出现的内容', references: null })}\n\n`,
      'event: done\ndata: [DONE]\n\n',
    ])),
  })
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sse-unknown-frames')
  assert.doesNotMatch(result.message, /不该出现的内容/)
  assert.match(result.message, /reference_list|chunk_type=output/)
  await harness.dispose()
})

test('R5 output 帧字段不合规（chunk_content 非字符串 / chunk_idx 非数字）不当作内容', async () => {
  for (const bad of [
    { chunk_idx: 1, chunk_type: 'output', chunk_content: 123, references: null },
    { chunk_idx: '1', chunk_type: 'output', chunk_content: '不该出现的内容', references: null },
  ]) {
    const { harness } = setup({
      settings: { ...QQ, interpretEnabled: true },
      routes: SSE_ROUTE(() => sseResponse([`data: ${JSON.stringify(bad)}\n\n`, 'event: done\ndata: [DONE]\n\n'])),
    })
    const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'sse-unknown-frames')
    assert.doesNotMatch(result.message, /不该出现的内容/)
    await harness.dispose()
  }
})

test('R5 output 文本 + 未知类型帧：成功但要如实标注跳过的帧', async () => {
  const { harness } = setup({
    settings: { ...QQ, interpretEnabled: true },
    routes: SSE_ROUTE(() => sseResponse([
      `data: ${JSON.stringify({ chunk_idx: 1, chunk_type: 'output', chunk_content: '正常文本。', references: null })}\n\n`,
      `data: ${JSON.stringify({ chunk_idx: 2, chunk_type: 'references', chunk_content: '引用内容', references: null })}\n\n`,
      'event: done\ndata: [DONE]\n\n',
    ])),
  })
  const result = await harness.raw.interpret({ query: '分析我的听歌风格' })
  assert.equal(result.ok, true)
  assert.match(result.message, /正常文本。/)
  assert.match(result.message, /1 个帧不符合已核 chunk_type=output 结构/)
  assert.match(result.message, /references/)
  assert.doesNotMatch(result.message, /引用内容/)
  await harness.dispose()
})

test('R5 群聊里调用解读仍被私聊门拦住（先于联网）', async () => {
  const { harness, fetch } = setup({ settings: { ...QQ, interpretEnabled: true, ownerOnly: false } })
  const result = await harness.call('music_interpret', { query: '分析我的听歌风格' }, GROUP)
  assert.equal(result.ok, false)
  assert.match(result.message, /主人私聊|私人数据/)
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('R3 私人候选不让选序号时也不能列出曲名（非主人/群聊提前拦）', async () => {
  const data = {
    ret: 0,
    sub_ret: 0,
    songlist: [
      { songMid: '0039MnYb0qxYhV', songName: '仅主人可见A', singerName: '测试歌手', songH5Url: 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV' },
      { songMid: '000MkMni1yWrP4', songName: '仅主人可见B', singerName: '测试歌手', songH5Url: 'https://y.qq.com/n/ryqq/songDetail/000MkMni1yWrP4' },
    ],
  }
  const { harness } = setup({
    settings: { ...QQ, ownerOnly: false },
    routes: [{ match: (url) => url.endsWith('/discover/daily-mix'), reply: jsonResponse(data) }],
  })
  const recommend = await harness.raw.recommend({ kind: 'daily' })
  assert.equal(recommend.ok, true)
  assert.equal(recommend.candidates.length, 2)

  harness.state.owner = false
  // 不带序号：本来是「让用户选第几首」的分支，但私人候选不能把曲名列表给非主人
  const shared = await harness.raw.share({})
  assert.equal(shared.ok, false)
  assert.equal(shared.code, 'private-only')
  assert.doesNotMatch(shared.message, /仅主人可见/)
  assert.equal(harness.sends.length, 0)
  await harness.dispose()
})
