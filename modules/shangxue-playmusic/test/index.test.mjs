// 单元测试：不触网（对 global.fetch 打桩），验证纯逻辑 + 两个工具的接线。
// 运行：npm test （= npm run build 生成 lib/ + node --test）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mod from '../index.mjs'
import { toSeconds, scoreCandidate, fetchJson, searchBili } from '../lib/providers/bilibili.js'
import { searchNetease, songUrlNetease } from '../lib/providers/netease.js'
import { cacheKey } from '../lib/cache/store.js'
import { APIFOX_PROXY, EmptyResponseError, fetchRace, resolveProxy } from '../lib/utils/fetch-race.js'

/** apifox 是 POST 包装：真正的目标地址在 api-u 头里。 */
function targetOf(url, init) {
  const headers = (init && init.headers) || {}
  const fromHeader = typeof headers.get === 'function' ? headers.get('api-u') : headers['api-u']
  return String(fromHeader || url)
}

function cookieOf(init) {
  const headers = (init && init.headers) || {}
  const value = typeof headers.get === 'function' ? headers.get('cookie') : headers.cookie
  return value || undefined
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

// ---------------- 纯逻辑 ----------------

test('toSeconds：兼容 "04:12" 与纯秒数', () => {
  assert.equal(toSeconds('04:12'), 252)
  assert.equal(toSeconds('1:00:00'), 3600)
  assert.equal(toSeconds(252), 252)
  assert.equal(toSeconds('252'), 252)
  assert.equal(toSeconds(''), 0)
  assert.equal(toSeconds('abc'), 0)
})

test('scoreCandidate：标题含歌名、时长达标的得分更高', () => {
  const good = scoreCandidate({ title: '多幸运 韩雪 原唱 完整版', duration: 252, play: 1_000_000 }, '多幸运')
  const bad = scoreCandidate({ title: '完全无关的视频', duration: 20, play: 10 }, '多幸运')
  assert.ok(good > bad, '匹配的分应高于不匹配的')
})

test('fetchJson：能从 HTML 错误页里抠出 JSON', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response('<br />错误 <br />{"code":0,"data":[1,2]}', { status: 200 })
  try {
    const j = await fetchJson('http://x', { retries: 1 })
    assert.equal(j.code, 0)
    assert.deepEqual(j.data, [1, 2])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('resolveProxy：留空走 apifox，direct 只直连，其它地址按前缀代理', () => {
  assert.equal(resolveProxy('').kind, 'apifox')
  assert.deepEqual(resolveProxy('').channels, ['direct', 'proxy'])
  assert.deepEqual(resolveProxy('direct').channels, ['direct'])
  assert.deepEqual(resolveProxy('off').channels, ['direct'])
  assert.equal(resolveProxy('https://px.example.com/').kind, 'prefix')
  assert.deepEqual(resolveProxy('https://px.example.com/').channels, ['direct', 'proxy'])
})

test('fetchRace：直连失败时用 apifox 代理的结果', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url) === APIFOX_PROXY) return jsonResponse({ ok: true })
    return new Response('boom', { status: 502 })
  }
  try {
    const res = await fetchRace('https://api.example.com/x', {}, { timeoutMs: 2000 })
    assert.deepEqual(await res.json(), { ok: true })
  } finally {
    globalThis.fetch = realFetch
  }
})

test('fetchRace：空响应不算成功，全部为空时抛 EmptyResponseError', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('   ', { status: 200, headers: { 'content-type': 'text/plain' } })
  try {
    await assert.rejects(
      () => fetchRace('https://api.example.com/x', {}, { timeoutMs: 2000 }),
      (error) => error instanceof EmptyResponseError,
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

test('fetchRace：validate 不过关的结果被丢弃，换另一条通道', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const isProxy = String(url) === APIFOX_PROXY
    return jsonResponse(isProxy ? { songs: [1] } : { songs: [] })
  }
  try {
    const res = await fetchRace('https://api.example.com/x', {}, {
      timeoutMs: 2000,
      validate: async (response) => {
        const json = await response.json()
        return Array.isArray(json.songs) && json.songs.length > 0
      },
    })
    assert.deepEqual(await res.json(), { songs: [1] })
  } finally {
    globalThis.fetch = realFetch
  }
})

test('searchBili：归一化 + 过滤翻唱 + 标题匹配优先', async () => {
  const realFetch = globalThis.fetch
  const payload = {
    code: 0,
    data: [
      { bvid: 'BV1aaaaaaaaa', video: { title: '多幸运 韩雪 官方MV' }, stat: { duration: '04:12', video: 1000000 }, owner: { name: 'UP1' } },
      { bvid: 'BV2bbbbbbbbb', video: { title: '多幸运 翻唱 cover' }, stat: { duration: '04:05', video: 999999 }, owner: { name: 'UP2' } },
      { bvid: 'BV3ccccccccc', video: { title: '别的歌' }, stat: { duration: '03:00', video: 10 }, owner: { name: 'UP3' } },
    ],
  }
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 })
  try {
    const rows = await searchBili('多幸运', { limit: 5 })
    assert.equal(rows[0].bvid, 'BV1aaaaaaaaa', '应选官方原唱')
    assert.ok(!rows.some((r) => r.bvid === 'BV2bbbbbbbbb'), '翻唱被排除')
    assert.ok(rows.every((r) => r.duration > 0), 'duration 已转秒')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('searchNetease：走公开搜索接口，不发 Cookie', async () => {
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), target: targetOf(url, init), cookie: cookieOf(init) })
    return jsonResponse({
      code: 200,
      result: {
        songs: [
          { id: 5, name: '晴天', alias: ['Sunny'], artists: [{ name: '周杰伦' }], album: { name: '叶惠美' }, duration: 269000 },
        ],
      },
    })
  }
  try {
    const rows = await searchNetease('晴天')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 5)
    assert.equal(rows[0].artists, '周杰伦')
    assert.equal(rows[0].durationSec, 269)
    assert.equal(rows[0].alias, 'Sunny')
    const direct = seen.find((s) => s.url.includes('music.163.com'))
    assert.ok(direct, '应有直连请求')
    assert.ok(direct.url.includes('/api/search/get/web'))
    assert.ok(!direct.url.includes('weapi'))
    assert.ok(seen.every((s) => s.cookie === undefined), '任何通道都不应带 Cookie')
    assert.ok(seen.some((s) => s.url === APIFOX_PROXY), '默认应同时走 apifox 代理')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('songUrlNetease：从 Meting 返回的 JSON 里取直链', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('server=netease')) {
      return new Response(JSON.stringify({ url: 'https://cdn.example.com/a.mp3' }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error('unexpected ' + u)
  }
  try {
    const r = await songUrlNetease(5)
    assert.equal(r.url, 'https://cdn.example.com/a.mp3')
    assert.equal(r.type, 'mp3')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('cacheKey：平台/参数不同则不同，相同则一致', () => {
  const a = cacheKey({ platform: 'bilibili', key: 'BV1', targetSec: 600, startSec: 0 })
  const b = cacheKey({ platform: 'bilibili', key: 'BV1', targetSec: 600, startSec: 0 })
  const c = cacheKey({ platform: 'netease', key: 'BV1', targetSec: 600, startSec: 0 })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

// ---------------- 工具接线（mock api） ----------------

const OWNER = 1919892171
const OTHER = 30000003
const GROUP = 44444444

function makeEnv(settingsPatch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sx-playmusic-'))
  const sentVoices = []
  const toolBuilders = []
  const rules = []
  const routes = new Map()
  const msgHandlers = []
  const sentTexts = []
  let settings = {}
  const api = {
    id: 'shangxue-playmusic',
    dir,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    config: () => ({}),
    settings: () => settings,
    saveSettings: (p) => {
      settings = { ...settings, ...p }
      return settings
    },
    dataDir: (...parts) => join(dir, ...parts),
    sendVoiceFile: async (chatId, file, note) => {
      sentVoices.push({ chatId, file, note })
      return { message_id: 'v1' }
    },
    sendSegments: async (chatId, segs, note) => {
      const t = (segs || []).filter((s) => s && s.type === 'text').map((s) => s.data?.text || '').join('')
      if (t) sentTexts.push({ chatId, text: t })
      return { message_id: 's1' }
    },
    onebot: async () => ({}),
    isOwner: (uid) => String(uid) === String(OWNER),
    tool: (builder) => {
      toolBuilders.push(builder)
      return () => {}
    },
    defineTool: (spec) => spec,
    rule: (fn) => {
      rules.push(fn)
      return () => {}
    },
    route: (path, handler) => {
      routes.set(path, handler)
      return () => {}
    },
    on: (event, fn) => {
      if (event === 'message') msgHandlers.push(fn)
      return () => {}
    },
    core: { http: { body: async () => ({}) } },
  }
  settings = { ...(mod.defaults || {}) }
  const exported = mod.setup(api)
  settings = { ...settings, ...settingsPatch }
  function toolsFor(chat, level = 'social') {
    const out = []
    for (const b of toolBuilders) {
      const r = b({ chat, level })
      if (Array.isArray(r)) out.push(...r)
      else if (r) out.push(r)
    }
    return out
  }
  const toolNamed = (chat, level, name) => toolsFor(chat, level).find((t) => t.name === name)
  // 模拟一条消息经过所有 message 处理器，返回是否被接管（truthy）
  async function feedMessage(msg) {
    for (const fn of msgHandlers) {
      const claimed = await fn(msg)
      if (claimed) return true
    }
    return false
  }
  return { dir, api, exported, sentVoices, sentTexts, toolsFor, toolNamed, rules, routes, msgHandlers, feedMessage, settings: () => settings }
}

const groupChat = (patch = {}) => ({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, groupId: GROUP, nickname: '小明', ...patch })
const ownerChat = (patch = {}) => ({ kind: 'private', chatId: `private:${OWNER}`, userId: OWNER, groupId: '', nickname: '主人', ...patch })

test('总开关关掉后点歌工具都不给', () => {
  const env = makeEnv({ enabled: false })
  assert.deepEqual(env.toolsFor(groupChat()), [])
})

test('默认能搜能放：两个工具都在（search + sendsong）', () => {
  const env = makeEnv()
  assert.ok(env.toolNamed(groupChat(), 'social', 'shangxue_playmusic_search'))
  assert.ok(env.toolNamed(groupChat(), 'social', 'shangxue_playmusic_sendsong'))
  // 只提供这两个接口
  assert.deepEqual(
    env.toolsFor(groupChat()).map((t) => t.name).sort(),
    ['shangxue_playmusic_search', 'shangxue_playmusic_sendsong'],
  )
})

test('ownerOnly 打开后，非主人看不到工具，主人能', () => {
  const env = makeEnv({ ownerOnly: true })
  assert.equal(env.toolNamed(groupChat(), 'social', 'shangxue_playmusic_search'), undefined)
  assert.ok(env.toolNamed(ownerChat(), 'full', 'shangxue_playmusic_search'))
})

test('search 工具：both 来源返回两张 Markdown 表格（哔哩 + 网易云）', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const target = targetOf(url, init)
    if (target.includes('b_search')) {
      return jsonResponse({
        code: 0,
        data: [{ bvid: 'BV1zzzzzzzzz', video: { title: '多幸运 原唱' }, stat: { duration: '04:12', video: 100 }, owner: { name: 'UP' } }],
      })
    }
    // netease 公开搜索接口
    return jsonResponse({
      code: 200,
      result: {
        songs: [
          { id: 123, name: '多幸运', alias: [], artists: [{ name: '韩雪' }], album: { name: '多幸运' }, duration: 252000, fee: 0 },
        ],
      },
    })
  }
  try {
    const env = makeEnv({ source: 'both' })
    const tool = env.toolNamed(groupChat(), 'social', 'shangxue_playmusic_search')
    const r = await tool.execute({ song: '多幸运' })
    assert.equal(r.ok, true)
    // 哔哩表格：视频名称/UP主/时长/BV号
    assert.match(r.bilibili, /\| # \| 视频名称 \| UP主 \| 时长 \| BV号 \|/)
    assert.match(r.bilibili, /BV1zzzzzzzzz/)
    assert.match(r.bilibili, /4:12/)
    // 网易云表格：歌曲名称/作者/时长/id
    assert.match(r.netease, /\| # \| 歌曲名称 \| 作者 \| 时长 \| id \|/)
    assert.match(r.netease, /韩雪/)
    assert.match(r.netease, /123/)
    // message 里两张表都在
    assert.match(r.message, /【哔哩哔哩】/)
    assert.match(r.message, /【网易云】/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('search 工具：仅哔哩时不搜网易云', async () => {
  const realFetch = globalThis.fetch
  let neteaseHit = false
  globalThis.fetch = async (url, init) => {
    if (targetOf(url, init).includes('music.163.com')) neteaseHit = true
    return jsonResponse({
      code: 0,
      data: [{ bvid: 'BV1zzzzzzzzz', video: { title: '多幸运 原唱' }, stat: { duration: '04:12', video: 100 }, owner: { name: 'UP' } }],
    })
  }
  try {
    const env = makeEnv({ source: 'bilibili' })
    const tool = env.toolNamed(groupChat(), 'social', 'shangxue_playmusic_search')
    const r = await tool.execute({ song: '多幸运' })
    assert.equal(r.ok, true)
    assert.ok(!neteaseHit, '仅哔哩不应请求网易云')
    assert.ok(r.bilibili.includes('BV1zzzzzzzzz'))
    assert.equal(r.netease, '', '仅哔哩时网易云表格为空')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('sendsong 工具：缓存命中直接发语音条，不再下载', async () => {
  const env = makeEnv()
  // 手动往缓存放一个假 mp3
  const key = cacheKey({ platform: 'bilibili', key: 'BV1zzzzzzzzz', targetSec: 600, startSec: 0 })
  const cachePath = env.exported._cache.pathFor(key)
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(join(env.dir, 'playmusic', 'cache'), { recursive: true })
  writeFileSync(cachePath, Buffer.from('fakemp3'))

  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_playmusic_sendsong')
  const r = await tool.execute({ platform: 'bilibili', id: 'BV1zzzzzzzzz', title: '多幸运' })
  assert.equal(r.ok, true)
  assert.equal(r.cached, true)
  assert.equal(env.sentVoices.length, 1, '发了一条语音条')
  assert.equal(env.sentVoices[0].chatId, `group:${GROUP}`)
})

test('sendsong 工具：platform 非法直接报错', async () => {
  const env = makeEnv()
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_playmusic_sendsong')
  const r = await tool.execute({ platform: 'qqmusic', id: 'x' })
  assert.equal(r.ok, false)
})

test('sendsong 工具：整条 B 站链接也能抠出 BV 号', async () => {
  const env = makeEnv()
  const key = cacheKey({ platform: 'bilibili', key: 'BV1zzzzzzzzz', targetSec: 600, startSec: 0 })
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(join(env.dir, 'playmusic', 'cache'), { recursive: true })
  writeFileSync(env.exported._cache.pathFor(key), Buffer.from('fakemp3'))
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_playmusic_sendsong')
  const r = await tool.execute({ platform: 'bilibili', id: 'https://www.bilibili.com/video/BV1zzzzzzzzz?p=1' })
  assert.equal(r.ok, true)
  assert.equal(r.cached, true)
})

test('rule：默认提示词含两个工具名并替换 {{source}} 等变量', () => {
  const env = makeEnv({ source: 'both' })
  const text = env.rules[0]('social')
  assert.match(text, /shangxue_playmusic_search/)
  assert.match(text, /shangxue_playmusic_sendsong/)
  assert.match(text, /哔哩哔哩 \+ 网易云/, '{{source}} 已替换为当前来源')
  assert.ok(!/\{\{/.test(text), '不应残留未替换的 {{变量}}')
})

test('rule：用户自定义提示词里的 {{变量}} 也会被替换', () => {
  const env = makeEnv({
    source: 'netease',
    prompt: '来源={{source}} 搜={{searchTool}} 放={{sendTool}} 每平台={{perLimit}}条',
  })
  const text = env.rules[0]('social')
  assert.equal(text, '来源=仅网易云 搜=shangxue_playmusic_search 放=shangxue_playmusic_sendsong 每平台=5条')
})

test('/status 路由：返回 ffmpeg 探测、来源与分钟换算', async () => {
  const env = makeEnv({ source: 'netease', targetMinutes: 8 })
  const r = await env.routes.get('/status')()
  assert.equal(r.ok, true)
  assert.equal(r.source, 'netease')
  assert.equal(r.targetSec, 480, '8 分钟应换算成 480 秒')
  assert.equal(r.targetMinutes, 8)
  assert.equal(r.proxyMode, 'apifox', '代理留空时默认走 apifox')
  assert.deepEqual(r.proxyChannels, ['direct', 'proxy'])
  assert.ok('ffmpegOk' in r)
})

test('targetMinutes：分钟滑块 4~30 夹取，默认 10（=600 秒）', async () => {
  const env = makeEnv()
  const r = await env.routes.get('/status')()
  assert.equal(r.targetSec, 600, '默认 10 分钟 = 600 秒')
  const low = makeEnv({ targetMinutes: 1 })
  assert.equal((await low.routes.get('/status')()).targetSec, 240, '低于 4 分钟夹到 4 = 240 秒')
  const high = makeEnv({ targetMinutes: 99 })
  assert.equal((await high.routes.get('/status')()).targetSec, 1800, '高于 30 分钟夹到 30 = 1800 秒')
})

test('proxy：填自定义前缀代理时，搜索会同时打直连和该代理两条路', async () => {
  const realFetch = globalThis.fetch
  const hits = []
  globalThis.fetch = async (url) => {
    hits.push(String(url))
    return jsonResponse({
      code: 0,
      data: [{ bvid: 'BV1zzzzzzzzz', video: { title: '多幸运 原唱' }, stat: { duration: '04:12', video: 100 }, owner: { name: 'UP' } }],
    })
  }
  try {
    const env = makeEnv({ source: 'bilibili', proxy: 'https://px.example.com/' })
    const tool = env.toolNamed(groupChat(), 'social', 'shangxue_playmusic_search')
    const r = await tool.execute({ song: '多幸运' })
    assert.equal(r.ok, true)
    assert.ok(hits.some((u) => u.startsWith('https://api.xingzhige.com/')), '应有直连请求')
    assert.ok(hits.some((u) => u.startsWith('https://px.example.com/https://api.xingzhige.com/')), '应有走自定义代理的请求')
    assert.ok(!hits.includes(APIFOX_PROXY), '填了自定义代理就不该再用 apifox')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('proxy：留空时走直连 + 内置 apifox 并行', async () => {
  const realFetch = globalThis.fetch
  const hits = []
  globalThis.fetch = async (url, init) => {
    hits.push({ url: String(url), target: targetOf(url, init) })
    return jsonResponse({
      code: 0,
      data: [{ bvid: 'BV1zzzzzzzzz', video: { title: '多幸运 原唱' }, stat: { duration: '04:12', video: 100 }, owner: { name: 'UP' } }],
    })
  }
  try {
    const env = makeEnv({ source: 'bilibili', proxy: '' })
    const tool = env.toolNamed(groupChat(), 'social', 'shangxue_playmusic_search')
    const r = await tool.execute({ song: '多幸运' })
    assert.equal(r.ok, true)
    assert.ok(
      hits.some((h) => h.url === APIFOX_PROXY && h.target.startsWith('https://api.xingzhige.com/')),
      '应有 apifox 代理请求',
    )
    assert.ok(hits.some((h) => h.url.startsWith('https://api.xingzhige.com/')), '应有直连请求')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('proxy：填 direct 时只走直连，不碰 apifox', async () => {
  const realFetch = globalThis.fetch
  const hits = []
  globalThis.fetch = async (url) => {
    hits.push(String(url))
    return jsonResponse({
      code: 0,
      data: [{ bvid: 'BV1zzzzzzzzz', video: { title: '多幸运 原唱' }, stat: { duration: '04:12', video: 100 }, owner: { name: 'UP' } }],
    })
  }
  try {
    const env = makeEnv({ source: 'bilibili', proxy: 'direct' })
    const tool = env.toolNamed(groupChat(), 'social', 'shangxue_playmusic_search')
    const r = await tool.execute({ song: '多幸运' })
    assert.equal(r.ok, true)
    assert.ok(hits.every((u) => u.startsWith('https://api.xingzhige.com/')), '只应有直连请求')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---------------- 单独的点歌指令 /music ----------------

test('指令：默认 /music 命中缓存时发提示+语音条并接管消息', async () => {
  const env = makeEnv({ source: 'bilibili' })
  // 预置缓存（默认 targetMinutes=10 → 600 秒）
  const key = cacheKey({ platform: 'bilibili', key: 'BV1zzzzzzzzz', targetSec: 600, startSec: 0 })
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(join(env.dir, 'playmusic', 'cache'), { recursive: true })
  writeFileSync(env.exported._cache.pathFor(key), Buffer.from('fakemp3'))
  // 搜索返回一条候选，让指令挑中它
  const realFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 0, data: [{ bvid: 'BV1zzzzzzzzz', video: { title: '多幸运 原唱' }, stat: { duration: '04:12', video: 100 }, owner: { name: 'UP' } }] }))
  try {
    const claimed = await env.feedMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, groupId: GROUP, text: '/music 多幸运' })
    assert.equal(claimed, true, '应接管消息')
    assert.equal(env.sentVoices.length, 1, '发了一条语音条')
    assert.ok(env.sentTexts.some((t) => /去找《多幸运》/.test(t.text)), '应有「去找…稍等」提示')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('指令：/指令名 后面空歌名时只回用法，不搜不下', async () => {
  const env = makeEnv()
  const claimed = await env.feedMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, text: '/music' })
  assert.equal(claimed, true)
  assert.ok(env.sentTexts.some((t) => /点歌用法/.test(t.text)))
  assert.equal(env.sentVoices.length, 0)
})

test('指令：不是 /music 的消息不接管', async () => {
  const env = makeEnv()
  const claimed = await env.feedMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, text: '点歌 多幸运' })
  assert.equal(claimed, false, '不带斜杠的不由指令接管（交给 AI 工具）')
})

test('指令：关掉「注册单独的点歌指令」后不接管', async () => {
  const env = makeEnv({ commandEnabled: false })
  const claimed = await env.feedMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, text: '/music 多幸运' })
  assert.equal(claimed, false)
})

test('指令：自定义指令名生效（/dian 歌名）', async () => {
  const env = makeEnv({ commandName: 'dian' })
  const claimed = await env.feedMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, text: '/dian' })
  assert.equal(claimed, true, '自定义名 /dian 应命中')
  assert.ok(env.sentTexts.some((t) => /点歌用法/.test(t.text)))
})

test('指令：ownerOnly 打开时非主人用 /music 不接管', async () => {
  const env = makeEnv({ ownerOnly: true })
  const claimed = await env.feedMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, text: '/music 多幸运' })
  assert.equal(claimed, false)
})

test('/status 路由：返回指令开关与指令名', async () => {
  const env = makeEnv({ commandEnabled: true, commandName: 'music' })
  const r = await env.routes.get('/status')()
  assert.equal(r.commandEnabled, true)
  assert.equal(r.commandName, 'music')
})

test('默认提示词：只点原唱、含工具名与判断维度', () => {
  const env = makeEnv()
  const text = env.rules[0]('social')
  assert.match(text, /只点原唱/, '应说明只点原唱')
  assert.match(text, /不做翻唱\/变声/, '应说明不做翻唱/变声')
  assert.match(text, /shangxue_playmusic_search/)
  assert.match(text, /shangxue_playmusic_sendsong/)
  assert.match(text, /时长、发布者、标题/, '应含原唱判断维度')
})
